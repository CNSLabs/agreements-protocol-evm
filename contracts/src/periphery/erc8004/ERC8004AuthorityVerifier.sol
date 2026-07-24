// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import "../../interfaces/IInputVerifier.sol";
import "./IERC8004Registries.sol";

/**
 * @title ERC8004AuthorityVerifier
 * @notice Authorizes agreement inputs with an explicit ERC-8004 agent
 *         identity, reputation floor, and validation floor.
 * @dev This adapter only reads the official ERC-8004 v2.0.0 registry surfaces.
 *      It does not depend on a reverse account-to-agent lookup. Every accepted
 *      sender must be authorized against the configured `agentId`.
 */
contract ERC8004AuthorityVerifier is IInputVerifier {
    uint8 private constant MAX_REGISTRY_DECIMALS = 18;
    uint8 private constant MAX_VALIDATION_RESPONSE = 100;

    IERC8004IdentityRegistry public immutable identityRegistry;
    IERC8004ReputationRegistry public immutable reputationRegistry;
    IERC8004ValidationRegistry public immutable validationRegistry;

    uint256 public immutable agentId;
    int128 public immutable minReputation;
    uint8 public immutable minReputationDecimals;
    uint8 public immutable minValidationAverage;

    address[] public reputationClients;
    address[] public validationValidators;
    string public reputationTag1;
    string public reputationTag2;
    string public validationTag;

    error ZeroRegistryAddress();
    error EmptyTrustedClients();
    error EmptyTrustedValidators();
    error EmptyReputationTag();
    error EmptyValidationTag();
    error ZeroTrustAddress();
    error DuplicateTrustAddress(address account);
    error UnsupportedReputationDecimals(uint8 decimals);
    error InvalidValidationFloor(uint8 floor);
    error RegistryIdentityMismatch(address registry, address expected, address actual);
    error AgreementCallerMismatch(address caller, address agreement);
    error SenderNotAuthorized(uint256 agentId, address sender);
    error ReputationUnavailable(uint256 agentId);
    error ReputationBelowFloor(
        uint256 agentId,
        int128 value,
        uint8 valueDecimals,
        int128 floor,
        uint8 floorDecimals
    );
    error ValidationUnavailable(uint256 agentId);
    error InvalidValidationAverage(uint8 average);
    error ValidationBelowFloor(uint256 agentId, uint8 average, uint8 floor);

    constructor(
        IERC8004IdentityRegistry identityRegistry_,
        IERC8004ReputationRegistry reputationRegistry_,
        IERC8004ValidationRegistry validationRegistry_,
        uint256 agentId_,
        address[] memory reputationClients_,
        string memory reputationTag1_,
        string memory reputationTag2_,
        int128 minReputation_,
        uint8 minReputationDecimals_,
        address[] memory validationValidators_,
        string memory validationTag_,
        uint8 minValidationAverage_
    ) {
        if (
            address(identityRegistry_) == address(0) ||
            address(reputationRegistry_) == address(0) ||
            address(validationRegistry_) == address(0)
        ) {
            revert ZeroRegistryAddress();
        }
        if (reputationClients_.length == 0) revert EmptyTrustedClients();
        if (validationValidators_.length == 0) revert EmptyTrustedValidators();
        if (bytes(reputationTag1_).length == 0) revert EmptyReputationTag();
        if (bytes(validationTag_).length == 0) revert EmptyValidationTag();
        if (minReputationDecimals_ > MAX_REGISTRY_DECIMALS) {
            revert UnsupportedReputationDecimals(minReputationDecimals_);
        }
        if (minValidationAverage_ > MAX_VALIDATION_RESPONSE) {
            revert InvalidValidationFloor(minValidationAverage_);
        }

        identityRegistry = identityRegistry_;
        reputationRegistry = reputationRegistry_;
        validationRegistry = validationRegistry_;
        agentId = agentId_;
        minReputation = minReputation_;
        minReputationDecimals = minReputationDecimals_;
        minValidationAverage = minValidationAverage_;
        reputationTag1 = reputationTag1_;
        reputationTag2 = reputationTag2_;
        validationTag = validationTag_;

        _storeTrustList(reputationClients_, reputationClients);
        _storeTrustList(validationValidators_, validationValidators);
        _assertRegistryLinks();
    }

    /**
     * @inheritdoc IInputVerifier
     */
    function verify(
        address agreement,
        bytes32, /* inputId */
        bytes calldata, /* payload */
        address sender
    ) external view override {
        if (agreement == address(0) || msg.sender != agreement) {
            revert AgreementCallerMismatch(msg.sender, agreement);
        }
        _assertRegistryLinks();
        _assertAuthorizedSender(sender);
        _assertReputation();
        _assertValidation();
    }

    function reputationClientCount() external view returns (uint256) {
        return reputationClients.length;
    }

    function validationValidatorCount() external view returns (uint256) {
        return validationValidators.length;
    }

    function _assertRegistryLinks() private view {
        address expected = address(identityRegistry);
        address reputationIdentity = reputationRegistry.getIdentityRegistry();
        if (reputationIdentity != expected) {
            revert RegistryIdentityMismatch(address(reputationRegistry), expected, reputationIdentity);
        }

        address validationIdentity = validationRegistry.getIdentityRegistry();
        if (validationIdentity != expected) {
            revert RegistryIdentityMismatch(address(validationRegistry), expected, validationIdentity);
        }
    }

    function _assertAuthorizedSender(address sender) private view {
        if (sender == address(0)) revert SenderNotAuthorized(agentId, sender);

        address owner = identityRegistry.ownerOf(agentId);
        bool authorized = sender == owner;

        if (!authorized) {
            authorized = identityRegistry.getApproved(agentId) == sender;
        }
        if (!authorized) {
            authorized = identityRegistry.isApprovedForAll(owner, sender);
        }
        if (!authorized) {
            address wallet = identityRegistry.getAgentWallet(agentId);
            authorized = wallet != address(0) && wallet == sender;
        }

        if (!authorized) revert SenderNotAuthorized(agentId, sender);
    }

    function _assertReputation() private view {
        (uint64 count, int128 value, uint8 valueDecimals) = reputationRegistry.getSummary(
            agentId,
            reputationClients,
            reputationTag1,
            reputationTag2
        );

        if (count == 0) revert ReputationUnavailable(agentId);
        if (valueDecimals > MAX_REGISTRY_DECIMALS) {
            revert UnsupportedReputationDecimals(valueDecimals);
        }

        int256 normalizedValue = _scaleToRegistryPrecision(value, valueDecimals);
        int256 normalizedFloor = _scaleToRegistryPrecision(minReputation, minReputationDecimals);
        if (normalizedValue < normalizedFloor) {
            revert ReputationBelowFloor(
                agentId,
                value,
                valueDecimals,
                minReputation,
                minReputationDecimals
            );
        }
    }

    function _assertValidation() private view {
        (uint64 count, uint8 average) = validationRegistry.getSummary(
            agentId,
            validationValidators,
            validationTag
        );

        if (count == 0) revert ValidationUnavailable(agentId);
        if (average > MAX_VALIDATION_RESPONSE) revert InvalidValidationAverage(average);
        if (average < minValidationAverage) {
            revert ValidationBelowFloor(agentId, average, minValidationAverage);
        }
    }

    function _scaleToRegistryPrecision(
        int128 value,
        uint8 valueDecimals
    ) private pure returns (int256) {
        uint256 scale = 10 ** uint256(MAX_REGISTRY_DECIMALS - valueDecimals);
        return int256(value) * int256(scale);
    }

    function _storeTrustList(address[] memory source, address[] storage target) private {
        for (uint256 i; i < source.length; i++) {
            address account = source[i];
            if (account == address(0)) revert ZeroTrustAddress();

            for (uint256 j; j < i; j++) {
                if (source[j] == account) revert DuplicateTrustAddress(account);
            }
            target.push(account);
        }
    }
}
