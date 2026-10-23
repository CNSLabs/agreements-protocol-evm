// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract MockNativeDelegationManager {
    receive() external payable {}

    function redeemDelegations(bytes[] calldata, bytes32[] calldata, bytes[] calldata executions) external {
        bytes calldata execution = executions[0];
        address target = address(bytes20(execution[:20]));
        uint256 value = uint256(bytes32(execution[20:52]));
        (bool success, bytes memory result) = target.call{value: value}(execution[52:]);
        if (!success) {
            assembly {
                revert(add(result, 32), mload(result))
            }
        }
    }
}
