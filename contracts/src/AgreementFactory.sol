// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/proxy/Clones.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import "./AgreementEngine.sol";

/**
 * @title AgreementFactory
 * @notice Factory for deploying AgreementEngine clones using EIP-1167 minimal proxy pattern.
 * @dev Each clone is an isolated agreement instance. The factory enforces that
 *      the caller (msg.sender) becomes the owner of the deployed agreement.
 *
 *      Deterministic addresses are derived from the creator and the salt, so a
 *      predicted address can only be claimed by the account it was predicted for:
 *      the caller on the direct path, the signer on the permit path. Every permit
 *      names its signer, so a signature validated by a smart account (ERC-1271)
 *      cannot be presented for another account that accepts the same key.
 */
contract AgreementFactory is ReentrancyGuard, EIP712 {
    using Clones for address;

    /// @notice The AgreementEngine implementation contract address
    address public immutable implementation;

    /// @notice Permit functionality - nonce tracking per signer
    mapping(address => uint256) public nonces;

    /// @notice EIP-712 typehash for permit that also binds verifier and action definitions
    bytes32 public constant PERMIT_WITH_ACTIONS_TYPEHASH = keccak256(
        "PermitAgreementWithActions(address signer,string docUri,bytes32 docHash,bytes32 initialState,bytes32 inputDefsHash,bytes32 transitionsHash,bytes32 initVarsHash,bytes32 verifiersHash,bytes32 actionsHash,uint256 nonce,uint256 deadline)"
    );

    /// @notice EIP-712 typehash for deterministic creation permits.
    /// @dev In addition to the complete agreement parameters, the signer binds its
    ///      own address, the CREATE2 salt and the exact clone address this factory
    ///      derives for that signer and salt.
    bytes32 public constant DETERMINISTIC_PERMIT_WITH_ACTIONS_TYPEHASH = keccak256(
        "PermitDeterministicAgreementWithActions(address signer,string docUri,bytes32 docHash,bytes32 initialState,bytes32 inputDefsHash,bytes32 transitionsHash,bytes32 initVarsHash,bytes32 verifiersHash,bytes32 actionsHash,bytes32 salt,address predictedAgreement,uint256 nonce,uint256 deadline)"
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
     * @param verifiers_ Optional verifier registrations to install at initialization time
     * @return agreement Address of the deployed agreement clone
     */
    function createAgreement(
        string calldata docUri,
        bytes32 docHash,
        bytes32 initialState,
        AgreementEngine.InputDef[] calldata inputDefs_,
        AgreementEngine.Transition[] calldata transitions_,
        AgreementEngine.DataField[] calldata initVars_,
        AgreementEngine.VerifierInit[] calldata verifiers_,
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
            verifiers_,
            actions_
        );

    }

    /**
     * @notice Deploy a new agreement clone at a deterministic address
     * @dev The caller (msg.sender) becomes the owner. The address is derived from
     *      the caller and the salt (see `predictAddress`), so no other account can
     *      deploy to it. Reverts if a contract already exists at that address.
     * @param salt User-provided salt, scoped to the caller
     * @param docUri Off-chain URI to full JSON/spec
     * @param docHash Content hash of the off-chain spec (integrity)
     * @param initialState Initial FSM state
     * @param inputDefs_ All input definitions for this agreement
     * @param transitions_ All transitions for this agreement
     * @param initVars_ Initial variables to store
     * @param verifiers_ Optional verifier registrations to install at initialization time
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
        AgreementEngine.VerifierInit[] calldata verifiers_,
        AgreementEngine.ActionInit[] calldata actions_
    ) external nonReentrant returns (address agreement) {
        // Deploy minimal proxy clone at the caller-scoped deterministic address
        agreement = implementation.cloneDeterministic(_creatorSalt(msg.sender, salt));

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
            verifiers_,
            actions_
        );

    }

    /**
     * @notice Create an agreement using a permit signature that also binds init-time verifier/action definitions.
     * @dev The permit is an EIP-712 signature by `signer` over its own address, the agreement parameters
     *      (including `verifiers_` and `actions_`), the signer's current nonce and `deadline`. Anyone may submit the transaction, but the recovered
     *      signer must match `signer` and the nonce is consumed to prevent replay.
     *
     * @param signer The address that signed the permit (and will become the agreement owner).
     * @param docUri Off-chain URI pointing to the agreement document/spec (e.g. IPFS URL).
     * @param docHash Content hash of the off-chain spec for integrity verification.
     * @param initialState Initial FSM state (also becomes `currentState` on init).
     * @param inputDefs_ Full set of input definitions accepted by this agreement.
     * @param transitions_ Full set of valid FSM transitions for this agreement.
     * @param initVars_ Initial on-chain variables to store (e.g., participant addresses, amounts).
     * @param verifiers_ Optional verifier registrations to install at initialization time.
     * @param actions_ Optional per-transition actions to pre-register; pass an empty array for none.
     * @param deadline The timestamp after which the permit is invalid.
     * @param signature Opaque EOA or ERC-1271 signature bytes.
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
        AgreementEngine.VerifierInit[] calldata verifiers_,
        AgreementEngine.ActionInit[] calldata actions_,
        uint256 deadline,
        bytes calldata signature
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
        bytes32 verifiersHash = keccak256(abi.encode(verifiers_));
        bytes32 actionsHash = keccak256(abi.encode(actions_));

        bytes32 structHash = keccak256(
            abi.encode(
                PERMIT_WITH_ACTIONS_TYPEHASH,
                signer,
                keccak256(bytes(docUri)),
                docHash,
                initialState,
                inputDefsHash,
                transitionsHash,
                initVarsHash,
                verifiersHash,
                actionsHash,
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
            verifiers_,
            actions_
        );
    }

    /**
     * @notice Create an agreement at a deterministic address using a permit signature.
     * @dev The signature binds the signer's address, all agreement parameters, the
     *      CREATE2 salt, and the exact address this factory derives for that signer
     *      and salt. A relayer cannot redirect the authorization to a different clone
     *      address, and no other account can deploy to the signer's predicted address.
     *
     * @param signer The address that signed the permit (and will become the agreement owner).
     * @param salt User-provided salt, scoped to the signer.
     * @param docUri Off-chain URI pointing to the agreement document/spec (e.g. IPFS URL).
     * @param docHash Content hash of the off-chain spec for integrity verification.
     * @param initialState Initial FSM state (also becomes `currentState` on init).
     * @param inputDefs_ Full set of input definitions accepted by this agreement.
     * @param transitions_ Full set of valid FSM transitions for this agreement.
     * @param initVars_ Initial on-chain variables to store (e.g., participant addresses, amounts).
     * @param verifiers_ Optional verifier registrations to install at initialization time.
     * @param actions_ Optional per-transition actions to pre-register; pass an empty array for none.
     * @param deadline The timestamp after which the permit is invalid.
     * @param signature Opaque EOA or ERC-1271 signature bytes.
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
        AgreementEngine.VerifierInit[] calldata verifiers_,
        AgreementEngine.ActionInit[] calldata actions_,
        uint256 deadline,
        bytes calldata signature
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
        bytes32 verifiersHash = keccak256(abi.encode(verifiers_));
        bytes32 actionsHash = keccak256(abi.encode(actions_));
        address predictedAgreement = implementation.predictDeterministicAddress(
            _creatorSalt(signer, salt),
            address(this)
        );

        bytes32 structHash = keccak256(
            abi.encode(
                DETERMINISTIC_PERMIT_WITH_ACTIONS_TYPEHASH,
                signer,
                keccak256(bytes(docUri)),
                docHash,
                initialState,
                inputDefsHash,
                transitionsHash,
                initVarsHash,
                verifiersHash,
                actionsHash,
                salt,
                predictedAgreement,
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

        // Deploy minimal proxy clone at the signer-scoped deterministic address
        agreement = implementation.cloneDeterministic(_creatorSalt(signer, salt));

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
            verifiers_,
            actions_
        );
    }

    /**
     * @notice Predict the address of a deterministic clone before deployment
     * @dev Uses the same derivation as both deterministic creation paths.
     *      Address = keccak256(0xff ++ factory ++ keccak256(abi.encode(creator, salt)) ++ keccak256(cloneBytecode))
     * @param creator The account the address is reserved for: the caller of
     *        `createAgreementDeterministic`, or the signer of a deterministic permit
     * @param salt The creator's salt
     * @return predicted The address where that creator's clone would be deployed
     */
    function predictAddress(address creator, bytes32 salt) external view returns (address predicted) {
        return implementation.predictDeterministicAddress(_creatorSalt(creator, salt), address(this));
    }

    /// @dev Scopes a user-provided salt to its creator, so that knowing a salt
    ///      does not let another account deploy to the address it predicts.
    function _creatorSalt(address creator, bytes32 salt) internal pure returns (bytes32) {
        return keccak256(abi.encode(creator, salt));
    }

}
