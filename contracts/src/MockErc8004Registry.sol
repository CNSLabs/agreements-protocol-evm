// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.20;

import "./AuthorityInputVerifier.sol"; // IErc8004Registry

/**
 * @title MockErc8004Registry
 * @notice A minimal, permissionless ERC-8004-style registry for the on-chain-authority devnet trace.
 * @dev NOT production. On mainnet the `AuthorityInputVerifier` points at the real ERC-8004 registries
 *      (or an EAS-backed adapter). This exists so the trace can register / attest / revoke and show the
 *      engine revert-or-pass on-chain deterministically.
 */
contract MockErc8004Registry is IErc8004Registry {
    mapping(address => bool) public registered;
    mapping(address => uint256) public reputation;
    mapping(address => mapping(bytes32 => bool)) public validations;

    function register(address agent, uint256 rep) external {
        registered[agent] = true;
        reputation[agent] = rep;
    }

    function setReputation(address agent, uint256 rep) external {
        reputation[agent] = rep;
    }

    function addValidation(address agent, bytes32 validation) external {
        validations[agent][validation] = true;
    }

    function revoke(address agent) external {
        registered[agent] = false;
    }

    function isRegistered(address agent) external view override returns (bool) {
        return registered[agent];
    }

    function reputationOf(address agent) external view override returns (uint256) {
        return reputation[agent];
    }

    function hasValidation(address agent, bytes32 validation) external view override returns (bool) {
        return validations[agent][validation];
    }
}
