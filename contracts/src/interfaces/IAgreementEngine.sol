// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.20;

/**
 * @title IAgreementEngine
 * @notice External surface of the AgreementEngine: events and the value-typed
 *         entrypoints used to read state and drive the agreement's state machine.
 * @dev The struct-bearing entrypoint `initialize(...)` and the input/transition/variable
 *      struct definitions live on AgreementEngine itself, which is the authority for those
 *      types; they are documented there in NatSpec rather than redeclared to avoid
 *      duplicating the data model.
 *
 *      Owner-less governance (R8): there is NO post-init configuration surface — no
 *      privileged-operator role, no verifier/action mutators. Configuration (verifiers,
 *      actions, conditions) is fixed at initialization.
 */
interface IAgreementEngine {
    // ------------------------------------------------------------------
    // Events
    // ------------------------------------------------------------------

    /// @notice Emitted when a verifier contract is registered for a key.
    event VerifierRegistered(bytes32 indexed key, address indexed verifier);

    /// @notice Emitted once when a clone is initialized with its agreement data.
    event AgreementInitialized(
        address indexed owner,
        string docUri,
        bytes32 docHash,
        bytes32 initialState
    );

    /// @notice Emitted when a submitted input drives a transition.
    event InputAccepted(
        bytes32 indexed fromState,
        bytes32 indexed toState,
        bytes32 inputId,
        bytes payload
    );

    /// @notice Emitted when an input is submitted on behalf of a signer via permit.
    event InputSubmittedWithPermit(
        address indexed signer,
        address indexed submitter,
        bytes32 indexed inputId
    );

    /// @notice Emitted when an action is registered for a (fromState, inputId).
    event ActionRegistered(
        bytes32 indexed fromState,
        bytes32 indexed inputId,
        address indexed target,
        uint256 value,
        bytes data
    );

    /// @notice Emitted when a registered action executes as part of a transition.
    event ActionExecuted(
        bytes32 indexed fromState,
        bytes32 indexed toState,
        bytes32 indexed inputId,
        address target
    );

    // ------------------------------------------------------------------
    // State accessors
    // ------------------------------------------------------------------

    /// @notice Off-chain URI pointing to the agreement document/spec.
    function docUri() external view returns (string memory);

    /// @notice Content hash of the off-chain spec for integrity verification.
    function docHash() external view returns (bytes32);

    /// @notice Initial FSM state set at initialization.
    function initialState() external view returns (bytes32);

    /// @notice Current FSM state.
    function currentState() external view returns (bytes32);

    /// @notice Agreement owner, set once at initialization.
    function owner() external view returns (address);

    /// @notice Verifier contract registered for a key (zero if none).
    function verifierRegistry(bytes32 key) external view returns (address);

    /// @notice Permit nonce for a signer (replay protection).
    function nonces(address signer) external view returns (uint256);

    // ------------------------------------------------------------------
    // Input submission / FSM execution
    // ------------------------------------------------------------------

    /**
     * @notice Submit an input to progress the agreement FSM.
     * @param inputId The logical input identifier.
     * @param payload Encoded DataField[] array.
     */
    function submitInput(bytes32 inputId, bytes calldata payload) external;

    /**
     * @notice Submit an input on behalf of a signer using a permit signature.
     * @param signer The address that signed the permit (authorizing the submission).
     * @param inputId The logical input identifier.
     * @param payload Encoded DataField[] array.
     * @param deadline Timestamp after which the permit is invalid.
     * @param v ECDSA recovery byte.
     * @param r ECDSA r value.
     * @param s ECDSA s value.
     */
    function submitInputWithPermit(
        address signer,
        bytes32 inputId,
        bytes calldata payload,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
}
