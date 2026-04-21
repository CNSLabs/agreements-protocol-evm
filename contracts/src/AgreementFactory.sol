// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/proxy/Clones.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "./AgreementEngine.sol";

/**
 * @title AgreementFactory
 * @notice Factory for deploying AgreementEngine clones using EIP-1167 minimal proxy pattern.
 * @dev Each clone is an isolated agreement instance. The factory enforces that
 *      the caller (msg.sender) becomes the owner of the deployed agreement.
 */
contract AgreementFactory is ReentrancyGuard, EIP712 {
    using Clones for address;

    /// @notice The AgreementEngine implementation contract address
    address public immutable implementation;

    /// @notice Permit functionality - nonce tracking per signer
    mapping(address => uint256) public nonces;

    /// @notice EIP-712 typehash for permit that also binds action definitions
    bytes32 public constant PERMIT_WITH_ACTIONS_TYPEHASH = keccak256(
        "PermitAgreementWithActions(string docUri,bytes32 docHash,bytes32 initialState,bytes32 inputDefsHash,bytes32 transitionsHash,bytes32 initVarsHash,bytes32 actionsHash,uint256 nonce,uint256 deadline)"
    );

    // Unused state variable to modify bytecode (version marker)
    uint256 private _versionMarker = 0x2024;

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
    
    /// @notice Error when nonce is invalid
    error InvalidNonce(address signer, uint256 provided, uint256 expected);

    /**
     * @notice Create a new factory pointing to an AgreementEngine implementation
     * @param implementation_ Address of the AgreementEngine implementation contract
     */
    constructor(address implementation_) EIP712("AgreementFactory", "1") {
        if (implementation_ == address(0)) revert InvalidImplementation();
        implementation = implementation_;
    }

    /**
     * @notice Deploy a new agreement clone
     * @dev The caller (msg.sender) becomes the owner of the new agreement.
     * @param docUri Off-chain URI to full JSON/spec
     * @param docHash Content hash of the off-chain spec (integrity)
     * @param initialState Initial FSM state
     * @param inputDefs_ All input definitions for this agreement
     * @param transitions_ All transitions for this agreement
     * @param initVars_ Initial variables to store
     * @return agreement Address of the deployed agreement clone
     */
    function createAgreement(
        string calldata docUri,
        bytes32 docHash,
        bytes32 initialState,
        AgreementEngine.InputDef[] calldata inputDefs_,
        AgreementEngine.Transition[] calldata transitions_,
        AgreementEngine.DataField[] calldata initVars_,
        AgreementEngine.ActionInit[] calldata actions_
    ) external nonReentrant returns (address agreement) {
        // Deploy minimal proxy clone (~45k gas)
        agreement = implementation.clone();

        emit AgreementDeployed(agreement, msg.sender, docUri, docHash);

        // Initialize the clone with msg.sender as owner
        AgreementEngine(agreement).initialize(
            msg.sender,
            docUri,
            docHash,
            initialState,
            inputDefs_,
            transitions_,
            initVars_,
            actions_
        );

    }

    /**
     * @notice Deploy a new agreement clone at a deterministic address
     * @dev The caller (msg.sender) becomes the owner. Address is derived from salt.
     *      Reverts if a contract already exists at the predicted address.
     * @param salt User-provided salt for deterministic address derivation
     * @param docUri Off-chain URI to full JSON/spec
     * @param docHash Content hash of the off-chain spec (integrity)
     * @param initialState Initial FSM state
     * @param inputDefs_ All input definitions for this agreement
     * @param transitions_ All transitions for this agreement
     * @param initVars_ Initial variables to store
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
        AgreementEngine.ActionInit[] calldata actions_
    ) external nonReentrant returns (address agreement) {
        // Deploy minimal proxy clone at deterministic address
        agreement = implementation.cloneDeterministic(salt);

        emit AgreementDeployed(agreement, msg.sender, docUri, docHash);

        // Initialize the clone with msg.sender as owner
        AgreementEngine(agreement).initialize(
            msg.sender,
            docUri,
            docHash,
            initialState,
            inputDefs_,
            transitions_,
            initVars_,
            actions_
        );

    }

    /**
     * @notice Create an agreement using a permit signature that also binds pre-registered action definitions.
     * @dev The permit is an EIP-712 signature by `signer` over the agreement parameters (including `actions_`)
     *      plus the signer's current nonce and `deadline`. Anyone may submit the transaction, but the recovered
     *      signer must match `signer` and the nonce is consumed to prevent replay.
     *
     * @param signer The address that signed the permit (and will become the agreement owner).
     * @param docUri Off-chain URI pointing to the agreement document/spec (e.g. IPFS URL).
     * @param docHash Content hash of the off-chain spec for integrity verification.
     * @param initialState Initial FSM state (also becomes `currentState` on init).
     * @param inputDefs_ Full set of input definitions accepted by this agreement.
     * @param transitions_ Full set of valid FSM transitions for this agreement.
     * @param initVars_ Initial on-chain variables to store (e.g., participant addresses, amounts).
     * @param actions_ Optional per-transition actions to pre-register; pass an empty array for none.
     * @param deadline The timestamp after which the permit is invalid.
     * @param v ECDSA signature recovery byte.
     * @param r ECDSA signature `r` value.
     * @param s ECDSA signature `s` value.
     * @return agreement Address of the deployed agreement clone.
     */
    function createAgreementWithPermit(
        address signer,
        string calldata docUri,
        bytes32 docHash,
        bytes32 initialState,
        AgreementEngine.InputDef[] calldata inputDefs_,
        AgreementEngine.Transition[] calldata transitions_,
        AgreementEngine.DataField[] calldata initVars_,
        AgreementEngine.ActionInit[] calldata actions_,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant returns (address agreement) {
        // Check deadline
        if (block.timestamp > deadline) {
            revert PermitExpired(deadline);
        }

        // Verify signature
        uint256 currentNonce = nonces[signer];

        // Compute hashes for arrays to keep typehash manageable
        bytes32 inputDefsHash = keccak256(abi.encode(inputDefs_));
        bytes32 transitionsHash = keccak256(abi.encode(transitions_));
        bytes32 initVarsHash = keccak256(abi.encode(initVars_));
        bytes32 actionsHash = keccak256(abi.encode(actions_));

        bytes32 structHash = keccak256(
            abi.encode(
                PERMIT_WITH_ACTIONS_TYPEHASH,
                keccak256(bytes(docUri)),
                docHash,
                initialState,
                inputDefsHash,
                transitionsHash,
                initVarsHash,
                actionsHash,
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

        // Deploy minimal proxy clone (~45k gas)
        agreement = implementation.clone();

        emit AgreementDeployed(agreement, signer, docUri, docHash);
        emit AgreementCreatedWithPermit(agreement, signer, msg.sender);

        // Initialize the clone with signer as owner (not msg.sender)
        AgreementEngine(agreement).initialize(
            signer,
            docUri,
            docHash,
            initialState,
            inputDefs_,
            transitions_,
            initVars_,
            actions_
        );
    }

    /**
     * @notice Create an agreement at a deterministic address using a permit signature that also binds action definitions.
     * @dev Same as `createAgreementWithPermit` but deploys the clone at a deterministic address derived from `salt`.
     *
     * @param signer The address that signed the permit (and will become the agreement owner).
     * @param salt User-provided salt for deterministic address derivation.
     * @param docUri Off-chain URI pointing to the agreement document/spec (e.g. IPFS URL).
     * @param docHash Content hash of the off-chain spec for integrity verification.
     * @param initialState Initial FSM state (also becomes `currentState` on init).
     * @param inputDefs_ Full set of input definitions accepted by this agreement.
     * @param transitions_ Full set of valid FSM transitions for this agreement.
     * @param initVars_ Initial on-chain variables to store (e.g., participant addresses, amounts).
     * @param actions_ Optional per-transition actions to pre-register; pass an empty array for none.
     * @param deadline The timestamp after which the permit is invalid.
     * @param v ECDSA signature recovery byte.
     * @param r ECDSA signature `r` value.
     * @param s ECDSA signature `s` value.
     * @return agreement Address of the deployed agreement clone.
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
        AgreementEngine.ActionInit[] calldata actions_,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant returns (address agreement) {
        // Check deadline
        if (block.timestamp > deadline) {
            revert PermitExpired(deadline);
        }

        // Verify signature
        uint256 currentNonce = nonces[signer];

        // Compute hashes for arrays to keep typehash manageable
        bytes32 inputDefsHash = keccak256(abi.encode(inputDefs_));
        bytes32 transitionsHash = keccak256(abi.encode(transitions_));
        bytes32 initVarsHash = keccak256(abi.encode(initVars_));
        bytes32 actionsHash = keccak256(abi.encode(actions_));

        bytes32 structHash = keccak256(
            abi.encode(
                PERMIT_WITH_ACTIONS_TYPEHASH,
                keccak256(bytes(docUri)),
                docHash,
                initialState,
                inputDefsHash,
                transitionsHash,
                initVarsHash,
                actionsHash,
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

        // Deploy minimal proxy clone at deterministic address
        agreement = implementation.cloneDeterministic(salt);

        emit AgreementDeployed(agreement, signer, docUri, docHash);
        emit AgreementCreatedWithPermit(agreement, signer, msg.sender);

        // Initialize the clone with signer as owner (not msg.sender)
        AgreementEngine(agreement).initialize(
            signer,
            docUri,
            docHash,
            initialState,
            inputDefs_,
            transitions_,
            initVars_,
            actions_
        );
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

    /**
     * @notice Unused function to modify bytecode signature
     * @dev This function is intentionally unused but changes contract bytecode
     */
    function _unusedBytecodeModifier() private pure returns (uint256) {
        return 0xDEADBEEF;
    }
}
