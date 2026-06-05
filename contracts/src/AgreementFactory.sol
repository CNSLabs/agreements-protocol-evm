// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.20;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {AgreementEngine} from "./AgreementEngine.sol";

/**
 * @title AgreementFactory
 * @notice Factory for deploying AgreementEngine clones using the EIP-1167 minimal
 *         proxy pattern. Each clone is an isolated agreement instance; the caller
 *         (msg.sender) becomes the owner of the deployed agreement.
 * @dev Composable-only: agreements are authored as composable `Call[]` actions and
 *      canonical conditions, with verifiers registered at init (owner-less governance).
 *      Legacy `Op`/`ActionInit` authoring is desugared into this composable shape OFF-CHAIN
 *      by the SDK; there is no legacy create path. The permit typehash binds the composable
 *      shape, including a hash over the verifier registrations (verifiersHash).
 */
contract AgreementFactory is ReentrancyGuard, EIP712 {
    using Clones for address;

    /// @notice The AgreementEngine implementation contract address
    address public immutable implementation;

    /// @notice Permit functionality - nonce tracking per signer
    mapping(address => uint256) public nonces;

    /// @notice EIP-712 typehash for a permit that binds the COMPOSABLE agreement shape.
    /// @dev Binds the composable actions, the canonical conditions, and the verifier
    ///      registrations (verifiersHash) in addition to the doc/state/inputDefs/transitions/
    ///      initVars hashes. Replaces the legacy PERMIT_WITH_ACTIONS_TYPEHASH.
    bytes32 public constant PERMIT_AGREEMENT_TYPEHASH = keccak256(
        "PermitAgreement(string docUri,bytes32 docHash,bytes32 initialState,bytes32 inputDefsHash,bytes32 transitionsHash,bytes32 initVarsHash,bytes32 actionsHash,bytes32 canonicalCondsHash,bytes32 verifiersHash,uint256 nonce,uint256 deadline)"
    );

    /// @notice Emitted when a new agreement clone is deployed
    event AgreementDeployed(
        address indexed agreement,
        address indexed owner,
        string docUri,
        bytes32 docHash
    );

    /// @notice Emitted when an agreement is created via permit
    event AgreementCreatedWithPermit(
        address indexed agreement,
        address indexed signer,
        address indexed submitter
    );

    /// @notice Error when implementation address is zero
    error InvalidImplementation();

    /// @notice Error when permit has expired
    error PermitExpired(uint256 deadline);

    /// @notice Error when signature is invalid
    error InvalidSignature();

    /**
     * @notice Create a new factory pointing to an AgreementEngine implementation
     * @param implementation_ Address of the AgreementEngine implementation contract
     */
    constructor(address implementation_) EIP712("AgreementFactory", "1") {
        if (implementation_ == address(0)) revert InvalidImplementation();
        implementation = implementation_;
    }

    /**
     * @notice Deploy a new agreement clone (composable authoring).
     * @dev The caller (msg.sender) becomes the owner of the new agreement.
     * @param docUri Off-chain URI to full JSON/spec
     * @param docHash Content hash of the off-chain spec (integrity)
     * @param initialState Initial FSM state
     * @param inputDefs_ All input definitions (no conditions — see InputDef)
     * @param transitions_ All transitions for this agreement
     * @param initVars_ Initial variables to store
     * @param actions_ Composable action definitions, keyed by (fromState, inputId)
     * @param canonicalConds_ Canonical input conditions, keyed by inputId
     * @param verifiers_ Verifier registrations fixed at initialization (owner-less, R8)
     * @return agreement Address of the deployed agreement clone
     */
    function createAgreement(
        string calldata docUri,
        bytes32 docHash,
        bytes32 initialState,
        AgreementEngine.InputDef[] calldata inputDefs_,
        AgreementEngine.Transition[] calldata transitions_,
        AgreementEngine.DataField[] calldata initVars_,
        AgreementEngine.ComposableActionInit[] calldata actions_,
        AgreementEngine.CanonicalConditionInit[] calldata canonicalConds_,
        AgreementEngine.VerifierReg[] calldata verifiers_
    ) external nonReentrant returns (address agreement) {
        agreement = implementation.clone();
        emit AgreementDeployed(agreement, msg.sender, docUri, docHash);
        _init(agreement, msg.sender, docUri, docHash, initialState, inputDefs_, transitions_, initVars_, actions_, canonicalConds_, verifiers_);
    }

    /**
     * @notice Deploy a new agreement clone at a deterministic address (composable authoring).
     * @dev The caller (msg.sender) becomes the owner. Address is derived from salt.
     *      Reverts if a contract already exists at the predicted address.
     * @param salt User-provided salt for deterministic address derivation
     * @return agreement Address of the deployed agreement clone
     */
    function createAgreementDeterministic(
        bytes32 salt,
        string calldata docUri,
        bytes32 docHash,
        bytes32 initialState,
        AgreementEngine.InputDef[] calldata inputDefs_,
        AgreementEngine.Transition[] calldata transitions_,
        AgreementEngine.DataField[] calldata initVars_,
        AgreementEngine.ComposableActionInit[] calldata actions_,
        AgreementEngine.CanonicalConditionInit[] calldata canonicalConds_,
        AgreementEngine.VerifierReg[] calldata verifiers_
    ) external nonReentrant returns (address agreement) {
        agreement = implementation.cloneDeterministic(salt);
        emit AgreementDeployed(agreement, msg.sender, docUri, docHash);
        _init(agreement, msg.sender, docUri, docHash, initialState, inputDefs_, transitions_, initVars_, actions_, canonicalConds_, verifiers_);
    }

    /// @dev Sole call site of `initialize` — isolates the 10-arg external-call ABI-encode of
    ///      the six init arrays into one frame, so the create paths (especially the permit
    ///      paths, which also verify a signature) don't carry that encode pressure and hit the
    ///      via-IR "stack too deep". Shared by every create entrypoint.
    function _init(
        address agreement,
        address owner_,
        string calldata docUri,
        bytes32 docHash,
        bytes32 initialState,
        AgreementEngine.InputDef[] calldata inputDefs_,
        AgreementEngine.Transition[] calldata transitions_,
        AgreementEngine.DataField[] calldata initVars_,
        AgreementEngine.ComposableActionInit[] calldata actions_,
        AgreementEngine.CanonicalConditionInit[] calldata canonicalConds_,
        AgreementEngine.VerifierReg[] calldata verifiers_
    ) internal {
        AgreementEngine(agreement).initialize(
            owner_,
            docUri,
            docHash,
            initialState,
            inputDefs_,
            transitions_,
            initVars_,
            actions_,
            canonicalConds_,
            verifiers_
        );
    }

    /**
     * @notice Create an agreement using a permit signature binding the composable shape.
     * @dev The permit is an EIP-712 signature by `signer` over the agreement parameters
     *      (the doc/state hashes plus hashes of inputDefs/transitions/initVars/actions/
     *      canonicalConds/verifiers) plus the signer's current nonce and `deadline`. Anyone
     *      may submit the transaction, but the recovered signer must match `signer` and the
     *      nonce is consumed to prevent replay. The signer becomes the agreement owner.
     */
    function createAgreementWithPermit(
        address signer,
        string calldata docUri,
        bytes32 docHash,
        bytes32 initialState,
        AgreementEngine.InputDef[] calldata inputDefs_,
        AgreementEngine.Transition[] calldata transitions_,
        AgreementEngine.DataField[] calldata initVars_,
        AgreementEngine.ComposableActionInit[] calldata actions_,
        AgreementEngine.CanonicalConditionInit[] calldata canonicalConds_,
        AgreementEngine.VerifierReg[] calldata verifiers_,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant returns (address agreement) {
        _verifyPermit(
            signer,
            docUri,
            docHash,
            initialState,
            _hashInitArrays(inputDefs_, transitions_, initVars_, actions_, canonicalConds_, verifiers_),
            deadline,
            v,
            r,
            s
        );

        agreement = implementation.clone();
        emit AgreementDeployed(agreement, signer, docUri, docHash);
        emit AgreementCreatedWithPermit(agreement, signer, msg.sender);

        _init(agreement, signer, docUri, docHash, initialState, inputDefs_, transitions_, initVars_, actions_, canonicalConds_, verifiers_);
    }

    /**
     * @notice Create a deterministic agreement using a permit signature (composable shape).
     * @dev Same as `createAgreementWithPermit` but deploys at a deterministic address derived
     *      from `salt`. The permit does NOT bind the salt; it authorizes the agreement params.
     */
    function createAgreementDeterministicWithPermit(
        address signer,
        bytes32 salt,
        string calldata docUri,
        bytes32 docHash,
        bytes32 initialState,
        AgreementEngine.InputDef[] calldata inputDefs_,
        AgreementEngine.Transition[] calldata transitions_,
        AgreementEngine.DataField[] calldata initVars_,
        AgreementEngine.ComposableActionInit[] calldata actions_,
        AgreementEngine.CanonicalConditionInit[] calldata canonicalConds_,
        AgreementEngine.VerifierReg[] calldata verifiers_,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant returns (address agreement) {
        _verifyPermit(
            signer,
            docUri,
            docHash,
            initialState,
            _hashInitArrays(inputDefs_, transitions_, initVars_, actions_, canonicalConds_, verifiers_),
            deadline,
            v,
            r,
            s
        );

        agreement = implementation.cloneDeterministic(salt);
        emit AgreementDeployed(agreement, signer, docUri, docHash);
        emit AgreementCreatedWithPermit(agreement, signer, msg.sender);

        _init(agreement, signer, docUri, docHash, initialState, inputDefs_, transitions_, initVars_, actions_, canonicalConds_, verifiers_);
    }

    /**
     * @dev Verify a composable-create permit signature and consume the signer's nonce.
     *      Shared by the permit / deterministic-permit create paths. Each calldata array is
     *      hashed in its own helper frame (the per-array `_hash*` functions) to keep the
     *      ABI-encode of each array off a single overloaded stack — the combined struct hash
     *      binds doc/state + those array hashes per PERMIT_AGREEMENT_TYPEHASH. Recovers the
     *      signer and reverts InvalidSignature / PermitExpired on mismatch / expiry.
     *
     *      The composable actions and the canonical conditions bind the action shape +
     *      guards; verifiersHash adopts the verifier binding so a relayer cannot swap
     *      verifiers, actions, or conditions.
     */
    function _verifyPermit(
        address signer,
        string calldata docUri,
        bytes32 docHash,
        bytes32 initialState,
        bytes memory packedArrayHashes,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) internal {
        if (block.timestamp > deadline) {
            revert PermitExpired(deadline);
        }

        // `packedArrayHashes` is the abi.encode of the six init-array hashes (computed by the
        // caller in a separate frame so the array ABI-encodes never co-occupy the external
        // function's stack — the via-IR "stack too deep" fix). The bytes.concat below is
        // byte-identical to abi.encode(TYPEHASH, docUriHash, docHash, initialState,
        // inputDefsHash, transitionsHash, initVarsHash, actionsHash, canonicalCondsHash,
        // verifiersHash, nonce, deadline) — every field is a static 32-byte word.
        bytes32 structHash = keccak256(
            bytes.concat(
                abi.encode(PERMIT_AGREEMENT_TYPEHASH, keccak256(bytes(docUri)), docHash, initialState),
                packedArrayHashes,
                abi.encode(nonces[signer], deadline)
            )
        );
        bytes32 hash = _hashTypedDataV4(structHash);
        if (ECDSA.recover(hash, v, r, s) != signer) {
            revert InvalidSignature();
        }

        nonces[signer]++;
    }

    /// @dev abi.encode of the six per-array hashes in typehash field order (inputDefs,
    ///      transitions, initVars, actions, canonicalConds, verifiers), each
    ///      `keccak256(abi.encode(arr))`. Each array is hashed in its OWN single-array helper
    ///      frame (below) so no two array ABI-encodes ever co-occupy one stack — the via-IR
    ///      "stack too deep" fix. The bytes are the middle slice of the struct-hash preimage.
    function _hashInitArrays(
        AgreementEngine.InputDef[] calldata inputDefs_,
        AgreementEngine.Transition[] calldata transitions_,
        AgreementEngine.DataField[] calldata initVars_,
        AgreementEngine.ComposableActionInit[] calldata actions_,
        AgreementEngine.CanonicalConditionInit[] calldata canonicalConds_,
        AgreementEngine.VerifierReg[] calldata verifiers_
    ) internal pure returns (bytes memory) {
        return abi.encode(
            _hashInputDefs(inputDefs_),
            _hashTransitions(transitions_),
            _hashInitVars(initVars_),
            _hashActions(actions_),
            _hashCanonicalConds(canonicalConds_),
            _hashVerifiers(verifiers_)
        );
    }

    // Single-array hashers — each isolates one `keccak256(abi.encode(arr))` in its own frame.
    function _hashInputDefs(AgreementEngine.InputDef[] calldata a) internal pure returns (bytes32) {
        return keccak256(abi.encode(a));
    }
    function _hashTransitions(AgreementEngine.Transition[] calldata a) internal pure returns (bytes32) {
        return keccak256(abi.encode(a));
    }
    function _hashInitVars(AgreementEngine.DataField[] calldata a) internal pure returns (bytes32) {
        return keccak256(abi.encode(a));
    }
    function _hashActions(AgreementEngine.ComposableActionInit[] calldata a) internal pure returns (bytes32) {
        return keccak256(abi.encode(a));
    }
    function _hashCanonicalConds(AgreementEngine.CanonicalConditionInit[] calldata a) internal pure returns (bytes32) {
        return keccak256(abi.encode(a));
    }
    function _hashVerifiers(AgreementEngine.VerifierReg[] calldata a) internal pure returns (bytes32) {
        return keccak256(abi.encode(a));
    }

    /**
     * @notice Predict the address of a deterministic clone before deployment
     * @dev Uses the same derivation as createAgreementDeterministic.
     *      Address = keccak256(0xff ++ factory ++ salt ++ keccak256(cloneBytecode))
     * @param salt The salt that will be used for deployment
     * @return predicted The address where the clone would be deployed
     */
    function predictAddress(bytes32 salt) external view returns (address predicted) {
        return implementation.predictDeterministicAddress(salt, address(this));
    }
}
