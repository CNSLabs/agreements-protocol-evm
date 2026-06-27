// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.20;

/**
 * @title MockSink
 * @notice Test target for the composable action engine. Has observable state (so a
 *         multi-call action's effects can be asserted to land) and returns typed values
 *         (so typed output capture can be asserted). No mocks-for-the-lib: ActionLib
 *         really calls this.
 */
contract MockSink {
    /// @dev Observable per-key record (proves an action's call effect landed).
    mapping(uint256 => uint256) public recorded;

    /// @dev Record `val` under `key` and return it (the call has both effect and return).
    function record(uint256 key, uint256 val) external returns (uint256) {
        recorded[key] = val;
        return val;
    }

    /// @dev Return a uint256 (for output capture of a fixed-size return word).
    function quoteUint(uint256 x) external pure returns (uint256) {
        return x + 1;
    }

    /// @dev Return an address (for output capture of an ADDRESS return word).
    function quoteAddress(address a) external pure returns (address) {
        return a;
    }

    /// @dev Return a bool (for output capture of a BOOL return word).
    function quoteBool(bool b) external pure returns (bool) {
        return b;
    }

    /// @dev Return a bytes32 (for output capture of a BYTES32 return word).
    function quoteBytes32(bytes32 b) external pure returns (bytes32) {
        return b;
    }

    /// @dev Return an arbitrary raw 32-byte word (lets a test inject a non-canonical word,
    ///      e.g. capturing a word == 2 AS a BOOL must be rejected).
    function quoteRaw(uint256 raw) external pure returns (uint256) {
        return raw;
    }

    /// @dev Record the caller and return it, so a delegatecall test can assert msg.sender
    ///      (as seen by the target) equals the agreement clone (not the library).
    address public lastCaller;

    function recordCaller() external returns (address) {
        lastCaller = msg.sender;
        return msg.sender;
    }

    /// @dev Return two words; the second is the "interesting" one (returnIndex == 1).
    function quotePair(uint256 a, uint256 b) external pure returns (uint256, uint256) {
        return (a, b);
    }

    /// @dev Return fewer than 32 bytes (malformed for a 32-byte word capture).
    function returnShort() external pure returns (bytes memory) {
        return hex"abcd"; // 2 bytes inside the dynamic payload region
    }

    /// @dev Always revert (to exercise fatal-call atomicity in a multi-call action).
    function boom() external pure {
        revert("MockSink: boom");
    }
}
