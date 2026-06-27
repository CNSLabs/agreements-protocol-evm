// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.20;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {AgreementTypes} from "./lib/AgreementTypes.sol";
import {ValueLib} from "./lib/ValueLib.sol";
import {ActionLib} from "./lib/ActionLib.sol";
import {IInputVerifier} from "./interfaces/IInputVerifier.sol";
import {IAgreementEngine} from "./interfaces/IAgreementEngine.sol";

// ============================================================================
// CONTRACT
// ============================================================================

/**
 * @title AgreementEngine
 * @notice Single-agreement contract deployed as EIP-1167 clones via AgreementFactory.
 * @dev Each clone instance represents one agreement. The implementation contract
 *      has initializers disabled and cannot be used directly. Events and the
 *      value-typed external surface are declared in IAgreementEngine.
 */
contract AgreementEngine is IAgreementEngine, Initializable, ReentrancyGuard, EIP712 {
    // ========================================================================
    // TYPES & ENUMS
    // ========================================================================

    // FieldType is unified on AgreementTypes.FieldType (the single canonical enum, which
    // appends BYTES = 5 after the legacy ordinals UINT256..BYTES32 = 0..4). The duplicate
    // engine-local enum was removed; DataField/InputFieldDef/getVar now reference the
    // canonical type directly. The wire encoding is unchanged (still a uint8 with identical
    // legacy ordinals), so stored-var values and clone storage layout are unaffected.

    // The engine speaks exactly one condition model (canonical `AgreementTypes.Condition`s,
    // stored in `canonicalConditions`). It no longer ingests, desugars, or evaluates any
    // legacy `Op` encoding — legacy authoring is desugared into canonical conditions OFF-CHAIN
    // by the SDK (§6). The former dead `Op` enum and legacy `Condition` struct (retained only
    // to pin the storage `InputDef.conditions` slot) were removed in the dual-path collapse;
    // their removal shifts `verifierKeys` down a slot, a deliberate, sanctioned re-baseline of
    // the clone storage-layout snapshot (nothing is deployed).

    // ========================================================================
    // STRUCTS
    // ========================================================================

    // The stored-variable record lives in ValueLib (ValueLib.StoredVar): the engine's
    // `vars` store is typed as ValueLib.StoredVar so the eval core reads it directly.

    struct DataField {
        bytes32 id;                     // logical name, e.g. keccak256("name")
        AgreementTypes.FieldType fType; // tells us how to decode `data`
        bytes data;                     // abi.encode(value) of that type
    }

    struct InputFieldDef {
        bytes32 fieldId;   // e.g. keccak256("name"), keccak256("amount")
        AgreementTypes.FieldType fType;
        bool required;
        bool persist;      // if true, store this field's value in vars[fieldId]
    }

    /**
     * @notice An input definition — the same shape in calldata (at init) and in storage (the
     *         `inputDefs` mapping value).
     * @dev Carries no conditions: input conditions are authored canonically and supplied
     *      separately via `CanonicalConditionInit` (the engine ingests only the canonical
     *      condition model; legacy `Op`-encoded authoring is desugared off-chain by the SDK,
     *      §6). Only `id`, `fields`, and `verifierKeys` are author-supplied.
     */
    struct InputDef {
        bytes32 id;
        InputFieldDef[] fields;
        bytes32[] verifierKeys;
    }

    struct Transition {
        bytes32 fromState;
        bytes32 toState;
        bytes32 inputId; // which logical input this transition responds to
    }

    /**
     * @notice Composable action registration payload, keyed by (fromState, inputId).
     * @dev The sole authoring shape for the composable action engine: a sequence of
     *      `ActionLib.Call`s composed at execution time, carried as the ABI-encoded
     *      `ActionLib.Call[]` (`abi.encode(calls)`). The encoding is passed opaquely so the
     *      engine never instantiates the nested-struct ABI coder (it lives in the linked
     *      ActionLib instead, keeping the engine's clone bytecode under the EIP-1167
     *      code-size limit). Legacy static actions are desugared into this shape OFF-CHAIN by
     *      the SDK (a CONST target, the legacy `data` carried as pre-baked constant words, no
     *      substitutions); the engine has a single composable execution path.
     */
    struct ComposableActionInit {
        bytes32 fromState;
        bytes32 inputId;
        bytes encodedCalls; // abi.encode(ActionLib.Call[])
    }

    /**
     * @notice Canonical input-condition authoring payload, keyed by inputId.
     * @dev The sole input-condition authoring path: input conditions / guards on a
     *      `(fromState, inputId)` transition, expressed directly as `AgreementTypes`
     *      `Condition`s over ValueRefs (e.g. a minimum-length check, a sender-equality
     *      check, or branching a follow-up transition on a captured action-output VAR).
     *      Carried as the ABI-encoded `Condition[]` (`abi.encode(conditions)`) and stored in
     *      `canonicalConditions[inputId]`. Legacy `Op`-encoded authoring is desugared into
     *      these canonical conditions OFF-CHAIN by the SDK (§6); the engine ingests only the
     *      canonical form.
     */
    struct CanonicalConditionInit {
        bytes32 inputId;
        bytes encodedConditions; // abi.encode(AgreementTypes.Condition[])
    }

    /**
     * @notice Verifier registration payload, supplied at initialization.
     * @dev Owner-less governance (R8): verifiers are fixed at init, not registered
     *      post-init by a privileged operator. Each entry maps a verifier key
     *      (e.g. keccak256("VC_SECP256K1")) to its verifier contract; stored into
     *      `verifierRegistry` by `_storeVerifiers` on the composable init path.
     */
    struct VerifierReg {
        bytes32 key;
        address verifier;
    }

    // ========================================================================
    // STATE VARIABLES
    // ========================================================================

    // Agreement metadata
    string public docUri;
    bytes32 public docHash;
    bytes32 public initialState;
    bytes32 public currentState;
    /// @notice The agreement owner, set once at initialization.
    /// @dev Owner-less governance (R8): this is a powerless immutable IDENTITY with NO
    ///      privileged powers. Configuration is fixed at initialization; there is no
    ///      privileged-operator role and no post-init reconfiguration path. `owner` is
    ///      never read by any access control or sentinel — the init sentinel is OZ's
    ///      Initializable state (`_getInitializedVersion()`), not `owner`. It remains a
    ///      stored, public identity solely for provenance/observability (and to preserve
    ///      the init ABI + clone storage layout).
    address public owner;

    // Single-agreement storage (no agreementId keys)
    mapping(bytes32 => InputDef) internal inputDefs;
    Transition[] internal transitions;
    mapping(bytes32 => address) public verifierRegistry;
    // Uniform variable store. Typed as ValueLib.StoredVar so the value-resolution
    // core reads it directly; same (FieldType, bytes) shape as the prior engine's
    // store — the leading FieldType ordinals match, so the storage layout is preserved.
    mapping(bytes32 => ValueLib.StoredVar) internal vars;

    // Canonical conditions per inputId. The engine speaks exactly one condition model;
    // runtime evaluation (_validateConditions) reads only this store. Legacy `Op` authoring
    // is desugared into these canonical conditions OFF-CHAIN by the SDK (§6).
    // Written at init in _storeCanonicalConditions via a `canon` storage-pointer alias
    // (canon.push); Slither's uninitialized-state data-flow does not trace that aliased
    // write back to this mapping, so the HIGH finding it raises here is a false positive.
    // slither-disable-next-line uninitialized-state
    mapping(bytes32 => AgreementTypes.Condition[]) internal canonicalConditions;

    // Permit functionality - nonce tracking per signer
    mapping(address => uint256) public nonces;
    
    // EIP-712 typehash for permit
    bytes32 public constant PERMIT_TYPEHASH = keccak256(
        "PermitInput(bytes32 inputId,bytes payload,uint256 nonce,uint256 deadline)"
    );

    // Composable actions (R4), keyed by (fromState, inputId), stored as the ABI-encoded
    // ActionLib.Call[]. APPENDED above the prior max slot (R3 append-only discipline).
    // Storing the encoded calls (rather than a nested storage struct) keeps the engine
    // small and the storage-layout snapshot flat — the only intra-value graph is `bytes`.
    // The sole action store: composable actions are authored directly, and legacy static
    // actions are desugared into this composable shape OFF-CHAIN by the SDK (§9). A
    // zero-length entry means "no action".
    mapping(bytes32 => mapping(bytes32 => bytes)) internal composableActions;

    // ========================================================================
    // ERRORS
    // ========================================================================

    // Condition-evaluation errors live in AgreementTypes and are raised by ValueLib.
    // The prior engine's per-type evaluators (SenderAddressMismatch,
    // SenderAddressNotAllowed, ComparisonFailed(string,string), VarNotSet(bytes32),
    // TypeMismatch(string,string)) were replaced by the value-resolution core, so
    // those declarations no longer live here.
    error NotInitialized();
    error OwnerZero();
    error PermitExpired(uint256 deadline);
    error InvalidSignature();
    // The init-time bounded-evaluation cap error is AgreementTypes.ConfigCapExceeded (shared
    // across the engine, ValueLib, and ActionLib so every cap raises one decodable shape).

    // Events are declared in IAgreementEngine and inherited.

    // ========================================================================
    // CONFIG CAPS (init-time bounded-evaluation hardening, spec §13)
    // ========================================================================

    // These caps bound how much work a submit-time evaluation can be made to do, so a
    // griefing config author cannot author an agreement that gas-bombs a counterparty's
    // submitInput. They are checked AT INIT in the shared validation/storage paths and an
    // over-cap config reverts at creation with `ConfigCapExceeded`. The values are generous
    // for legitimate agreements and bounded against griefing; all are TUNABLE constants.
    //
    // ACTION-component caps (calls/args/constraints/outputs) live in ActionLib (the external
    // library, which has code-size headroom); the condition IN-set and dynamic-value-byte
    // caps live in ValueLib (the shared legality / canonical-encoding gate). The caps below
    // are the engine config-shape caps.

    uint256 internal constant MAX_INPUT_DEFS = 256;
    uint256 internal constant MAX_TRANSITIONS = 256;
    uint256 internal constant MAX_FIELDS_PER_INPUT = 32;
    uint256 internal constant MAX_CONDITIONS_PER_INPUT = 32;
    uint256 internal constant MAX_VERIFIER_KEYS_PER_INPUT = 16;

    // ========================================================================
    // CONSTRUCTOR (Implementation Protection)
    // ========================================================================

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() EIP712("AgreementEngine", "1") {
        _disableInitializers();
    }

    // ========================================================================
    // INITIALIZER
    // ========================================================================

    /**
     * @notice Initialize a clone with its agreement configuration (the sole init entrypoint).
     * @dev Can only be called once per clone (enforced by the `initializer` modifier).
     *      Typically called by `AgreementFactory` right after the clone is deployed. The
     *      engine is composable-only: actions are authored directly as composable
     *      `ActionLib.Call[]` (resolvable target, typed argument-index substitution,
     *      constraints, typed outputs), and input conditions are supplied canonically
     *      (`CanonicalConditionInit`). Legacy `Op`-encoded authoring is desugared into this
     *      shape OFF-CHAIN by the SDK (§6); there is no on-chain legacy init or desugar.
     *
     * @param owner_ Address of the agreement owner (set once at initialization).
     * @param docUri_ Off-chain URI pointing to the agreement document/spec (e.g. IPFS URL).
     * @param docHash_ Content hash of the off-chain spec for integrity verification.
     * @param initialState_ Initial FSM state (also becomes `currentState` on init).
     * @param inputDefs_ Full set of input definitions (no conditions — see `InputDef`).
     * @param transitions_ Full set of valid FSM transitions for this agreement.
     * @param initVars_ Initial on-chain variables to store (e.g., participant addresses, amounts).
     * @param actions_ Composable action definitions, keyed by (fromState, inputId); empty for none.
     * @param canonicalConds_ Canonical input conditions, keyed by inputId; empty for none.
     * @param verifiers_ Verifier registrations fixed at init (owner-less governance, R8).
     */
    function initialize(
        address owner_,
        string calldata docUri_,
        bytes32 docHash_,
        bytes32 initialState_,
        InputDef[] calldata inputDefs_,
        Transition[] calldata transitions_,
        DataField[] calldata initVars_,
        ComposableActionInit[] calldata actions_,
        CanonicalConditionInit[] calldata canonicalConds_,
        VerifierReg[] calldata verifiers_
    ) external initializer {
        _initializeCommon(
            owner_,
            docUri_,
            docHash_,
            initialState_,
            inputDefs_,
            transitions_,
            initVars_
        );
        _storeComposableActions(actions_);
        _storeCanonicalConditions(canonicalConds_);
        // Owner-less governance (R8): verifiers are registered AT INIT (not post-init by a
        // privileged operator).
        _storeVerifiers(verifiers_);

        // Single init pass over the actions: per-call structural validation (validateCall)
        // AND the R7 mandatory taint analysis, decoding each action's Call[] only once. Reject
        // the agreement at creation on a malformed call, or if any call component a submitting
        // party can influence (a tainted target/arg) lacks a bounding constraint over
        // non-tainted operands. Pure + init-only (no runtime cost on submitInput); the heavy
        // nested-struct coder lives in the linked ActionLib.
        _validateActionsTaint(inputDefs_, actions_);
    }

    /**
     * @notice Collect taint seeds + encoded actions and run ActionLib's single init pass
     *         (structural validateCall + R7 taint analysis), decoding each action once.
     * @dev Seeds = every input field declared persist=true (its submitted value is written
     *      into vars[fieldId], so that var is tainted — option B). Output target vars are
     *      derived inside ActionLib from the actions themselves. This runs the SAME
     *      per-call validateCall checks the store pass used to run separately (so a malformed
     *      call still reverts at creation with the same selector) AND the taint analysis;
     *      a missing bound on a tainted target/arg reverts here (UnconstrainedTaintedTarget/
     *      Arg). One nested-struct ABI decode per action instead of two.
     */
    function _validateActionsTaint(
        InputDef[] calldata inputDefs_,
        ComposableActionInit[] calldata actions_
    ) internal pure {
        // Seed tainted-var set: ids of every persisted input field.
        uint256 persistCount;
        for (uint256 i = 0; i < inputDefs_.length; i++) {
            for (uint256 j = 0; j < inputDefs_[i].fields.length; j++) {
                if (inputDefs_[i].fields[j].persist) persistCount++;
            }
        }
        bytes32[] memory persistedFieldIds = new bytes32[](persistCount);
        uint256 p;
        for (uint256 i = 0; i < inputDefs_.length; i++) {
            for (uint256 j = 0; j < inputDefs_[i].fields.length; j++) {
                if (inputDefs_[i].fields[j].persist) {
                    persistedFieldIds[p++] = inputDefs_[i].fields[j].fieldId;
                }
            }
        }

        bytes[] memory encodedActions = new bytes[](actions_.length);
        for (uint256 i = 0; i < actions_.length; i++) {
            encodedActions[i] = actions_[i].encodedCalls;
        }

        ActionLib.validateAndAnalyzeActions(encodedActions, persistedFieldIds);
    }

    function _initializeCommon(
        address owner_,
        string calldata docUri_,
        bytes32 docHash_,
        bytes32 initialState_,
        InputDef[] calldata inputDefs_,
        Transition[] calldata transitions_,
        DataField[] calldata initVars_
    ) internal {
        if (owner_ == address(0)) revert OwnerZero();

        owner = owner_;
        docUri = docUri_;
        docHash = docHash_;
        initialState = initialState_;
        currentState = initialState_;

        _storeInputDefs(inputDefs_);
        _storeTransitions(transitions_);
        _storeInitVars(initVars_);

        emit AgreementInitialized(owner_, docUri_, docHash_, initialState_);
    }

    // ========================================================================
    // PUBLIC/EXTERNAL FUNCTIONS
    // ========================================================================

    // -------- Input Submission / FSM Execution --------

    /**
     * @notice Submit an input to progress the agreement FSM.
     * @param inputId The logical input identifier.
     * @param payload Encoded DataField[] array.
     */
    function submitInput(
        bytes32 inputId,
        bytes calldata payload
    ) external nonReentrant {
        // Owner-less governance (R8): the init sentinel is OZ's Initializable state, not
        // `owner`. A fresh (never-initialized) clone reports version 0; `initialize` (the
        // `initializer` modifier) sets it to 1. For clones this is
        // behavior-equivalent to the prior `owner == address(0)` check (an OwnerZero guard
        // rejects a zero owner at init, so an initialized clone always had a non-zero owner
        // under the old check too) and reverts the same NotInitialized error. The implementation
        // contract has version = max from `_disableInitializers`, so unlike the old `owner == 0`
        // check this does not reject a direct impl call — but the impl is inert (no
        // inputs/transitions), so such a call reverts at `Unknown inputId` regardless.
        if (_getInitializedVersion() == 0) revert NotInitialized();

        InputDef storage def = inputDefs[inputId];
        require(def.id != 0, "Unknown inputId");

        // 1. Decode DataField[]
        DataField[] memory fields = abi.decode(payload, (DataField[]));

        // 2. Structural checks
        _validateFields(def, fields);

        // 3. Persist any fields that have persist = true (before condition validation)
        _persistFields(def, fields);

        // 4. Built-in condition checks (no permit signer, so uses msg.sender)
        _validateConditions(inputId, fields, address(0));

        // 5. External verifiers
        _runVerifiers(def, inputId, payload);

        // 6. FSM transition
        bytes32 from = currentState;
        (bool found, bytes32 to) = _findTransition(from, inputId);
        require(found, "No valid transition");

        // 7. Update state (action reads may expect updated state; revert will roll this back)
        currentState = to;

        // 8. Optional action — runs LAST (after the overlay commits and currentState is
        //    set), atomic with the transition. No permit signer, so AUTH_SIGNER = msg.sender.
        _executeActionIfAny(from, to, inputId, fields, address(0));

        emit InputAccepted(from, to, inputId, payload);
    }

    /**
     * @notice Submit an input using a permit signature, allowing someone else to submit on behalf of the signer.
     * @param signer The address that signed the permit (authorizing this submission)
     * @param inputId The logical input identifier
     * @param payload Encoded DataField[] array
     * @param deadline The timestamp after which the permit is invalid
     * @param v, r, s ECDSA signature components
     * @dev The signer creates an off-chain signature authorizing this specific input submission.
     *      Anyone can submit using this signature, but it must match exactly what was signed.
     */
    function submitInputWithPermit(
        address signer,
        bytes32 inputId,
        bytes calldata payload,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant {
        // Owner-less governance (R8): init sentinel is OZ's Initializable state, not `owner`
        // (see submitInput; for clones, behavior-equivalent to the prior `owner == address(0)`).
        if (_getInitializedVersion() == 0) revert NotInitialized();

        // Check deadline
        if (block.timestamp > deadline) {
            revert PermitExpired(deadline);
        }
        
        // Verify signature
        uint256 currentNonce = nonces[signer];
        bytes32 structHash = keccak256(
            abi.encode(
                PERMIT_TYPEHASH,
                inputId,
                keccak256(payload),
                currentNonce,
                deadline
            )
        );
        bytes32 hash = _hashTypedDataV4(structHash);
        address recoveredSigner = ECDSA.recover(hash, v, r, s);
        
        if (recoveredSigner != signer) {
            revert InvalidSignature();
        }
        
        // Increment nonce to prevent replay
        nonces[signer]++;
        
        // Now process the input as if signer submitted it
        InputDef storage def = inputDefs[inputId];
        require(def.id != 0, "Unknown inputId");
        
        // Decode DataField[]
        DataField[] memory fields = abi.decode(payload, (DataField[]));
        
        // Validate fields
        _validateFields(def, fields);
        
        // Persist fields
        _persistFields(def, fields);
        
        // Validate conditions - when using permit, AUTH_SIGNER resolves to the signer, not msg.sender
        _validateConditions(inputId, fields, signer);
        
        // Run verifiers (they receive msg.sender as the sender parameter)
        _runVerifiers(def, inputId, payload);
        
        // FSM transition
        bytes32 from = currentState;
        (bool found, bytes32 to) = _findTransition(from, inputId);
        require(found, "No valid transition");
        
        // Update state (revert will roll back)
        currentState = to;

        // Optional action — runs LAST, atomic with the transition. Under permit,
        // AUTH_SIGNER resolves to the signer (the authorizing identity).
        _executeActionIfAny(from, to, inputId, fields, signer);

        emit InputAccepted(from, to, inputId, payload);
        emit InputSubmittedWithPermit(signer, msg.sender, inputId);
    }

    // ========================================================================
    // INTERNAL FUNCTIONS - Storage Helpers
    // ========================================================================

    /**
     * @notice Store input definitions in contract storage.
     * @dev Deep copies each calldata `InputDef` (id, fields, verifierKeys — no conditions;
     *      canonical conditions are supplied separately) into the storage `InputDef`.
     */
    function _storeInputDefs(InputDef[] calldata defs) internal {
        // Bounded-evaluation cap: the number of input definitions is bounded at init.
        _capCheck("MAX_INPUT_DEFS", defs.length, MAX_INPUT_DEFS);
        for (uint256 i = 0; i < defs.length; i++) {
            InputDef calldata src = defs[i];
            require(src.id != bytes32(0), "InputDef id zero");

            InputDef storage dst = inputDefs[src.id];
            require(dst.id == bytes32(0), "Duplicate inputId");
            dst.id = src.id;

            // Bounded-evaluation caps: per-input field / verifier-key counts are bounded
            // (a submit re-scans fields for validation/persistence and runs every verifier).
            _capCheck("MAX_FIELDS_PER_INPUT", src.fields.length, MAX_FIELDS_PER_INPUT);
            _capCheck("MAX_VERIFIER_KEYS_PER_INPUT", src.verifierKeys.length, MAX_VERIFIER_KEYS_PER_INPUT);

            // Deep copy fields array
            for (uint256 j = 0; j < src.fields.length; j++) {
                InputFieldDef calldata f = src.fields[j];
                // persist-implies-required: a persisted field's submitted value is auto-written
                // into vars[fieldId] before conditions/actions run, and _persistFields assumes a
                // persisted field is always present (its "we already enforced required = true"
                // comment). Reject persist=true/required=false at init so that invariant holds —
                // otherwise the field could be omitted on a later submission, leaving the var at a
                // stale prior value while a skipIfAbsent guard is skipped and an action still
                // spends VAR(fieldId).
                if (f.persist && !f.required) {
                    revert AgreementTypes.PersistRequiresRequired(src.id, f.fieldId);
                }
                dst.fields.push(f);
            }

            // Deep copy verifierKeys array
            for (uint256 m = 0; m < src.verifierKeys.length; m++) {
                dst.verifierKeys.push(src.verifierKeys[m]);
            }
        }
    }

    /// @dev Revert ConfigCapExceeded if `got` exceeds `max`. `what` is the literal cap name
    ///      (a short string, fits one word). Shared by every init-time bounded-evaluation cap.
    function _capCheck(bytes32 what, uint256 got, uint256 max) internal pure {
        if (got > max) revert AgreementTypes.ConfigCapExceeded(what, got, max);
    }

    /// @dev Whether the input `inputId` declares a field `fieldId` with persist = true (i.e.
    ///      the field's submitted value is auto-written into vars[fieldId] before conditions
    ///      run). Reads the already-stored `inputDefs` (stored before canonical conditions).
    ///      Used by the self-referential-VAR rejection (the §6 named parity deviation), which
    ///      formerly lived in the on-chain desugar and now guards canonical-condition init.
    function _fieldPersists(bytes32 inputId, bytes32 fieldId)
        internal
        view
        returns (bool)
    {
        InputDef storage def = inputDefs[inputId];
        InputFieldDef[] storage fs = def.fields;
        for (uint256 i = 0; i < fs.length; i++) {
            if (fs[i].fieldId == fieldId) return fs[i].persist;
        }
        return false;
    }

    /**
     * @notice Store transitions in contract storage.
     */
    function _storeTransitions(Transition[] calldata trans) internal {
        // Bounded-evaluation cap: the transition count is bounded (a submit linearly
        // scans transitions in _findTransition).
        _capCheck("MAX_TRANSITIONS", trans.length, MAX_TRANSITIONS);
        for (uint256 i = 0; i < trans.length; i++) {
            transitions.push(trans[i]);
        }
    }

    /**
     * @notice Store initial variables in contract storage.
     */
    function _storeInitVars(DataField[] calldata initVars_) internal {
        for (uint256 i = 0; i < initVars_.length; i++) {
            DataField calldata iv = initVars_[i];
            require(iv.id != bytes32(0), "InitVar id zero");

            // Validate the field can be decoded as the claimed type AND, for dynamic
            // (STRING/BYTES) values, store only the canonical encoding (rejecting a value that
            // decodes short while carrying a trailing blob).
            bytes memory canonical = _canonicalFieldData(iv.data, iv.fType);

            // Store in vars mapping (unified AgreementTypes.FieldType — same enum).
            vars[iv.id] = ValueLib.StoredVar({
                fType: iv.fType,
                data: canonical
            });
        }
    }

    /**
     * @notice Store composable actions, keyed by (fromState, inputId), as encoded Call[].
     * @dev Stores the opaque encoding and emits; the per-call structural validation
     *      (ActionLib.validateCall) is no longer run here — it is folded into the single
     *      init pass `_validateActionsTaint` runs (ActionLib.validateAndAnalyzeActions),
     *      which decodes each action ONCE for both validateCall and the R7 taint analysis.
     *      Storing the raw bytes needs no decode, so it stays a thin loop. Called during
     *      initialization; actions are optional.
     */
    function _storeComposableActions(ComposableActionInit[] calldata actions_) internal {
        for (uint256 i = 0; i < actions_.length; i++) {
            ComposableActionInit calldata a = actions_[i];
            composableActions[a.fromState][a.inputId] = a.encodedCalls;
            emit ActionRegistered(a.fromState, a.inputId, address(0), 0, "");
        }
    }

    /**
     * @notice Store canonical input conditions (the sole input-condition authoring path).
     * @dev Decodes each entry's ABI-encoded `Condition[]`, init-legality-validates every
     *      condition (ValueLib.validateLegality), rejects self-referential persisted-field
     *      VAR conditions (the §6 named parity deviation), and appends them to the
     *      `canonicalConditions[inputId]` store. Runtime evaluation (_validateConditions)
     *      reads only this store, so the hot path is unchanged. Legacy `Op` authoring is
     *      desugared into these canonical conditions OFF-CHAIN by the SDK (§6).
     *
     *      The IF_PRESENT (skipIfAbsent) flag is a canonical `Condition` field set by the
     *      author/SDK; it rides through verbatim, so optional-field skip-if-absent parity is
     *      preserved without any on-chain desugar (the SDK marks a condition on an optional
     *      field IF_PRESENT). Runs AFTER _storeInputDefs, so `_fieldPersists` reads the
     *      already-stored field flags.
     */
    function _storeCanonicalConditions(CanonicalConditionInit[] calldata conds_) internal {
        for (uint256 i = 0; i < conds_.length; i++) {
            CanonicalConditionInit calldata cc = conds_[i];
            AgreementTypes.Condition[] memory decoded =
                abi.decode(cc.encodedConditions, (AgreementTypes.Condition[]));
            AgreementTypes.Condition[] storage canon = canonicalConditions[cc.inputId];
            for (uint256 k = 0; k < decoded.length; k++) {
                ValueLib.validateLegality(decoded[k]);
                // §6 named parity deviation: reject a self-referential persisted-field VAR
                // condition — a condition comparing a persisted FIELD against the SAME var
                // that field auto-persists into (a degenerate comparison: persist-before-
                // validate writes the field into that var before the condition runs, so it
                // always compares equal). This check formerly lived in the on-chain desugar;
                // it now guards the canonical-condition init.
                _rejectSelfReferentialPersistedVar(cc.inputId, decoded[k]);
                canon.push(decoded[k]);
            }
            // Bounded-evaluation cap: bound the TOTAL conditions stored for this input (a
            // submit evaluates every one). Checked on the post-append length.
            _capCheck("MAX_CONDITIONS_PER_INPUT", canon.length, MAX_CONDITIONS_PER_INPUT);
        }
    }

    /**
     * @notice Reject a self-referential persisted-field VAR condition (the §6 deviation).
     * @dev Fires whenever a condition's `left` and ANY of its `right` operands BOTH reference
     *      the same auto-persisted (persist = true) field id `id` via the FIELD/VAR pair, with
     *      at least one side being `VAR(id)`. Such a comparison is degenerate: persist-before-
     *      validate writes the submitted FIELD(id) into vars[id] before the condition runs, so
     *      FIELD(id) and VAR(id) resolve to the SAME value — the operand compares the persisted
     *      value against itself. Reverts SelfReferentialVar.
     *
     *      The rejection is SYMMETRIC: it does not matter which side carries the persisted VAR.
     *      Every arrangement is degenerate and rejected —
     *        FIELD(id) <op> VAR(id)   (the original case),
     *        VAR(id)   <op> FIELD(id) (the mirror — formerly NOT caught, the closed gap),
     *        VAR(id)   <op> VAR(id)   (the same persisted var on both sides).
     *      A self-referential operand may sit ANYWHERE among the N right operands (including the
     *      multi-operand IN / NOT_IN set), and EVERY CmpOp is covered. The check requires a VAR
     *      to be involved on at least one side (a persisted var IS the degeneracy); a plain
     *      FIELD(id) <op> FIELD(id) is a different shape and out of scope here. Comparing the
     *      field/its var against a DIFFERENT var, or referencing a non-persisted field, is fine.
     */
    function _rejectSelfReferentialPersistedVar(
        bytes32 inputId,
        AgreementTypes.Condition memory cond
    ) internal view {
        // The left operand must reference a persisted field id, as either FIELD(id) or VAR(id).
        (bool leftSelf, bool leftIsVar, bytes32 id) = _persistedSelfRef(inputId, cond.left);
        if (!leftSelf) return;
        for (uint256 i = 0; i < cond.right.length; i++) {
            (bool rightSelf, bool rightIsVar, bytes32 rightId) =
                _persistedSelfRef(inputId, cond.right[i]);
            // Same persisted id on both sides, with a VAR on at least one side: degenerate.
            if (rightSelf && rightId == id && (leftIsVar || rightIsVar)) {
                revert AgreementTypes.SelfReferentialVar(id);
            }
        }
    }

    /// @dev Classify a ValueRef for the self-reference scan. Returns
    ///      (isPersistedSelfRef, isVar, id): true when `ref` is FIELD(id) or VAR(id) for a
    ///      field that auto-persists (persist = true) on `inputId`; `isVar` distinguishes the
    ///      VAR source from FIELD. Any other source (CONST, FIELD_LENGTH, AUTH_SIGNER, …)
    ///      returns false. FIELD and VAR both encode their id as a single bytes32 (validated
    ///      decodable by ValueLib.validateLegality, which runs first).
    function _persistedSelfRef(bytes32 inputId, AgreementTypes.ValueRef memory ref)
        internal
        view
        returns (bool isPersistedSelfRef, bool isVar, bytes32 id)
    {
        if (
            ref.source != AgreementTypes.ValueSource.FIELD &&
            ref.source != AgreementTypes.ValueSource.VAR
        ) {
            return (false, false, bytes32(0));
        }
        bytes32 refId = abi.decode(ref.data, (bytes32));
        if (!_fieldPersists(inputId, refId)) return (false, false, bytes32(0));
        return (true, ref.source == AgreementTypes.ValueSource.VAR, refId);
    }

    /**
     * @notice Store verifier registrations supplied at initialization.
     * @dev Owner-less governance (R8): the sole writer of `verifierRegistry`. There is no
     *      post-init verifier-registration entrypoint; configuration is fixed at init.
     *      Each entry maps a key to a non-zero verifier contract and emits VerifierRegistered
     *      (event parity with the removed post-init registerVerifier).
     */
    function _storeVerifiers(VerifierReg[] calldata verifiers_) internal {
        for (uint256 i = 0; i < verifiers_.length; i++) {
            VerifierReg calldata v = verifiers_[i];
            require(v.verifier != address(0), "zero verifier");
            verifierRegistry[v.key] = v.verifier;
            emit VerifierRegistered(v.key, v.verifier);
        }
    }

    // ========================================================================
    // INTERNAL FUNCTIONS - Field Persistence
    // ========================================================================

    function _persistFields(
        InputDef storage def,
        DataField[] memory fields
    ) internal {
        for (uint256 i = 0; i < def.fields.length; i++) {
            InputFieldDef storage fd = def.fields[i];
            if (!fd.persist) continue;

            // Find the matching field in this input instance (first match wins).
            (bool found, uint256 j) = _findSubmittedField(fields, fd.fieldId);
            if (found) {
                DataField memory f = fields[j];

                // Type sanity check
                require(f.fType == fd.fType, "Persist field type mismatch");

                // Store/overwrite current value (unified AgreementTypes.FieldType). Persist only
                // the canonical encoding for dynamic (STRING/BYTES) values — _validateFields
                // already rejected a non-canonical submission, and re-encoding here guarantees the
                // var store never holds non-canonical dynamic bytes regardless of the call path.
                ValueLib.StoredVar storage v = vars[fd.fieldId];
                v.fType = f.fType;
                v.data = _canonicalFieldData(f.data, f.fType);
            }
            // If persist = true, we already enforced `required = true` in _validateFields
        }
    }

    /// @dev Index of the first submitted `fields` entry whose id == `fieldId` (first match
    ///      wins; extra/duplicate entries past the first are ignored). Returns (false, 0) if
    ///      no field matches. Shared by validation and persistence so the lookup is one path.
    function _findSubmittedField(DataField[] memory fields, bytes32 fieldId)
        internal
        pure
        returns (bool found, uint256 idx)
    {
        for (uint256 j = 0; j < fields.length; j++) {
            if (fields[j].id == fieldId) {
                return (true, j);
            }
        }
        return (false, 0);
    }

    // ========================================================================
    // INTERNAL FUNCTIONS - Verifier Execution
    // ========================================================================

    /**
     * @notice Run all verifiers registered for this input definition.
     * @dev Safe to have external calls in loop: verifiers are registered by trusted parties,
     *      count is small, and this is a view function so reentrancy is not a concern.
     */
    function _runVerifiers(
        InputDef storage def,
        bytes32 inputId,
        bytes calldata payload
    ) internal view {
        for (uint256 i = 0; i < def.verifierKeys.length; i++) {
            bytes32 key = def.verifierKeys[i];
            address verifier = verifierRegistry[key];
            require(verifier != address(0), "Verifier not registered");

            // slither-disable-next-line calls-loop
            IInputVerifier(verifier).verify(
                address(this),  // Clone address as agreement identifier
                inputId,
                payload,
                msg.sender
            );
        }
    }

    // ========================================================================
    // INTERNAL FUNCTIONS - Validation Helpers
    // ========================================================================

    /**
     * @notice Validate that fields match the input definition structure.
     */
    function _validateFields(
        InputDef storage def,
        DataField[] memory fields
    ) internal view {
        for (uint256 i = 0; i < def.fields.length; i++) {
            InputFieldDef storage fd = def.fields[i];

            // First submitted field matching this declared field wins (extras ignored).
            (bool found, uint256 j) = _findSubmittedField(fields, fd.fieldId);
            if (found) {
                require(fields[j].fType == fd.fType, "Field type mismatch");
                _validateFieldDecoding(fields[j].data, fd.fType);
            }

            if (fd.required) {
                require(found, "Required field missing");
            }
        }
    }

    /**
     * @notice Validate that bytes can be decoded as the specified field type.
     */
    function _validateFieldDecoding(bytes memory data, AgreementTypes.FieldType fType)
        internal
        pure
    {
        if (data.length == 0) {
            revert("Field data is empty");
        }

        if (fType == AgreementTypes.FieldType.UINT256) {
            require(data.length == 32, "Invalid uint256 encoding");
            abi.decode(data, (uint256));
        } else if (fType == AgreementTypes.FieldType.ADDRESS) {
            require(data.length == 32, "Invalid address encoding");
            abi.decode(data, (address));
        } else if (fType == AgreementTypes.FieldType.BOOL) {
            require(data.length == 32, "Invalid bool encoding");
            abi.decode(data, (bool));
        } else if (fType == AgreementTypes.FieldType.BYTES32) {
            require(data.length == 32, "Invalid bytes32 encoding");
            abi.decode(data, (bytes32));
        } else if (
            fType == AgreementTypes.FieldType.STRING ||
            fType == AgreementTypes.FieldType.BYTES
        ) {
            require(data.length >= 64, "Invalid dynamic value encoding");
            // Canonical-encoding discipline for dynamic (STRING/BYTES) values: cap the RAW
            // length pre-decode, cap the DECODED length (the bounded-evaluation cap a submit-time
            // EQ/NEQ keccak256-hashes against), and require `data` is byte-exactly the canonical
            // abi.encode of its decoded value. This rejects a value that decodes to a short
            // string/bytes while carrying a huge trailing blob (which formerly bypassed the
            // decoded-length cap and bloated storage). Same canonical contract ValueLib applies
            // to a dynamic CONST. The store paths persist `ValueLib.canonicalize`'s return so the
            // var store holds exactly one canonical encoding per value.
            ValueLib.canonicalize(fType, data);
        }
    }

    /// @dev Validate `data` as the canonical encoding of `fType` and return the bytes to STORE.
    ///      Dynamic (STRING/BYTES) values are returned re-encoded canonically (byte-identical to
    ///      an already-canonical input); all other types validate-and-pass-through unchanged.
    ///      Shared by the two var write paths (_storeInitVars, _persistFields) so storage never
    ///      holds non-canonical dynamic bytes.
    function _canonicalFieldData(bytes memory data, AgreementTypes.FieldType fType)
        internal
        pure
        returns (bytes memory)
    {
        if (
            fType == AgreementTypes.FieldType.STRING ||
            fType == AgreementTypes.FieldType.BYTES
        ) {
            // A canonical dynamic encoding is always >= 64 bytes (offset + length words); guard
            // first so a too-short payload gets the clean engine error rather than an abi.decode
            // panic. canonicalize then validates (raw cap, decoded cap, canonical equality) AND
            // returns the single canonical encoding to store — so the var store never holds
            // non-canonical dynamic bytes (byte-identical to an already-canonical input).
            require(data.length >= 64, "Invalid dynamic value encoding");
            return ValueLib.canonicalize(fType, data);
        }
        // Fixed-width / word types: validate (length + decodability) and store unchanged.
        _validateFieldDecoding(data, fType);
        return data;
    }

    /**
     * @notice Validate all canonical conditions for this input through ValueLib.
     * @dev Conditions were stored canonically at initialize in `canonicalConditions`; the
     *      engine speaks exactly one condition model, so the hot path reads only this store.
     *
     *      A condition marked IF_PRESENT (skipIfAbsent) is skipped when its target field is
     *      absent — the SDK desugar marks a condition on an optional field IF_PRESENT, giving
     *      full parity with the prior engine's optional-field skip. A condition NOT so marked
     *      is strict: an absent target reverts (ValueLib.resolve -> FieldAbsent).
     *
     * @param authSigner The authorizing identity (permit signer, else msg.sender).
     */
    function _validateConditions(
        bytes32 inputId,
        DataField[] memory fields,
        address authSigner
    ) internal view {
        AgreementTypes.Condition[] storage conds = canonicalConditions[inputId];
        if (conds.length == 0) return;

        ValueLib.EvalContext memory ctx = _buildEvalContext(fields, authSigner);

        // Copy the conditions into memory once so the resolve-once prewarm and the per-condition
        // check both read the same array (and so prewarm can pass them to ValueLib by reference).
        AgreementTypes.Condition[] memory condsMem = conds;

        // Resolve-once on the condition/guard path: pre-read every distinct STATIC_CALL ref
        // reachable across THIS submission's whole condition set (each condition's left + all
        // right operands) into ctx.scCache, ONCE each — the twin of ActionLib's per-call prewarm.
        // Without this, a STATIC_CALL referenced by two conditions is read twice and a non-
        // deterministic/manipulable target could return different words within one submission,
        // flipping which transitions are permitted. ctx is built fresh per submission, so the
        // cache is per-submission isolated.
        ValueLib.prewarmConditions(ctx, condsMem);

        for (uint256 i = 0; i < condsMem.length; i++) {
            ValueLib.check(condsMem[i], ctx, vars);
        }
    }

    /// @notice Build the per-submission evaluation context for ValueLib.
    function _buildEvalContext(
        DataField[] memory fields,
        address authSigner
    ) internal view returns (ValueLib.EvalContext memory ctx) {
        ValueLib.Field[] memory cf = new ValueLib.Field[](fields.length);
        for (uint256 i = 0; i < fields.length; i++) {
            cf[i] = ValueLib.Field({
                id: fields[i].id,
                fType: fields[i].fType,
                data: fields[i].data
            });
        }
        ctx = ValueLib.EvalContext({
            fields: cf,
            authSigner: authSigner == address(0) ? msg.sender : authSigner,
            caller: msg.sender,
            self: address(this),
            timestamp: block.timestamp,
            // Empty on the condition/guard path: a STATIC_CALL there is resolve-once-and-
            // immediately-compare (no check-vs-use split). ActionLib pre-fills its own cache.
            scCache: new ValueLib.StaticCallCacheEntry[](0)
        });
    }

    // ========================================================================
    // INTERNAL FUNCTIONS - FSM Helpers
    // ========================================================================

    /**
     * @notice Find a valid transition from the current state with the given input.
     */
    function _findTransition(
        bytes32 fromState,
        bytes32 inputId
    ) internal view returns (bool, bytes32) {
        uint256 len = transitions.length;
        for (uint256 i = 0; i < len; i++) {
            Transition memory t = transitions[i];
            if (t.fromState == fromState && t.inputId == inputId) {
                return (true, t.toState);
            }
        }
        return (false, bytes32(0));
    }

    /**
     * @dev Execute the composable action (if any) registered for this (fromState,inputId).
     *      Runs LAST in the pipeline — after the variable overlay commits and
     *      `currentState` is set — and is atomic: a failed/constraint-violating call
     *      reverts the whole transition. Resolves target (rejecting address(this)),
     *      asserts constraints, composes calldata by typed argument index, and executes
     *      each call (single call this increment; the loop admits multi-call next).
     *
     * @param fields    The decoded input fields (for FIELD-sourced resolution).
     * @param authSigner The authorizing identity (permit signer, else msg.sender).
     */
    function _executeActionIfAny(
        bytes32 fromState,
        bytes32 toState,
        bytes32 inputId,
        DataField[] memory fields,
        address authSigner
    ) internal {
        bytes storage encoded = composableActions[fromState][inputId];
        if (encoded.length == 0) return; // no action for this transition

        ValueLib.EvalContext memory ctx = _buildEvalContext(fields, authSigner);
        ActionLib.executeEncodedAction(encoded, ctx, vars);

        emit ActionExecuted(fromState, toState, inputId, address(this));
    }

    /**
     * @notice Read-only accessor for a stored variable (parity-harness observability).
     * @dev Additive view getter over existing storage; does not alter engine behavior.
     *      Returns (set, fType, data). `set` is false when the var has never been written.
     */
    function getVar(bytes32 fieldId)
        external
        view
        returns (bool set, AgreementTypes.FieldType fType, bytes memory data)
    {
        ValueLib.StoredVar storage v = vars[fieldId];
        // Unified AgreementTypes.FieldType; the uint8 on the wire is unchanged from the
        // legacy getVar return (legacy ordinals preserved), so it stays parity-comparable.
        return (v.data.length != 0, v.fType, v.data);
    }
}
