// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.20;

import "./interfaces/IInputVerifier.sol";

contract MockInputVerifier is IInputVerifier {
    function verify(
        address,
        bytes32,
        bytes calldata,
        address
    ) external pure override {}
}
