// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

/**
 * @notice Read-only authorization hook invoked before an agreement accepts an input.
 * @dev Implementations MUST revert when verification fails.
 */
interface IInputVerifier {
    /**
     * @param agreement Address of the agreement contract invoking the verifier.
     * @param inputId Logical input identifier for the submission.
     * @param payload Raw input payload.
     * @param sender Caller that submitted the input to the agreement.
     */
    function verify(
        address agreement,
        bytes32 inputId,
        bytes calldata payload,
        address sender
    ) external view;
}
