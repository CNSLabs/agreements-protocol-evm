// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.20;

/// @dev A sibling contract MockStaticTarget touches to observe EIP-2929 cold/warm access
///      cost (the non-determinism primitive). `x()` selector is 0x0c55699c.
contract Warmee {
    uint256 public x = 7;
}

/**
 * @title MockStaticTarget
 * @notice Read-only target for STATIC_CALL (R6) resolution tests. Returns configurable
 *         typed words, can revert, can return more bytes than the caller will copy
 *         (return-bomb), can return fewer than 32 bytes (short), and can burn gas in a
 *         view function (gas-griefing). No mocks-for-the-lib: ValueLib really staticcalls
 *         this through the harness.
 */
contract MockStaticTarget {
    /// @dev Return a fixed uint256 (the canonical happy path for a UINT256 decode).
    function getUint() external pure returns (uint256) {
        return 42;
    }

    /// @dev Return a fixed address.
    function getAddress() external pure returns (address) {
        return address(0x000000000000000000000000000000000000bEEF);
    }

    /// @dev Return a fixed bool.
    function getBool() external pure returns (bool) {
        return true;
    }

    /// @dev Return a fixed bytes32.
    function getBytes32() external pure returns (bytes32) {
        return keccak256("static-call-r6");
    }

    /// @dev Echo back the single uint arg (proves pre-baked CONST args reach the target).
    function echoUint(uint256 x) external pure returns (uint256) {
        return x;
    }

    /// @dev Return an arbitrary raw word so a test can inject a non-canonical value
    ///      (e.g. word == 2 decoded AS a BOOL, or dirty high bytes decoded AS an ADDRESS).
    function getRaw(uint256 raw) external pure returns (uint256) {
        return raw;
    }

    /// @dev Always revert (exercise failMode REVERT / ABSENT against a reverting read).
    function boom() external pure returns (uint256) {
        revert("MockStaticTarget: boom");
    }

    /// @dev Return a large blob (a return-bomb) far bigger than the 32-byte word the caller
    ///      reads. The caller caps returndatacopy at maxReturnBytes, so it copies only the
    ///      first word regardless of how much returndata exists — a return-bomb cannot force
    ///      the caller to allocate the whole blob. 8 KiB is plainly > one word yet returns
    ///      within a sane gas stipend (the cap is on the copy, not the callee's allocation).
    function returnBomb() external pure returns (bytes memory) {
        return new bytes(8192);
    }

    /// @dev Return the leading word directly (no ABI offset framing): a giant word value.
    ///      Used to assert the first word is decoded under a tight maxReturnBytes cap.
    function getBigWord() external pure returns (uint256) {
        return type(uint256).max;
    }

    /// @dev Return fewer than 32 bytes of returndata (short return).
    function returnShort() external pure {
        assembly {
            mstore(0x00, 0xab)
            return(0x00, 2) // only 2 bytes of returndata
        }
    }

    /// @dev Burn gas in a view function (gas-griefing). Loops until nearly out of the
    ///      forwarded stipend; the caller's gas cap bounds the damage.
    function burnGas() external view returns (uint256) {
        uint256 acc;
        for (uint256 i = 0; i < type(uint256).max; i++) {
            acc += uint256(keccak256(abi.encode(acc, i, address(this))));
        }
        return acc;
    }

    // A sibling contract whose account+slot this target touches once per read, so the FIRST
    // read in a tx pays the EIP-2929 COLD access cost and every later read pays the WARM cost.
    Warmee private immutable _warmee = new Warmee();

    /// @dev True on the FIRST read in a transaction, false on every later read — observed
    ///      WITHOUT a state write (a pure `view`, callable under staticcall) via EIP-2929
    ///      access cost. It staticcalls a sibling `Warmee` and measures the gas the call
    ///      consumed: the first cross-contract access in a tx is COLD (cold account ~2600 +
    ///      cold slot ~2100), every later access is WARM (~100s). Branching on a wide
    ///      cold/warm threshold is robust under the viaIR optimizer because the `staticcall`
    ///      opcode is a barrier its gas accounting cannot be folded across. This is the TOCTOU
    ///      primitive: a value a taint constraint reads once and the real call reads again
    ///      would DIFFER between the two reads — so resolving each STATIC_CALL exactly once is
    ///      the only safe contract.
    function _isFirstRead() private view returns (bool) {
        address w = address(_warmee);
        uint256 cost;
        assembly {
            // Warmee.x() selector == 0x0c55699c.
            mstore(0x00, 0x0c55699c00000000000000000000000000000000000000000000000000000000)
            let g1 := gas()
            let ok := staticcall(gas(), w, 0x00, 0x04, 0x20, 0x20)
            let g2 := gas()
            cost := sub(g1, g2)
            if iszero(ok) {
                revert(0, 0)
            }
        }
        // Cold cross-contract access costs thousands of gas; a warm one only hundreds.
        return cost > 2000;
    }

    /// @dev Non-deterministic uint read: FIRST_VALUE on the first read in a tx, SECOND_VALUE on
    ///      every later read. Usable as a UINT256 word (and the small values are valid address
    ///      words too).
    function splitOnAccess() external view returns (uint256) {
        return _isFirstRead() ? FIRST_VALUE : SECOND_VALUE;
    }

    /// @dev Non-deterministic address read: returns `a` on the first read in a tx and `b` on
    ///      every later read (the two candidate addresses are pre-baked CONST args). A TOCTOU
    ///      target: a taint allowlist that validates the first read (`a`) but the actual call
    ///      that re-reads (`b`) would route to an UN-allowlisted address — unless the value is
    ///      resolved exactly once.
    function splitTwoAddrs(address a, address b) external view returns (address) {
        return _isFirstRead() ? a : b;
    }

    uint256 public constant FIRST_VALUE = 111;
    uint256 public constant SECOND_VALUE = 999;
}
