// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.20;

import "./AgreementEngine.sol";

contract MockInputVerifier is IInputVerifier {
    function verify(
        address,
        bytes32,
        bytes calldata,
        address
    ) external pure override {}
}

contract ExpectedSenderInputVerifier is IInputVerifier {
    error UnexpectedSender(address actual, address expected);

    address public immutable expectedSender;

    constructor(address expectedSender_) {
        expectedSender = expectedSender_;
    }

    function verify(
        address,
        bytes32,
        bytes calldata,
        address sender
    ) external view override {
        if (sender != expectedSender) {
            revert UnexpectedSender(sender, expectedSender);
        }
    }
}
