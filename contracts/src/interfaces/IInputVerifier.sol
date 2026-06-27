// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.20;

/**
 * @title IInputVerifier
 * @notice External verifier contract invoked during input submission.
 * @dev A verifier performs an additional, application-specific check on a submission
 *      and MUST revert if verification fails. It is called view-only.
 */
interface IInputVerifier {
    /**
     * @notice Verify a submission; MUST revert if verification fails.
     * @param agreement Address of the agreement clone contract.
     * @param inputId Logical input id for this submission.
     * @param payload Raw bytes passed to submitInput (e.g. abi.encode(DataField[])).
     * @param sender The msg.sender of submitInput.
     */
    function verify(
        address agreement,
        bytes32 inputId,
        bytes calldata payload,
        address sender
    ) external view;
}
