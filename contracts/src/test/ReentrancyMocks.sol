// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.20;

/// @dev Test-only action target that calls back into the agreement that called it.
contract ReentrantActionTarget {
    bytes private reentry;
    bool private immutable swallow;
    uint256 public calls;

    /// @param reentry_ Calldata sent back to the calling agreement.
    /// @param swallow_ Whether to carry on when that call fails, or fail with its revert data.
    constructor(bytes memory reentry_, bool swallow_) {
        reentry = reentry_;
        swallow = swallow_;
    }

    fallback() external {
        calls++;
        (bool ok, bytes memory ret) = msg.sender.call(reentry);
        if (!ok && !swallow) {
            assembly ("memory-safe") {
                revert(add(ret, 32), mload(ret))
            }
        }
    }
}
