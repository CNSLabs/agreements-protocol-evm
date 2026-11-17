// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/proxy/Clones.sol";
import "@openzeppelin/contracts/utils/Address.sol";
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
 *      Deterministic addresses are derived from the creator, the salt and the
 *      agreement's contents (see `agreementDigest`). A predicted address can only
 *      be claimed by the account it was predicted for (the caller on the direct
 *      path, the signer on the permit path), and only by the exact agreement it
 *      was predicted for: with the same creator and salt, different terms give a
 *      different address. Every permit names its signer, so a signature validated
 *      by a smart account (ERC-1271) cannot be presented for another account that
 *      accepts the same key.
 *
 *      Layout of the creation functions: each one hashes its arguments and encodes
 *      the `initialize` call first, then hands the rest (events, the call itself)
 *      to `_announceAndInitialize`. The creation functions take up to 19 stack
 *      slots of calldata arguments, which leaves the compiler almost no room; kept
 *      in this order they compile with room to spare. Interleaving other work
 *      with the argument-heavy steps brings back "stack too deep" failures that
 *      come and go with the optimizer settings and the library version.
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
    ///      derives for that signer, salt and agreement.
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
        // The clone is initialized with msg.sender as owner
        bytes memory initCall = abi.encodeCall(
            AgreementEngine.initialize,
            (msg.sender, docUri, docHash, initialState, inputDefs_, transitions_, initVars_, verifiers_, actions_)
        );

        // Deploy minimal proxy clone (~45k gas)
        agreement = implementation.clone();
        _announceAndInitialize(agreement, msg.sender, false, docUri, docHash, initCall);
    }

    /**
     * @notice Deploy a new agreement clone at a deterministic address
     * @dev The caller (msg.sender) becomes the owner. The address is derived from
     *      the caller, the salt and the agreement's contents (see `predictAddress`),
     *      so no other account, and no other agreement, can be deployed to it.
     *      Reverts if a contract already exists at that address.
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
        bytes32 cloneSalt = _cloneSalt(
            msg.sender,
            salt,
            _agreementDigest(
                _contentHashes(docUri, inputDefs_, transitions_, initVars_, verifiers_, actions_),
                docHash,
                initialState
            )
        );

        // The clone is initialized with msg.sender as owner
        bytes memory initCall = abi.encodeCall(
            AgreementEngine.initialize,
            (msg.sender, docUri, docHash, initialState, inputDefs_, transitions_, initVars_, verifiers_, actions_)
        );

        // Deploy minimal proxy clone at the deterministic address reserved for
        // this caller, salt and agreement
        agreement = implementation.cloneDeterministic(cloneSalt);
        _announceAndInitialize(agreement, msg.sender, false, docUri, docHash, initCall);
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

        // Hash the variable-length parts once to keep the signed struct manageable
        ContentHashes memory h = _contentHashes(docUri, inputDefs_, transitions_, initVars_, verifiers_, actions_);

        // The clone is initialized with signer as owner (not msg.sender)
        bytes memory initCall = abi.encodeCall(
            AgreementEngine.initialize,
            (signer, docUri, docHash, initialState, inputDefs_, transitions_, initVars_, verifiers_, actions_)
        );

        // Verify signature
        bytes32 structHash = keccak256(
            abi.encode(
                PERMIT_WITH_ACTIONS_TYPEHASH,
                signer,
                h.docUriHash,
                docHash,
                initialState,
                h.inputDefsHash,
                h.transitionsHash,
                h.initVarsHash,
                h.verifiersHash,
                h.actionsHash,
                nonces[signer],
                deadline
            )
        );
        _usePermit(signer, structHash, signature);

        // Deploy minimal proxy clone (~45k gas)
        agreement = implementation.clone();
        _announceAndInitialize(agreement, signer, true, docUri, docHash, initCall);
    }

    /**
     * @notice Create an agreement at a deterministic address using a permit signature.
     * @dev The signature binds the signer's address, all agreement parameters, the
     *      CREATE2 salt, and the exact address this factory derives for that signer,
     *      salt and agreement. A relayer cannot redirect the authorization to a
     *      different clone address, and neither another account nor another agreement
     *      can be deployed to the signer's predicted address.
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

        // Hash each part once: the same hashes feed the signed struct and the
        // digest the clone address is derived from
        ContentHashes memory h = _contentHashes(docUri, inputDefs_, transitions_, initVars_, verifiers_, actions_);

        // The clone is initialized with signer as owner (not msg.sender)
        bytes memory initCall = abi.encodeCall(
            AgreementEngine.initialize,
            (signer, docUri, docHash, initialState, inputDefs_, transitions_, initVars_, verifiers_, actions_)
        );

        bytes32 cloneSalt = _cloneSalt(signer, salt, _agreementDigest(h, docHash, initialState));

        // Verify signature
        bytes32 structHash = keccak256(
            abi.encode(
                DETERMINISTIC_PERMIT_WITH_ACTIONS_TYPEHASH,
                signer,
                h.docUriHash,
                docHash,
                initialState,
                h.inputDefsHash,
                h.transitionsHash,
                h.initVarsHash,
                h.verifiersHash,
                h.actionsHash,
                salt,
                implementation.predictDeterministicAddress(cloneSalt, address(this)),
                nonces[signer],
                deadline
            )
        );
        _usePermit(signer, structHash, signature);

        // Deploy minimal proxy clone at the deterministic address reserved for
        // this signer, salt and agreement
        agreement = implementation.cloneDeterministic(cloneSalt);
        _announceAndInitialize(agreement, signer, true, docUri, docHash, initCall);
    }

    /**
     * @notice Digest of an agreement's contents, as bound into its deterministic address
     * @dev Covers everything `initialize` receives except the owner: the document
     *      URI and hash, the initial state, and the input, transition, variable,
     *      verifier and action definitions. Changing any of them changes the digest.
     *      Pass the result to `predictAddress`.
     * @return digest The agreement's content digest
     */
    function agreementDigest(
        string calldata docUri,
        bytes32 docHash,
        bytes32 initialState,
        AgreementEngine.InputDef[] calldata inputDefs_,
        AgreementEngine.Transition[] calldata transitions_,
        AgreementEngine.DataField[] calldata initVars_,
        AgreementEngine.VerifierInit[] calldata verifiers_,
        AgreementEngine.ActionInit[] calldata actions_
    ) external pure returns (bytes32 digest) {
        return _agreementDigest(
            _contentHashes(docUri, inputDefs_, transitions_, initVars_, verifiers_, actions_),
            docHash,
            initialState
        );
    }

    /**
     * @notice Predict the address of a deterministic clone before deployment
     * @dev Uses the same derivation as both deterministic creation paths.
     *      Address = keccak256(0xff ++ factory ++ keccak256(abi.encode(creator, salt, agreementDigest)) ++ keccak256(cloneBytecode))
     * @param creator The account the address is reserved for: the caller of
     *        `createAgreementDeterministic`, or the signer of a deterministic permit
     * @param salt The creator's salt
     * @param agreementDigest_ The content digest of the agreement (see `agreementDigest`)
     * @return predicted The address where that creator's clone of that agreement would be deployed
     */
    function predictAddress(
        address creator,
        bytes32 salt,
        bytes32 agreementDigest_
    ) external view returns (address predicted) {
        return implementation.predictDeterministicAddress(
            _cloneSalt(creator, salt, agreementDigest_),
            address(this)
        );
    }

    /// @dev Emits the creation events for a freshly deployed clone, then initializes
    ///      it with the prepared `initialize` call. A revert inside `initialize` is
    ///      passed on unchanged.
    function _announceAndInitialize(
        address agreement,
        address owner_,
        bool withPermit,
        string calldata docUri,
        bytes32 docHash,
        bytes memory initCall
    ) private {
        emit AgreementDeployed(agreement, owner_, docUri, docHash);
        if (withPermit) emit AgreementCreatedWithPermit(agreement, owner_, msg.sender);

        Address.functionCall(agreement, initCall);
    }

    /// @dev Checks `signature` against the permit struct `signer` is expected to have
    ///      signed, then consumes the signer's nonce so the permit cannot be replayed.
    function _usePermit(address signer, bytes32 structHash, bytes calldata signature) private {
        if (!SignatureChecker.isValidSignatureNow(signer, _hashTypedDataV4(structHash), signature)) {
            revert InvalidSignature();
        }
        nonces[signer]++;
    }

    /// @dev Hashes of the variable-length parts of an agreement's contents.
    struct ContentHashes {
        bytes32 docUriHash;
        bytes32 inputDefsHash;
        bytes32 transitionsHash;
        bytes32 initVarsHash;
        bytes32 verifiersHash;
        bytes32 actionsHash;
    }

    function _contentHashes(
        string calldata docUri,
        AgreementEngine.InputDef[] calldata inputDefs_,
        AgreementEngine.Transition[] calldata transitions_,
        AgreementEngine.DataField[] calldata initVars_,
        AgreementEngine.VerifierInit[] calldata verifiers_,
        AgreementEngine.ActionInit[] calldata actions_
    ) internal pure returns (ContentHashes memory h) {
        h.docUriHash = keccak256(bytes(docUri));
        h.inputDefsHash = keccak256(abi.encode(inputDefs_));
        h.transitionsHash = keccak256(abi.encode(transitions_));
        h.initVarsHash = keccak256(abi.encode(initVars_));
        h.verifiersHash = keccak256(abi.encode(verifiers_));
        h.actionsHash = keccak256(abi.encode(actions_));
    }

    function _agreementDigest(
        ContentHashes memory h,
        bytes32 docHash,
        bytes32 initialState
    ) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                h.docUriHash,
                docHash,
                initialState,
                h.inputDefsHash,
                h.transitionsHash,
                h.initVarsHash,
                h.verifiersHash,
                h.actionsHash
            )
        );
    }

    /// @dev Scopes a user-provided salt to its creator and to the agreement's
    ///      contents, so that knowing a salt lets no other account deploy to the
    ///      address it predicts, and no different agreement can occupy it.
    function _cloneSalt(address creator, bytes32 salt, bytes32 agreementDigest_) internal pure returns (bytes32) {
        return keccak256(abi.encode(creator, salt, agreementDigest_));
    }

}
