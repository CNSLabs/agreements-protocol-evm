// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.20;

import "./AgreementEngine.sol";

/**
 * @notice Minimal ERC-8004-style registry surface the on-chain authority gate reads (staticcall only).
 * @dev On mainnet the verifier points at the real ERC-8004 Identity / Reputation / Validation registries
 *      (or a thin adapter over them, and/or an EAS attestation read). This compact interface is the read
 *      surface the verifier depends on; the registry is config, not hard-coded — that is the neutral seam.
 */
interface IErc8004Registry {
    function isRegistered(address agent) external view returns (bool);
    function reputationOf(address agent) external view returns (uint256);
    function hasValidation(address agent, bytes32 validation) external view returns (bool);
}

/**
 * @title AuthorityInputVerifier (v2 — on-chain ERC-8004 / attestation authority gate)
 * @notice The ON-CHAIN twin of the off-chain `Erc8004AuthorityResolver`
 *         (cns-service a2a slice, `IAuthorityResolver`). Registered in an agreement's `verifierKeys`;
 *         the engine calls `verify()` on every `submitInput`, and — because `IInputVerifier` MUST revert
 *         on failure — an unauthorized submission REVERTS on-chain, un-bypassable by direct RPC.
 *
 * @dev This closes the gap the off-chain resolver alone could not: the off-chain resolver is a fast,
 *      advisory pre-check that a direct-RPC caller can skip; THIS verifier is enforced by the engine
 *      itself, so it cannot be skipped. It enforces the SAME predicate the off-chain resolver checks:
 *      registered + reputation floor + required validation. Two altitudes, one authority policy.
 *
 *      Keys on `sender` (= `msg.sender` of `submitInput`, per the `IInputVerifier` contract) — so the
 *      acting party submits directly. `view`-only, so it can only READ the registry (it cannot call a
 *      state-changing function such as ERC-7710 `redeemDelegations` — see the v1/v3 design doc).
 *      `minReputation == 0` disables the reputation floor; `requiredValidation == 0` disables the
 *      validation requirement. An unregistered sender always fails (fail-closed).
 */
contract AuthorityInputVerifier is IInputVerifier {
    IErc8004Registry public immutable registry;
    uint256 public immutable minReputation;
    bytes32 public immutable requiredValidation;

    error NotRegistered(address sender);
    error BelowReputation(address sender, uint256 have, uint256 need);
    error MissingValidation(address sender, bytes32 validation);

    constructor(IErc8004Registry registry_, uint256 minReputation_, bytes32 requiredValidation_) {
        registry = registry_;
        minReputation = minReputation_;
        requiredValidation = requiredValidation_;
    }

    /// @inheritdoc IInputVerifier
    function verify(
        address, /* agreement */
        bytes32, /* inputId   */
        bytes calldata, /* payload */
        address sender
    ) external view override {
        if (!registry.isRegistered(sender)) revert NotRegistered(sender);

        if (minReputation != 0) {
            uint256 rep = registry.reputationOf(sender);
            if (rep < minReputation) revert BelowReputation(sender, rep, minReputation);
        }

        if (requiredValidation != bytes32(0) && !registry.hasValidation(sender, requiredValidation)) {
            revert MissingValidation(sender, requiredValidation);
        }
    }
}
