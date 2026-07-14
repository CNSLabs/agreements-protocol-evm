// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

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
contract AgreementEngine is Initializable, ReentrancyGuard, EIP712 {
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
        SENDER_IN_ALLOWED_ADDRESSES
    }

    // ========================================================================
    // STRUCTS
    // ========================================================================

    struct StoredVar {
        FieldType fType;
        bytes data;     // abi.encode(value) of that type
    }

    struct DataField {
        bytes32 id;       // logical name, e.g. keccak256("name")
        FieldType fType;  // tells us how to decode `data`
        bytes data;       // abi.encode(value) of that type
    }

    struct Condition {
        Op op;
        bytes32 fieldId;   // which DataField.id this condition targets (the field being checked)
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
     */
    struct Action {
        address target;
        uint256 value;
        bytes data;
        bool exists;
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

    // Single-agreement storage (no agreementId keys)
    mapping(bytes32 => InputDef) internal inputDefs;
    Transition[] internal transitions;
    mapping(bytes32 => address) public verifierRegistry;
    mapping(bytes32 => StoredVar) internal vars;

    // Optional per-transition actions, keyed by (fromState,inputId)
    mapping(bytes32 => mapping(bytes32 => Action)) internal actions;
    
    // Permit functionality - nonce tracking per signer
    mapping(address => uint256) public nonces;
    
    // EIP-712 typehash for permit
    bytes32 public constant PERMIT_TYPEHASH = keccak256(
        "PermitInput(bytes32 inputId,bytes payload,uint256 nonce,uint256 deadline)"
    );

    // Unused state variable to modify bytecode (version marker)
    uint256 private _versionMarker = 0x2024;

    // ========================================================================
    // ERRORS
    // ========================================================================

    error SenderAddressMismatch(address sender, address expected);
    error SenderAddressNotAllowed(address sender);
    error ComparisonFailed(string op, string fieldType);
    error VarNotSet(bytes32 fieldId);
    error TypeMismatch(string expected, string actual);
    error NotInitialized();
    error OwnerZero();
    error PermitExpired(uint256 deadline);
    error InvalidSignature();
    error InvalidNonce(address signer, uint256 provided, uint256 expected);
    error ActionTargetZero();
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
     */
    function submitInput(
        bytes32 inputId,
        bytes calldata payload
    ) external nonReentrant {
        if (owner == address(0)) revert NotInitialized();

        InputDef storage def = inputDefs[inputId];
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

        // 6. Persist only after every authorization check has succeeded.
        _persistFields(def, fields);

        // 7. Update state (action reads may expect updated state; revert will roll this back).
        currentState = to;

        // 8. Optional action (atomic with transition)
        _executeActionIfAny(from, to, inputId);

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

    // ========================================================================
    // INTERNAL FUNCTIONS - Storage Helpers
    // ========================================================================

    /**
     * @notice Store verifier registrations in contract storage.
     * @dev Called during initialization; verifiers are optional (pass empty array).
     */
    function _storeVerifiers(VerifierInit[] calldata verifiers_) internal {
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

            InputDef storage dst = inputDefs[src.id];
            require(dst.id == bytes32(0), "Duplicate inputId");
            dst.id = src.id;

            // Deep copy fields array
            for (uint256 j = 0; j < src.fields.length; j++) {
                dst.fields.push(src.fields[j]);
            }

            // Deep copy conditions array
            for (uint256 k = 0; k < src.conditions.length; k++) {
                dst.conditions.push(src.conditions[k]);
            }

            // Deep copy verifierKeys array
            for (uint256 m = 0; m < src.verifierKeys.length; m++) {
                bytes32 key = src.verifierKeys[m];
                if (verifierRegistry[key] == address(0)) revert UnknownVerifier(key);
                dst.verifierKeys.push(key);
            }
        }
    }

    /**
     * @notice Store transitions in contract storage.
     */
    function _storeTransitions(Transition[] calldata trans) internal {
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

            // Validate the field can be decoded as the claimed type
            _validateFieldDecoding(iv.data, iv.fType);

            // Store in vars mapping
            vars[iv.id] = StoredVar({
                fType: iv.fType,
                data: iv.data
            });
        }
    }

    /**
     * @notice Store actions in contract storage (keyed by fromState + inputId).
     * @dev Called during initialization; actions are optional (pass empty array).
     */
    function _storeActions(ActionInit[] calldata actions_) internal {
        for (uint256 i = 0; i < actions_.length; i++) {
            ActionInit calldata a = actions_[i];
            if (a.target == address(0)) revert ActionTargetZero();
            actions[a.fromState][a.inputId] = Action({
                target: a.target,
                value: a.value,
                data: a.data,
                exists: true
            });
            emit ActionRegistered(a.fromState, a.inputId, a.target, a.value, a.data);
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

            // Find the matching field in this input instance
            bool found = false;
            for (uint256 j = 0; j < fields.length; j++) {
                if (fields[j].id == fd.fieldId) {
                    DataField memory f = fields[j];

                    // Type sanity check
                    require(f.fType == fd.fType, "Persist field type mismatch");

                    // Store/overwrite current value
                    StoredVar storage v = vars[fd.fieldId];
                    v.fType = f.fType;
                    v.data = f.data;

                    found = true;
                    break;
                }
            }
            // If persist = true, we already enforced `required = true` in _validateFields
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
        InputDef storage def,
        bytes32 inputId,
        bytes calldata payload,
        address effectiveSender
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
        InputDef storage def,
        DataField[] memory fields
    ) internal view {
        for (uint256 i = 0; i < def.fields.length; i++) {
            InputFieldDef storage fd = def.fields[i];
            bool found = false;

            for (uint256 j = 0; j < fields.length; j++) {
                if (fields[j].id == fd.fieldId) {
                    found = true;
                    require(fields[j].fType == fd.fType, "Field type mismatch");
                    _validateFieldDecoding(fields[j].data, fd.fType);
                    break;
                }
            }

            if (fd.required) {
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
     * @param permitSigner If non-zero, SENDER_EQ_VAR_ADDRESS conditions check this address instead of msg.sender
     */
    function _validateConditions(
        InputDef storage def,
        DataField[] memory fields,
        address permitSigner
    ) internal view {
        for (uint256 i = 0; i < def.conditions.length; i++) {
            Condition memory c = def.conditions[i];
            if (c.op == Op.SENDER_EQ_VAR_ADDRESS) {
                _evalSenderCondition(c, permitSigner);
                continue;
            }
            if (c.op == Op.SENDER_IN_ALLOWED_ADDRESSES) {
                _evalAllowedSenderCondition(c, permitSigner);
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
        } else if (c.op >= Op.UINT_EQ_CONST && c.op <= Op.UINT_LTE_VAR) {
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
    function _isOptionalField(InputDef storage def, bytes32 fieldId) internal view returns (bool) {
        for (uint256 i = 0; i < def.fields.length; i++) {
            if (def.fields[i].fieldId == fieldId) {
                return !def.fields[i].required;
            }
        }
        return false;
    }

    /**
     * @notice Get a uint256 value from stored vars.
     */
    function _getUintFromStored(bytes32 targetFieldId) internal view returns (uint256 value) {
        StoredVar storage v = vars[targetFieldId];
        if (v.data.length == 0) {
            revert VarNotSet(targetFieldId);
        }
        if (v.fType != FieldType.UINT256) {
            revert TypeMismatch("UINT256", _fieldTypeToString(v.fType));
        }
        return abi.decode(v.data, (uint256));
    }

    /**
     * @notice Get an address value from stored vars.
     */
    function _getAddressFromStored(bytes32 targetFieldId) internal view returns (address value) {
        StoredVar storage v = vars[targetFieldId];
        if (v.data.length == 0) {
            revert VarNotSet(targetFieldId);
        }
        if (v.fType != FieldType.ADDRESS) {
            revert TypeMismatch("ADDRESS", _fieldTypeToString(v.fType));
        }
        return abi.decode(v.data, (address));
    }

    /**
     * @notice Get a string value from stored vars.
     */
    function _getStringFromStored(bytes32 targetFieldId) internal view returns (string memory value) {
        StoredVar storage v = vars[targetFieldId];
        if (v.data.length == 0) {
            revert VarNotSet(targetFieldId);
        }
        if (v.fType != FieldType.STRING) {
            revert TypeMismatch("STRING", _fieldTypeToString(v.fType));
        }
        return abi.decode(v.data, (string));
    }

    /**
     * @notice Evaluate sender-based conditions.
     * @param permitSigner If non-zero, checks this address instead of msg.sender (for permit submissions)
     */
    function _evalSenderCondition(Condition memory c, address permitSigner) internal view {
        StoredVar storage v = vars[c.fieldId];
        if (v.data.length == 0) {
            revert VarNotSet(c.fieldId);
        }
        if (v.fType != FieldType.ADDRESS) {
            revert TypeMismatch("ADDRESS", _fieldTypeToString(v.fType));
        }

        address stored = abi.decode(v.data, (address));
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

        if (useVar) {
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
     * @notice Compare two uint256 values based on operation.
     */
    function _compareUint(uint256 a, uint256 b, Op op) internal pure returns (bool) {
        // Normalize VAR ops to CONST ops for comparison (subtract 5)
        // UINT_EQ_VAR = 9, UINT_GT_VAR = 10, etc. -> normalize to UINT_EQ_CONST, UINT_GT_CONST, etc.
        Op normalizedOp = op;
        if (op >= Op.UINT_EQ_VAR) {
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
     */
    function _opToString(Op op) internal pure returns (string memory) {
        if (op == Op.SENDER_EQ_VAR_ADDRESS) {
            return "SENDER_EQ_VAR_ADDRESS";
        }
        if (op == Op.SENDER_IN_ALLOWED_ADDRESSES) {
            return "SENDER_IN_ALLOWED_ADDRESSES";
        }

        uint8 opValue = uint8(op);
        
        if (opValue <= 2) {
            return _getStringOpName(opValue);
        } else if (opValue <= 7) {
            return _getUintConstOpName(opValue);
        } else if (opValue <= 12) {
            return _getUintVarOpName(opValue);
        } else if (opValue <= 14) {
            return _getAddressOpName(opValue);
        }
        return "UNKNOWN_OPERATION";
    }

    function _getStringOpName(uint8 opValue) private pure returns (string memory) {
        if (opValue == 0) return "STRING_MIN_LENGTH";
        if (opValue == 1) return "STRING_MAX_LENGTH";
        if (opValue == 2) return "STRING_EQ_CONST";
        return "STRING_EQ_VAR";
    }

    function _getUintConstOpName(uint8 opValue) private pure returns (string memory) {
        if (opValue == 3) return "UINT_EQ_CONST";
        if (opValue == 4) return "UINT_GT_CONST";
        if (opValue == 5) return "UINT_GTE_CONST";
        if (opValue == 6) return "UINT_LT_CONST";
        return "UINT_LTE_CONST";
    }

    function _getUintVarOpName(uint8 opValue) private pure returns (string memory) {
        if (opValue == 8) return "UINT_EQ_VAR";
        if (opValue == 9) return "UINT_GT_VAR";
        if (opValue == 10) return "UINT_GTE_VAR";
        if (opValue == 11) return "UINT_LT_VAR";
        return "UINT_LTE_VAR";
    }

    function _getAddressOpName(uint8 opValue) private pure returns (string memory) {
        if (opValue == 13) return "ADDRESS_EQ_CONST";
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
     * @dev Execute an action if registered for this (fromState,inputId).
     * Reverts on failure to preserve atomicity.
     */
    function _executeActionIfAny(bytes32 fromState, bytes32 toState, bytes32 inputId) internal {
        Action storage a = actions[fromState][inputId];
        if (!a.exists) return;

        bytes memory callData = a.data;
        bool isERC20Transfer = _isERC20TransferCall(callData);
        if (isERC20Transfer && a.target.code.length == 0) {
            revert ActionTargetHasNoCode(a.target);
        }

        // slither-disable-next-line arbitrary-send-eth
        (bool ok, bytes memory ret) = a.target.call{value: a.value}(callData);
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

    /**
     * @notice Unused function to modify bytecode signature
     * @dev This function is intentionally unused but changes contract bytecode
     */
    function _unusedBytecodeModifier() private pure returns (uint256) {
        return 0xDEADBEEF;
    }
}
