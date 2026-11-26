// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

// ============================================================================
// INTERFACES
// ============================================================================

interface IInputVerifier {
    /**
     * @notice Verifier MUST revert if verification fails.
     * @param agreement  Address of the agreement clone contract.
     * @param inputId    Logical input id for this submission.
     * @param payload    Raw bytes passed to submitInput (e.g. abi.encode(DataField[])).
     * @param sender     Effective authorizing actor: msg.sender for a direct
     *                   submission, or the permit signer for a relayed one.
     */
    function verify(
        address agreement,
        bytes32 inputId,
        bytes calldata payload,
        address sender
    ) external view;
}

// ============================================================================
// CONTRACT
// ============================================================================

/**
 * @title AgreementEngine
 * @notice Single-agreement contract deployed as EIP-1167 clones via AgreementFactory.
 * @dev Each clone instance represents one agreement. The implementation contract
 *      has initializers disabled and cannot be used directly.
 */
contract AgreementEngine is Initializable, ReentrancyGuardTransient, EIP712 {
    // ========================================================================
    // TYPES & ENUMS
    // ========================================================================

    enum FieldType {
        UINT256,
        STRING,
        ADDRESS,
        BOOL,
        BYTES32
    }

    enum Op {
        // String operations
        STRING_MIN_LENGTH,
        STRING_MAX_LENGTH,
        STRING_EQ_CONST,
        STRING_EQ_VAR,
        
        // UINT256 operations - compare with constant
        UINT_EQ_CONST,
        UINT_GT_CONST,
        UINT_GTE_CONST,
        UINT_LT_CONST,
        UINT_LTE_CONST,
        
        // UINT256 operations - compare with stored variable
        UINT_EQ_VAR,
        UINT_GT_VAR,
        UINT_GTE_VAR,
        UINT_LT_VAR,
        UINT_LTE_VAR,
        
        // Address operations
        ADDRESS_EQ_CONST,
        ADDRESS_EQ_VAR,
        
        // Sender operations
        SENDER_EQ_VAR_ADDRESS,
        SENDER_IN_ALLOWED_ADDRESSES,

        // UINT256 operations - compare with a stored variable plus or minus a constant.
        // bytesArg = abi.encode(bytes32 targetFieldId, int256 offset). These are
        // separate codes, not a longer argument on the *_VAR codes, so that an
        // engine from before them refuses the agreement at creation instead of
        // reading the comparison without its offset.
        UINT_EQ_VAR_OFFSET,
        UINT_GT_VAR_OFFSET,
        UINT_GTE_VAR_OFFSET,
        UINT_LT_VAR_OFFSET,
        UINT_LTE_VAR_OFFSET
    }

    // ========================================================================
    // STRUCTS
    // ========================================================================

    /// @dev A stored variable, kept in as few slots as its type needs: an
    ///      address or a bool shares a slot with the tag, a uint256 or bytes32
    ///      takes one more, and a string is kept as its bytes.
    struct StoredVar {
        uint8 tag;      // 0 = not set, otherwise FieldType + 1
        address addr;   // ADDRESS value; address(1) for BOOL true
        bytes32 word;   // UINT256 or BYTES32 value
        bytes str;      // STRING value
    }

    struct DataField {
        bytes32 id;       // logical name, e.g. keccak256("name")
        FieldType fType;  // tells us how to decode `data`
        bytes data;       // abi.encode(value) of that type
    }

    struct Condition {
        Op op;
        bytes32 fieldId;   // which DataField.id this condition targets (the field being checked),
                           // or BLOCK_TIME_FIELD to check the block time instead of a submitted field
        bytes bytesArg;    // For CONST ops: constant value encoded. For VAR ops: target fieldId encoded as bytes32
    }

    struct InputFieldDef {
        bytes32 fieldId;   // e.g. keccak256("name"), keccak256("amount")
        FieldType fType;
        bool required;
        bool persist;      // if true, store this field's value in vars[fieldId]
    }

    struct InputDef {
        bytes32 id;
        InputFieldDef[] fields;
        Condition[] conditions;
        bytes32[] verifierKeys;
    }

    /// @dev A condition as kept in storage: the field it checks and its
    ///      argument, when the argument is one or two words. Its operation is a
    ///      byte of the input's `condOps`.
    struct StoredCondition {
        bytes32 fieldId;
        bytes32 arg;
        bytes32 arg2;
    }

    /// @dev An input definition as kept in storage. `condOps` holds one byte per
    ///      condition: the Op in the low six bits and, in the top two, where the
    ///      argument is (ARG_* below). Most arguments are one word, so a condition
    ///      takes two slots where the calldata form would take four.
    struct StoredInputDef {
        bytes32 id;
        // One byte per field: its FieldType in the low three bits, then
        // FIELD_REQUIRED and FIELD_PERSIST. The field ids are in `fieldIds`.
        bytes fieldFlags;
        mapping(uint256 => bytes32) fieldIds;
        bytes32[] verifierKeys;
        bytes condOps;
        mapping(uint256 => StoredCondition) conds;
        mapping(uint256 => bytes) condLongArgs;
    }

    uint8 private constant FIELD_TYPE_MASK = 0x07;
    uint8 private constant FIELD_REQUIRED = 0x08;
    uint8 private constant FIELD_PERSIST = 0x10;

    uint8 private constant OP_MASK = 0x3f;
    uint8 private constant ARG_KIND_MASK = 0xc0;
    uint8 private constant ARG_ONE_WORD = 0x00;   // `arg`
    uint8 private constant ARG_TWO_WORDS = 0x40;  // `arg` then `arg2`
    uint8 private constant ARG_BYTES = 0x80;      // `condLongArgs`
    uint8 private constant ARG_EMPTY = 0xc0;      // no argument

    struct VerifierInit {
        bytes32 key;
        address verifier;
    }

    struct Transition {
        bytes32 fromState;
        bytes32 toState;
        bytes32 inputId; // which logical input this transition responds to
    }

    /**
     * @notice Optional action executed atomically as part of an input-driven transition.
     * @dev If the action call fails, the entire submitInput reverts and the transition is not applied.
     *
     * `target.call(data)` is executed by this AgreementEngine clone (so msg.sender to `target` is the agreement).
     * The target must have code when the transition runs. No ETH is forwarded: the
     * engine cannot hold ETH, so `value` must be zero and creation reverts otherwise.
     */
    struct Action {
        address target;
        bool exists;   // shares the slot of `target`
        bytes data;
    }

    /**
     * @notice Action registration payload used at initialization time.
     * @dev This is a calldata-friendly representation of Action keyed by (fromState,inputId).
     */
    struct ActionInit {
        bytes32 fromState;
        bytes32 inputId;
        address target;
        uint256 value;
        bytes data;
    }

    // ========================================================================
    // STATE VARIABLES
    // ========================================================================

    // Agreement metadata
    string public docUri;
    bytes32 public docHash;
    bytes32 public initialState;
    bytes32 public currentState;
    address public owner;
    // Whether any action or any verifier was registered. They share the slot of
    // `owner`, which every submission reads first, so an agreement without
    // actions or verifiers does not pay to look for them.
    bool internal hasActions;
    bool internal hasVerifiers;

    // Single-agreement storage (no agreementId keys)
    mapping(bytes32 => StoredInputDef) internal inputDefs;
    // Transitions, looked up by (fromState, inputId). The first transition
    // registered for a pair is the one that applies, as when they were a list
    // searched in order. A target state of zero cannot be told from an empty
    // slot, so that rare case is recorded in `transitionToZero`.
    mapping(bytes32 => mapping(bytes32 => bytes32)) internal transitionTo;
    mapping(bytes32 => mapping(bytes32 => bool)) internal transitionToZero;
    mapping(bytes32 => address) public verifierRegistry;
    mapping(bytes32 => StoredVar) internal vars;

    // Optional per-transition actions, keyed by (fromState,inputId)
    mapping(bytes32 => mapping(bytes32 => Action)) internal actions;
    
    // Permit functionality - nonce tracking per signer. Each accepted input
    // consumes the current nonce of the account that authorized it: the signer of
    // a permit, or the caller of `submitInput`. A permit is therefore single-use,
    // a signer has at most one live permit on this agreement at a time, and an
    // input the signer submits directly retires the permit it had outstanding.
    // A signer withdraws an unsubmitted permit with `cancelPermits`.
    mapping(address => uint256) public nonces;
    
    // Reserved field id for time conditions. A condition whose `fieldId` is this
    // value compares the block time (`block.timestamp`, in seconds) where it
    // would otherwise compare a submitted field. Any of the UINT comparisons
    // applies, against a constant or a stored UINT256 variable, for example
    // UINT_GTE_VAR for "not before the stored date" and UINT_LT_CONST for
    // "before a fixed moment". The time is read when the input is submitted,
    // for a direct input and for a permit alike, so a permit signed inside a
    // time window is refused once the window has closed. No input field and no
    // stored variable may use this id.
    bytes32 internal constant BLOCK_TIME_FIELD = keccak256("block.timestamp");

    // EIP-712 typehash for permit. The signer binds its own address, so a
    // signature validated by a smart account cannot be presented for another
    // account that accepts the same key.
    bytes32 public constant PERMIT_TYPEHASH = keccak256(
        "PermitInput(address signer,bytes32 inputId,bytes payload,uint256 nonce,uint256 deadline)"
    );

    // ========================================================================
    // ERRORS
    // ========================================================================

    error SenderAddressMismatch(address sender, address expected);
    error SenderAddressNotAllowed(address sender);
    error ComparisonFailed(string op, string fieldType);
    error ReservedFieldId(bytes32 fieldId);
    error OffsetOutOfRange(bytes32 fieldId, uint256 stored, int256 offset);
    error VarNotSet(bytes32 fieldId);
    error TypeMismatch(string expected, string actual);
    error NotInitialized();
    error OwnerZero();
    error PermitExpired(uint256 deadline);
    error InvalidSignature();
    error InvalidNonce(address signer, uint256 provided, uint256 expected);
    error ActionTargetZero();
    error ActionValueNotSupported(bytes32 fromState, bytes32 inputId, uint256 value);
    error ActionCallFailed(address target, bytes revertData);
    error ActionTargetHasNoCode(address target);
    error ActionERC20ReturnInvalid(address target, bytes returnData);
    error VerifierZero();
    error DuplicateVerifier(bytes32 key);
    error UnknownVerifier(bytes32 key);

    // ========================================================================
    // EVENTS
    // ========================================================================

    event VerifierRegistered(bytes32 indexed key, address indexed verifier);
    event AgreementInitialized(
        address indexed owner,
        string docUri,
        bytes32 docHash,
        bytes32 initialState
    );
    event InputAccepted(
        bytes32 indexed fromState,
        bytes32 indexed toState,
        bytes32 inputId,
        bytes payload
    );
    event InputSubmittedWithPermit(
        address indexed signer,
        address indexed submitter,
        bytes32 indexed inputId
    );
    /// @notice Emitted when a signer cancels the input permit it had outstanding.
    /// @param signer The account whose permit nonce was consumed
    /// @param newNonce The signer's permit nonce after the call
    event PermitsCancelled(address indexed signer, uint256 newNonce);
    event ActionRegistered(
        bytes32 indexed fromState,
        bytes32 indexed inputId,
        address indexed target,
        uint256 value,
        bytes data
    );
    event ActionExecuted(
        bytes32 indexed fromState,
        bytes32 indexed toState,
        bytes32 indexed inputId,
        address target
    );

    // ========================================================================
    // CONSTRUCTOR (Implementation Protection)
    // ========================================================================

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() EIP712("AgreementEngine", "1") {
        // The Op of a condition is stored in six bits.
        assert(uint8(type(Op).max) <= OP_MASK);
        // The FieldType of an input field is stored in three bits.
        assert(uint8(type(FieldType).max) <= FIELD_TYPE_MASK);
        _disableInitializers();
    }

    // ========================================================================
    // INITIALIZER
    // ========================================================================

    /**
     * @notice Initialize a clone with agreement data and pre-registered verifiers/actions.
     * @dev Can only be called once per clone (enforced by initializer modifier).
     *      Typically called by `AgreementFactory` right after the clone is deployed.
     *
     * @param owner_ Address of the agreement owner (set once at initialization).
     * @param docUri_ Off-chain URI pointing to the agreement document/spec (e.g. IPFS URL).
     * @param docHash_ Content hash of the off-chain spec for integrity verification.
     * @param initialState_ Initial FSM state (also becomes `currentState` on init).
     * @param inputDefs_ Full set of input definitions accepted by this agreement.
     * @param transitions_ Full set of valid FSM transitions for this agreement.
     * @param initVars_ Initial on-chain variables to store (e.g., participant addresses, amounts).
     * @param verifiers_ Optional verifier registrations to install at initialization time.
     * @param actions_ Optional per-transition actions to pre-register; pass an empty array for none.
     */
    function initialize(
        address owner_,
        string calldata docUri_,
        bytes32 docHash_,
        bytes32 initialState_,
        InputDef[] calldata inputDefs_,
        Transition[] calldata transitions_,
        DataField[] calldata initVars_,
        VerifierInit[] calldata verifiers_,
        ActionInit[] calldata actions_
    ) external initializer {
        if (owner_ == address(0)) revert OwnerZero();

        owner = owner_;
        docUri = docUri_;
        docHash = docHash_;
        initialState = initialState_;
        currentState = initialState_;

        _storeVerifiers(verifiers_);
        _storeInputDefs(inputDefs_);
        _storeTransitions(transitions_);
        _storeInitVars(initVars_);
        _storeActions(actions_);

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
     * @dev An accepted input consumes the caller's permit nonce, as an accepted
     *      permit does for its signer. An input permit the caller signed earlier
     *      and that was not submitted stops verifying, so it cannot be presented
     *      later, when the agreement accepts that input again. Only the caller's
     *      nonce moves: permits signed by other parties stay valid. A reverted
     *      call consumes nothing.
     */
    function submitInput(
        bytes32 inputId,
        bytes calldata payload
    ) external nonReentrant {
        if (owner == address(0)) revert NotInitialized();

        StoredInputDef storage def = inputDefs[inputId];
        require(def.id != 0, "Unknown inputId");

        // 1. Decode DataField[]
        DataField[] memory fields = abi.decode(payload, (DataField[]));

        // 2. Structural checks
        _validateFields(def, fields);

        // 3. Authorize against the pre-submission state.
        _validateConditions(def, fields, address(0));

        // 4. External verifiers receive the effective authorizing actor.
        _runVerifiers(def, inputId, payload, msg.sender);

        // 5. Resolve the transition before writing submission data.
        bytes32 from = currentState;
        (bool found, bytes32 to) = _findTransition(from, inputId);
        require(found, "No valid transition");

        // 6. Retire the caller's outstanding permit (revert will roll this back).
        nonces[msg.sender]++;

        // 7. Persist only after every authorization check has succeeded.
        _persistFields(def, fields);

        // 8. Update state (action reads may expect updated state; revert will roll this back).
        currentState = to;

        // 9. Optional action (atomic with transition)
        _executeActionIfAny(from, to, inputId);

        emit InputAccepted(from, to, inputId, payload);
    }
    
    /**
     * @notice Submit an input using a permit signature, allowing someone else to submit on behalf of the signer.
     * @param signer The address that signed the permit (authorizing this submission)
     * @param inputId The logical input identifier
     * @param payload Encoded DataField[] array
     * @param deadline The timestamp after which the permit is invalid
     * @param signature Opaque EOA or ERC-1271 signature bytes
     * @dev The signer creates an off-chain signature authorizing this specific input submission.
     *      Anyone can submit using this signature, but it must match exactly what was signed.
     *      The signature covers the signer's address, the input, its payload, the signer's
     *      nonce on this agreement and the deadline. It does not name a state: the permit
     *      stays usable until its deadline, in any state that accepts the input, until it
     *      or another permit of the same signer is accepted, the signer has an input
     *      accepted through `submitInput`, or the signer withdraws it with
     *      `cancelPermits`. Another party's input does not affect it. Several parties can
     *      therefore sign up front and have their permits submitted in whatever order the
     *      agreement's transitions allow. A payload should restate what the signer approves
     *      (a document hash, an amount) rather than rely on values stored by earlier inputs.
     */
    function submitInputWithPermit(
        address signer,
        bytes32 inputId,
        bytes calldata payload,
        uint256 deadline,
        bytes calldata signature
    ) external nonReentrant {
        if (owner == address(0)) revert NotInitialized();
        
        // Check deadline
        if (block.timestamp > deadline) {
            revert PermitExpired(deadline);
        }
        
        // Verify signature
        uint256 currentNonce = nonces[signer];
        bytes32 structHash = keccak256(
            abi.encode(
                PERMIT_TYPEHASH,
                signer,
                inputId,
                keccak256(payload),
                currentNonce,
                deadline
            )
        );
        bytes32 hash = _hashTypedDataV4(structHash);
        if (!SignatureChecker.isValidSignatureNow(signer, hash, signature)) {
            revert InvalidSignature();
        }
        
        // Increment nonce to prevent replay
        nonces[signer]++;
        
        // Now process the input as if signer submitted it
        StoredInputDef storage def = inputDefs[inputId];
        require(def.id != 0, "Unknown inputId");
        
        // Decode DataField[]
        DataField[] memory fields = abi.decode(payload, (DataField[]));
        
        // Validate fields
        _validateFields(def, fields);
        
        // Authorize against the pre-submission state. For permits, sender
        // conditions check the signer rather than the relayer.
        _validateConditions(def, fields, signer);
        
        // Verifiers must see the same effective actor as built-in conditions.
        _runVerifiers(def, inputId, payload, signer);
        
        // FSM transition
        bytes32 from = currentState;
        (bool found, bytes32 to) = _findTransition(from, inputId);
        require(found, "No valid transition");

        // Persist only after every authorization check has succeeded.
        _persistFields(def, fields);
        
        // Update state (revert will roll back)
        currentState = to;

        // Optional action (atomic with transition)
        _executeActionIfAny(from, to, inputId);
        
        emit InputAccepted(from, to, inputId, payload);
        emit InputSubmittedWithPermit(signer, msg.sender, inputId);
    }

    /**
     * @notice Cancel the input permit the caller has signed for this agreement
     *         and that has not been submitted yet.
     * @dev Consumes the caller's current permit nonce. A permit carries the nonce
     *      that was current when it was signed, so every unsubmitted permit of the
     *      caller that names the consumed nonce stops verifying (`InvalidSignature`).
     *      The next permit must be signed with the returned nonce.
     *
     *      Scope: the caller only, on this agreement only. Each agreement is its own
     *      clone with its own nonces, so other signers and other agreements are
     *      untouched. There is no signed path: a smart account (ERC-1271) cancels by
     *      calling this from the account itself. Cancelling does not stop the caller
     *      from submitting directly: `submitInput` checks no nonce, and consumes the
     *      caller's nonce when its input is accepted.
     *
     *      One call consumes one nonce. A signer that deliberately signed permits
     *      for later nonces calls once for each.
     * @return newNonce The caller's permit nonce after the call
     */
    function cancelPermits() external returns (uint256 newNonce) {
        if (owner == address(0)) revert NotInitialized();
        newNonce = ++nonces[msg.sender];
        emit PermitsCancelled(msg.sender, newNonce);
    }

    // ========================================================================
    // INTERNAL FUNCTIONS - Storage Helpers
    // ========================================================================

    /**
     * @notice Store verifier registrations in contract storage.
     * @dev Called during initialization; verifiers are optional (pass empty array).
     */
    function _storeVerifiers(VerifierInit[] calldata verifiers_) internal {
        if (verifiers_.length != 0) hasVerifiers = true;
        for (uint256 i = 0; i < verifiers_.length; i++) {
            VerifierInit calldata verifierInit = verifiers_[i];
            if (verifierInit.verifier == address(0)) revert VerifierZero();
            if (verifierRegistry[verifierInit.key] != address(0)) revert DuplicateVerifier(verifierInit.key);

            verifierRegistry[verifierInit.key] = verifierInit.verifier;
            emit VerifierRegistered(verifierInit.key, verifierInit.verifier);
        }
    }

    /**
     * @notice Store input definitions in contract storage.
     * @dev Deep copies calldata structs to avoid stack-too-deep issues.
     */
    function _storeInputDefs(InputDef[] calldata defs) internal {
        for (uint256 i = 0; i < defs.length; i++) {
            InputDef calldata src = defs[i];
            require(src.id != bytes32(0), "InputDef id zero");

            StoredInputDef storage dst = inputDefs[src.id];
            require(dst.id == bytes32(0), "Duplicate inputId");
            // Written through the mapping, not through `dst`, so that static
            // analysis sees `inputDefs` being assigned.
            inputDefs[src.id].id = src.id;

            // Copy the fields in their packed form
            uint256 fieldCount = src.fields.length;
            if (fieldCount != 0) {
                bytes memory flags = new bytes(fieldCount);
                for (uint256 j = 0; j < fieldCount; j++) {
                    InputFieldDef calldata field = src.fields[j];
                    // A condition on this id reads the block time, never a submitted field.
                    if (field.fieldId == BLOCK_TIME_FIELD) revert ReservedFieldId(BLOCK_TIME_FIELD);
                    dst.fieldIds[j] = field.fieldId;
                    flags[j] = bytes1(
                        uint8(field.fType) |
                        (field.required ? FIELD_REQUIRED : 0) |
                        (field.persist ? FIELD_PERSIST : 0)
                    );
                }
                dst.fieldFlags = flags;
            }

            _storeConditions(dst, src.conditions);

            // Deep copy verifierKeys array
            for (uint256 m = 0; m < src.verifierKeys.length; m++) {
                bytes32 key = src.verifierKeys[m];
                if (verifierRegistry[key] == address(0)) revert UnknownVerifier(key);
                dst.verifierKeys.push(key);
            }
        }
    }

    /**
     * @notice Store an input's conditions in their packed form.
     */
    function _storeConditions(StoredInputDef storage dst, Condition[] calldata conditions) internal {
        uint256 count = conditions.length;
        if (count == 0) return;

        bytes memory ops = new bytes(count);
        for (uint256 k = 0; k < count; k++) {
            Condition calldata c = conditions[k];
            StoredCondition storage sc = dst.conds[k];
            sc.fieldId = c.fieldId;

            uint256 argLength = c.bytesArg.length;
            uint8 kind;
            if (argLength == 32) {
                sc.arg = bytes32(c.bytesArg);
                kind = ARG_ONE_WORD;
            } else if (argLength == 64) {
                sc.arg = bytes32(c.bytesArg[:32]);
                sc.arg2 = bytes32(c.bytesArg[32:]);
                kind = ARG_TWO_WORDS;
            } else if (argLength == 0) {
                kind = ARG_EMPTY;
            } else {
                dst.condLongArgs[k] = c.bytesArg;
                kind = ARG_BYTES;
            }
            ops[k] = bytes1(uint8(c.op) | kind);
        }
        dst.condOps = ops;
    }

    /**
     * @notice Read condition `index` of an input back into the form it was given in.
     */
    function _loadCondition(
        StoredInputDef storage def,
        uint256 index,
        uint8 packedOp
    ) internal view returns (Condition memory c) {
        StoredCondition storage sc = def.conds[index];
        c.op = Op(packedOp & OP_MASK);
        c.fieldId = sc.fieldId;

        uint8 kind = packedOp & ARG_KIND_MASK;
        if (kind == ARG_ONE_WORD) {
            c.bytesArg = abi.encode(sc.arg);
        } else if (kind == ARG_TWO_WORDS) {
            c.bytesArg = abi.encode(sc.arg, sc.arg2);
        } else if (kind == ARG_BYTES) {
            c.bytesArg = def.condLongArgs[index];
        }
    }

    /**
     * @notice Store transitions in contract storage.
     */
    function _storeTransitions(Transition[] calldata trans) internal {
        for (uint256 i = 0; i < trans.length; i++) {
            Transition calldata t = trans[i];
            if (transitionTo[t.fromState][t.inputId] != bytes32(0) || transitionToZero[t.fromState][t.inputId]) {
                continue; // an earlier transition for this pair takes precedence
            }
            if (t.toState == bytes32(0)) {
                transitionToZero[t.fromState][t.inputId] = true;
            } else {
                transitionTo[t.fromState][t.inputId] = t.toState;
            }
        }
    }

    /**
     * @notice Store initial variables in contract storage.
     */
    function _storeInitVars(DataField[] calldata initVars_) internal {
        for (uint256 i = 0; i < initVars_.length; i++) {
            DataField calldata iv = initVars_[i];
            require(iv.id != bytes32(0), "InitVar id zero");
            if (iv.id == BLOCK_TIME_FIELD) revert ReservedFieldId(BLOCK_TIME_FIELD);

            // Validate the field can be decoded as the claimed type
            _validateFieldDecoding(iv.data, iv.fType);

            _writeVar(iv.id, iv.fType, iv.data);
        }
    }

    /**
     * @notice Store actions in contract storage (keyed by fromState + inputId).
     * @dev Called during initialization; actions are optional (pass empty array).
     */
    function _storeActions(ActionInit[] calldata actions_) internal {
        if (actions_.length != 0) hasActions = true;
        for (uint256 i = 0; i < actions_.length; i++) {
            ActionInit calldata a = actions_[i];
            if (a.target == address(0)) revert ActionTargetZero();
            // The engine cannot hold ETH, so an action that forwards value could
            // never execute and would block its transition for good.
            if (a.value != 0) revert ActionValueNotSupported(a.fromState, a.inputId, a.value);
            actions[a.fromState][a.inputId] = Action({
                target: a.target,
                exists: true,
                data: a.data
            });
            emit ActionRegistered(a.fromState, a.inputId, a.target, a.value, a.data);
        }
    }

    // ========================================================================
    // INTERNAL FUNCTIONS - Field Persistence
    // ========================================================================

    function _persistFields(
        StoredInputDef storage def,
        DataField[] memory fields
    ) internal {
        bytes memory flags = def.fieldFlags;
        for (uint256 i = 0; i < flags.length; i++) {
            uint8 flag = uint8(flags[i]);
            if (flag & FIELD_PERSIST == 0) continue;
            bytes32 fieldId = def.fieldIds[i];

            // Find the matching field in this input instance
            for (uint256 j = 0; j < fields.length; j++) {
                if (fields[j].id == fieldId) {
                    DataField memory f = fields[j];

                    // Type sanity check
                    require(uint8(f.fType) == flag & FIELD_TYPE_MASK, "Persist field type mismatch");

                    // Store/overwrite current value
                    _writeVar(fieldId, f.fType, f.data);
                    break;
                }
            }
        }
    }

    /**
     * @notice Store a value under `id`. `data` is abi.encode(value) and has
     *         already been checked to decode as `fType`.
     */
    function _writeVar(bytes32 id, FieldType fType, bytes memory data) internal {
        // Written through the mapping, not through `v`, so that static
        // analysis sees `vars` being assigned.
        vars[id].tag = uint8(fType) + 1;
        StoredVar storage v = vars[id];
        if (fType == FieldType.ADDRESS) {
            v.addr = abi.decode(data, (address));
        } else if (fType == FieldType.BOOL) {
            v.addr = abi.decode(data, (bool)) ? address(1) : address(0);
        } else if (fType == FieldType.STRING) {
            v.str = bytes(abi.decode(data, (string)));
        } else {
            v.word = abi.decode(data, (bytes32));
        }
    }

    /// @dev The stored variable `id`, which must be set and of type `expected`.
    function _readVar(bytes32 id, FieldType expected) internal view returns (StoredVar storage v) {
        v = vars[id];
        uint8 tag = v.tag;
        if (tag == 0) revert VarNotSet(id);
        if (tag != uint8(expected) + 1) {
            revert TypeMismatch(_fieldTypeToString(expected), _fieldTypeToString(FieldType(tag - 1)));
        }
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
        StoredInputDef storage def,
        bytes32 inputId,
        bytes calldata payload,
        address effectiveSender
    ) internal view {
        // An input can only name a verifier that was registered at creation.
        if (!hasVerifiers) return;
        uint256 count = def.verifierKeys.length;
        for (uint256 i = 0; i < count; i++) {
            bytes32 key = def.verifierKeys[i];
            address verifier = verifierRegistry[key];
            require(verifier != address(0), "Verifier not registered");

            // slither-disable-next-line calls-loop
            IInputVerifier(verifier).verify(
                address(this),  // Clone address as agreement identifier
                inputId,
                payload,
                effectiveSender
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
        StoredInputDef storage def,
        DataField[] memory fields
    ) internal view {
        bytes memory flags = def.fieldFlags;
        for (uint256 i = 0; i < flags.length; i++) {
            uint8 flag = uint8(flags[i]);
            bytes32 fieldId = def.fieldIds[i];
            FieldType fType = FieldType(flag & FIELD_TYPE_MASK);
            bool found = false;

            for (uint256 j = 0; j < fields.length; j++) {
                if (fields[j].id == fieldId) {
                    found = true;
                    require(fields[j].fType == fType, "Field type mismatch");
                    _validateFieldDecoding(fields[j].data, fType);
                    break;
                }
            }

            if (flag & FIELD_REQUIRED != 0) {
                require(found, "Required field missing");
            }
        }
    }

    /**
     * @notice Validate that bytes can be decoded as the specified field type.
     */
    function _validateFieldDecoding(bytes memory data, FieldType fType) internal pure {
        if (data.length == 0) {
            revert("Field data is empty");
        }

        if (fType == FieldType.UINT256) {
            require(data.length == 32, "Invalid uint256 encoding");
            abi.decode(data, (uint256));
        } else if (fType == FieldType.ADDRESS) {
            require(data.length == 32, "Invalid address encoding");
            abi.decode(data, (address));
        } else if (fType == FieldType.BOOL) {
            require(data.length == 32, "Invalid bool encoding");
            abi.decode(data, (bool));
        } else if (fType == FieldType.BYTES32) {
            require(data.length == 32, "Invalid bytes32 encoding");
            abi.decode(data, (bytes32));
        } else if (fType == FieldType.STRING) {
            require(data.length >= 64, "Invalid string encoding");
            abi.decode(data, (string));
        }
    }

    /**
     * @notice Validate all conditions defined for this input.
     * @dev A condition is a sender check, a time check (`fieldId` is
     *      BLOCK_TIME_FIELD) or a check on a submitted field.
     * @param permitSigner If non-zero, SENDER_EQ_VAR_ADDRESS conditions check this address instead of msg.sender
     */
    function _validateConditions(
        StoredInputDef storage def,
        DataField[] memory fields,
        address permitSigner
    ) internal view {
        bytes memory ops = def.condOps;
        for (uint256 i = 0; i < ops.length; i++) {
            Condition memory c = _loadCondition(def, i, uint8(ops[i]));
            if (c.op == Op.SENDER_EQ_VAR_ADDRESS) {
                _evalSenderCondition(c, permitSigner);
                continue;
            }
            if (c.op == Op.SENDER_IN_ALLOWED_ADDRESSES) {
                _evalAllowedSenderCondition(c, permitSigner);
                continue;
            }

            if (c.fieldId == BLOCK_TIME_FIELD) {
                // A time condition: the block time stands in for a submitted
                // UINT256 field and goes through the same comparisons.
                _evalCondition(
                    c,
                    DataField({id: BLOCK_TIME_FIELD, fType: FieldType.UINT256, data: abi.encode(block.timestamp)})
                );
                continue;
            }

            (bool found, DataField memory f) = _tryFindField(fields, c.fieldId);
            if (!found) {
                // Optional fields may be omitted entirely. In that case, skip any
                // field-local validation conditions tied to the missing field.
                if (_isOptionalField(def, c.fieldId)) {
                    continue;
                }
                revert("Condition field not found in input data");
            }

            _evalCondition(c, f);
        }
    }

    /**
     * @notice Evaluate a single condition against the provided fields.
     */
    function _evalCondition(
        Condition memory c,
        DataField memory f
    ) internal view {
        // Route to appropriate handler based on operation type
        if (
            c.op == Op.STRING_MIN_LENGTH ||
            c.op == Op.STRING_MAX_LENGTH ||
            c.op == Op.STRING_EQ_CONST ||
            c.op == Op.STRING_EQ_VAR
        ) {
            _evalStringCondition(c, f);
        } else if ((c.op >= Op.UINT_EQ_CONST && c.op <= Op.UINT_LTE_VAR) || c.op >= Op.UINT_EQ_VAR_OFFSET) {
            _evalUintCondition(c, f);
        } else if (c.op == Op.ADDRESS_EQ_CONST || c.op == Op.ADDRESS_EQ_VAR) {
            _evalAddressCondition(c, f);
        } else {
            revert("Unknown operation");
        }
    }

    /**
     * @notice Find a field by ID in the fields array.
     */
    function _tryFindField(
        DataField[] memory fields,
        bytes32 fieldId
    ) internal pure returns (bool, DataField memory) {
        for (uint256 i = 0; i < fields.length; i++) {
            if (fields[i].id == fieldId) {
                return (true, fields[i]);
            }
        }
        return (false, DataField({id: bytes32(0), fType: FieldType.UINT256, data: ""}));
    }

    /**
     * @notice Check whether an input field is declared and optional.
     */
    function _isOptionalField(StoredInputDef storage def, bytes32 fieldId) internal view returns (bool) {
        bytes memory flags = def.fieldFlags;
        for (uint256 i = 0; i < flags.length; i++) {
            if (def.fieldIds[i] == fieldId) {
                return uint8(flags[i]) & FIELD_REQUIRED == 0;
            }
        }
        return false;
    }

    /**
     * @notice Get a uint256 value from stored vars.
     */
    function _getUintFromStored(bytes32 targetFieldId) internal view returns (uint256 value) {
        return uint256(_readVar(targetFieldId, FieldType.UINT256).word);
    }

    /**
     * @notice Get an address value from stored vars.
     */
    function _getAddressFromStored(bytes32 targetFieldId) internal view returns (address value) {
        return _readVar(targetFieldId, FieldType.ADDRESS).addr;
    }

    /**
     * @notice Get a string value from stored vars.
     */
    function _getStringFromStored(bytes32 targetFieldId) internal view returns (string memory value) {
        return string(_readVar(targetFieldId, FieldType.STRING).str);
    }

    /**
     * @notice Evaluate sender-based conditions.
     * @param permitSigner If non-zero, checks this address instead of msg.sender (for permit submissions)
     */
    function _evalSenderCondition(Condition memory c, address permitSigner) internal view {
        address stored = _getAddressFromStored(c.fieldId);
        address senderToCheck = permitSigner != address(0) ? permitSigner : msg.sender;
        if (senderToCheck != stored) {
            revert SenderAddressMismatch(senderToCheck, stored);
        }
    }

    /**
     * @notice Evaluate sender membership against stored address vars and/or literal addresses.
     * @dev Condition.bytesArg must be abi.encode(bytes32[] allowedVarFieldIds, address[] allowedAddresses).
     */
    function _evalAllowedSenderCondition(Condition memory c, address permitSigner) internal view {
        (bytes32[] memory allowedVarFieldIds, address[] memory allowedAddresses) =
            abi.decode(c.bytesArg, (bytes32[], address[]));

        address senderToCheck = permitSigner != address(0) ? permitSigner : msg.sender;

        for (uint256 i = 0; i < allowedVarFieldIds.length; i++) {
            if (senderToCheck == _getAddressFromStored(allowedVarFieldIds[i])) {
                return;
            }
        }

        for (uint256 i = 0; i < allowedAddresses.length; i++) {
            if (senderToCheck == allowedAddresses[i]) {
                return;
            }
        }

        revert SenderAddressNotAllowed(senderToCheck);
    }

    /**
     * @notice Evaluate string-based conditions.
     */
    function _evalStringCondition(
        Condition memory c,
        DataField memory f
    ) internal view {
        if (f.fType != FieldType.STRING) {
            revert TypeMismatch("STRING", _fieldTypeToString(f.fType));
        }

        if (c.op == Op.STRING_MIN_LENGTH) {
            _checkStringMinLength(f, c);
        } else if (c.op == Op.STRING_MAX_LENGTH) {
            _checkStringMaxLength(f, c);
        } else if (c.op == Op.STRING_EQ_CONST) {
            _checkStringEqConst(f, c);
        } else if (c.op == Op.STRING_EQ_VAR) {
            _checkStringEqVar(f, c);
        }
    }

    function _checkStringMinLength(DataField memory f, Condition memory c) internal pure {
        string memory s = abi.decode(f.data, (string));
        uint256 minLength = abi.decode(c.bytesArg, (uint256));
        if (bytes(s).length < minLength) {
            revert ComparisonFailed("STRING_MIN_LENGTH", "STRING");
        }
    }

    function _checkStringMaxLength(DataField memory f, Condition memory c) internal pure {
        string memory s = abi.decode(f.data, (string));
        uint256 maxLength = abi.decode(c.bytesArg, (uint256));
        if (bytes(s).length > maxLength) {
            revert ComparisonFailed("STRING_MAX_LENGTH", "STRING");
        }
    }

    function _checkStringEqConst(DataField memory f, Condition memory c) internal pure {
        string memory fieldValue = abi.decode(f.data, (string));
        string memory constValue = abi.decode(c.bytesArg, (string));
        if (keccak256(bytes(fieldValue)) != keccak256(bytes(constValue))) {
            revert ComparisonFailed("STRING_EQ_CONST", "STRING");
        }
    }

    function _checkStringEqVar(
        DataField memory f,
        Condition memory c
    ) internal view {
        bytes32 targetFieldId = abi.decode(c.bytesArg, (bytes32));
        string memory varValue = _getStringFromStored(targetFieldId);
        
        string memory fieldValue = abi.decode(f.data, (string));
        if (keccak256(bytes(fieldValue)) != keccak256(bytes(varValue))) {
            revert ComparisonFailed("STRING_EQ_VAR", "STRING");
        }
    }

    /**
     * @notice Evaluate uint256-based conditions.
     */
    function _evalUintCondition(
        Condition memory c,
        DataField memory f
    ) internal view {
        if (f.fType != FieldType.UINT256) {
            revert TypeMismatch("UINT256", _fieldTypeToString(f.fType));
        }

        uint256 fieldValue = abi.decode(f.data, (uint256));
        uint256 compareValue;
        bool useVar = (c.op >= Op.UINT_EQ_VAR);

        if (c.op >= Op.UINT_EQ_VAR_OFFSET) {
            (bytes32 targetFieldId, int256 offset) = abi.decode(c.bytesArg, (bytes32, int256));
            compareValue = _addOffset(targetFieldId, _getUintFromStored(targetFieldId), offset);
        } else if (useVar) {
            bytes32 targetFieldId = abi.decode(c.bytesArg, (bytes32));
            compareValue = _getUintFromStored(targetFieldId);
        } else {
            compareValue = abi.decode(c.bytesArg, (uint256));
        }

        bool result = _compareUint(fieldValue, compareValue, c.op);
        if (!result) {
            revert ComparisonFailed(_opToString(c.op), "UINT256");
        }
    }

    /**
     * @notice A stored value plus a signed constant. The input is refused when
     *         the result would be below zero or above the uint256 range.
     */
    function _addOffset(bytes32 targetFieldId, uint256 stored, int256 offset) internal pure returns (uint256) {
        unchecked {
            if (offset >= 0) {
                uint256 sum = stored + uint256(offset);
                if (sum < stored) revert OffsetOutOfRange(targetFieldId, stored, offset);
                return sum;
            }
            // -offset as a magnitude, correct for type(int256).min too.
            uint256 magnitude = uint256(-(offset + 1)) + 1;
            if (magnitude > stored) revert OffsetOutOfRange(targetFieldId, stored, offset);
            return stored - magnitude;
        }
    }

    /**
     * @notice Compare two uint256 values based on operation.
     */
    function _compareUint(uint256 a, uint256 b, Op op) internal pure returns (bool) {
        // Normalize VAR ops to CONST ops for comparison (subtract 5)
        // UINT_EQ_VAR = 9, UINT_GT_VAR = 10, etc. -> normalize to UINT_EQ_CONST, UINT_GT_CONST, etc.
        Op normalizedOp = op;
        if (op >= Op.UINT_EQ_VAR_OFFSET) {
            // UINT_EQ_VAR_OFFSET = 18 -> UINT_EQ_CONST = 4, and so on.
            normalizedOp = Op(uint8(op) - uint8(Op.UINT_EQ_VAR_OFFSET) + uint8(Op.UINT_EQ_CONST));
        } else if (op >= Op.UINT_EQ_VAR) {
            normalizedOp = Op(uint8(op) - 5);
        }
        
        // Compare based on normalized operation
        if (normalizedOp == Op.UINT_EQ_CONST) return a == b;
        if (normalizedOp == Op.UINT_GT_CONST) return a > b;
        if (normalizedOp == Op.UINT_GTE_CONST) return a >= b;
        if (normalizedOp == Op.UINT_LT_CONST) return a < b;
        if (normalizedOp == Op.UINT_LTE_CONST) return a <= b;
        return false;
    }

    /**
     * @notice Evaluate address-based conditions.
     */
    function _evalAddressCondition(
        Condition memory c,
        DataField memory f
    ) internal view {
        if (f.fType != FieldType.ADDRESS) {
            revert TypeMismatch("ADDRESS", _fieldTypeToString(f.fType));
        }

        address fieldValue = abi.decode(f.data, (address));
        address compareValue = address(0);

        if (c.op == Op.ADDRESS_EQ_CONST) {
            compareValue = abi.decode(c.bytesArg, (address));
        } else if (c.op == Op.ADDRESS_EQ_VAR) {
            bytes32 targetFieldId = abi.decode(c.bytesArg, (bytes32));
            compareValue = _getAddressFromStored(targetFieldId);
        } else {
            revert ComparisonFailed(_opToString(c.op), "ADDRESS");
        }

        if (fieldValue != compareValue) {
            revert ComparisonFailed(_opToString(c.op), "ADDRESS");
        }
    }

    /**
     * @notice Helper to convert FieldType enum to string for error messages.
     */
    function _fieldTypeToString(FieldType fType) internal pure returns (string memory) {
        if (fType == FieldType.UINT256) return "UINT256";
        if (fType == FieldType.STRING) return "STRING";
        if (fType == FieldType.ADDRESS) return "ADDRESS";
        if (fType == FieldType.BOOL) return "BOOL";
        if (fType == FieldType.BYTES32) return "BYTES32";
        return "UNKNOWN";
    }

    /**
     * @notice Helper to convert Op enum to string for error messages.
     * @dev Every branch names the enum member it stands for, so the name stays
     *      right when the enum changes.
     */
    function _opToString(Op op) internal pure returns (string memory) {
        if (op <= Op.STRING_EQ_VAR) return _getStringOpName(op);
        if (op <= Op.UINT_LTE_CONST) return _getUintConstOpName(op);
        if (op <= Op.UINT_LTE_VAR) return _getUintVarOpName(op);
        if (op <= Op.ADDRESS_EQ_VAR) return _getAddressOpName(op);
        if (op == Op.SENDER_EQ_VAR_ADDRESS) return "SENDER_EQ_VAR_ADDRESS";
        if (op == Op.SENDER_IN_ALLOWED_ADDRESSES) return "SENDER_IN_ALLOWED_ADDRESSES";
        if (op == Op.UINT_EQ_VAR_OFFSET) return "UINT_EQ_VAR_OFFSET";
        if (op == Op.UINT_GT_VAR_OFFSET) return "UINT_GT_VAR_OFFSET";
        if (op == Op.UINT_GTE_VAR_OFFSET) return "UINT_GTE_VAR_OFFSET";
        if (op == Op.UINT_LT_VAR_OFFSET) return "UINT_LT_VAR_OFFSET";
        return "UINT_LTE_VAR_OFFSET";
    }

    function _getStringOpName(Op op) private pure returns (string memory) {
        if (op == Op.STRING_MIN_LENGTH) return "STRING_MIN_LENGTH";
        if (op == Op.STRING_MAX_LENGTH) return "STRING_MAX_LENGTH";
        if (op == Op.STRING_EQ_CONST) return "STRING_EQ_CONST";
        return "STRING_EQ_VAR";
    }

    function _getUintConstOpName(Op op) private pure returns (string memory) {
        if (op == Op.UINT_EQ_CONST) return "UINT_EQ_CONST";
        if (op == Op.UINT_GT_CONST) return "UINT_GT_CONST";
        if (op == Op.UINT_GTE_CONST) return "UINT_GTE_CONST";
        if (op == Op.UINT_LT_CONST) return "UINT_LT_CONST";
        return "UINT_LTE_CONST";
    }

    function _getUintVarOpName(Op op) private pure returns (string memory) {
        if (op == Op.UINT_EQ_VAR) return "UINT_EQ_VAR";
        if (op == Op.UINT_GT_VAR) return "UINT_GT_VAR";
        if (op == Op.UINT_GTE_VAR) return "UINT_GTE_VAR";
        if (op == Op.UINT_LT_VAR) return "UINT_LT_VAR";
        return "UINT_LTE_VAR";
    }

    function _getAddressOpName(Op op) private pure returns (string memory) {
        if (op == Op.ADDRESS_EQ_CONST) return "ADDRESS_EQ_CONST";
        return "ADDRESS_EQ_VAR";
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
        bytes32 toState = transitionTo[fromState][inputId];
        if (toState != bytes32(0)) return (true, toState);
        return (transitionToZero[fromState][inputId], bytes32(0));
    }

    /**
     * @dev Execute an action if registered for this (fromState,inputId).
     * Reverts on failure to preserve atomicity.
     */
    function _executeActionIfAny(bytes32 fromState, bytes32 toState, bytes32 inputId) internal {
        if (!hasActions) return;
        Action storage a = actions[fromState][inputId];
        if (!a.exists) return;

        // A call to an address without code succeeds and does nothing. Checked
        // here rather than at creation, so a target may be deployed after the
        // agreement as long as it exists when the transition runs.
        if (a.target.code.length == 0) revert ActionTargetHasNoCode(a.target);

        bytes memory callData = a.data;
        bool isERC20Transfer = _isERC20TransferCall(callData);

        // No value is forwarded: `_storeActions` rejects actions that carry one.
        (bool ok, bytes memory ret) = a.target.call(callData);
        if (!ok) revert ActionCallFailed(a.target, ret);
        if (isERC20Transfer && ret.length != 0) {
            if (ret.length != 32) revert ActionERC20ReturnInvalid(a.target, ret);

            uint256 result;
            assembly ("memory-safe") {
                result := mload(add(ret, 32))
            }
            if (result != 1) revert ActionERC20ReturnInvalid(a.target, ret);
        }

        emit ActionExecuted(fromState, toState, inputId, a.target);
    }

    /**
     * @dev Apply SafeERC20-style optional-return checks to the two ERC-20
     * transfer selectors without imposing boolean-return semantics on generic
     * agreement actions such as registry or attestation calls.
     */
    function _isERC20TransferCall(bytes memory data) private pure returns (bool) {
        if (data.length < 4) return false;

        bytes4 selector;
        assembly ("memory-safe") {
            selector := mload(add(data, 32))
        }
        return selector == 0xa9059cbb || selector == 0x23b872dd;
    }

}
