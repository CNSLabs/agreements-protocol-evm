// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

/**
 * @notice Read surface used from the ERC-8004 v2.0.0 Identity Registry.
 */
interface IERC8004IdentityRegistry {
    function ownerOf(uint256 agentId) external view returns (address);

    function getApproved(uint256 agentId) external view returns (address);

    function isApprovedForAll(address owner, address operator) external view returns (bool);

    function getAgentWallet(uint256 agentId) external view returns (address);
}

/**
 * @notice Read surface used from the ERC-8004 v2.0.0 Reputation Registry.
 */
interface IERC8004ReputationRegistry {
    function getIdentityRegistry() external view returns (address);

    function getSummary(
        uint256 agentId,
        address[] calldata clientAddresses,
        string calldata tag1,
        string calldata tag2
    ) external view returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals);
}

/**
 * @notice Read surface used from the ERC-8004 v2.0.0 Validation Registry.
 */
interface IERC8004ValidationRegistry {
    function getIdentityRegistry() external view returns (address);

    function getSummary(
        uint256 agentId,
        address[] calldata validatorAddresses,
        string calldata tag
    ) external view returns (uint64 count, uint8 avgResponse);
}
