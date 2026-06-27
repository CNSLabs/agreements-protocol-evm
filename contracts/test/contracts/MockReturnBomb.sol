// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.20;

/**
 * @title MockReturnBomb
 * @notice Adversarial action target for the return-bomb DoS (Codex M-02 / pashov #2).
 *         A malicious/compromised/author-chosen call target can return a multi-megabyte
 *         blob, or revert with huge revert data, to exhaust gas during a counterparty's
 *         submitInput when ActionLib copied the WHOLE returndata before bounds-checking.
 *         ActionLib's bounded returndata copy (copies only `32*(maxReturnIndex+1)` on
 *         success, `MAX_REVERT_BYTES` on revert) must keep the damage bounded regardless
 *         of how much returndata this target produces. No mocks-for-the-lib: ActionLib
 *         really calls this.
 */
contract MockReturnBomb {
    /// @dev Succeed but return a colossal raw returndata blob (no ABI framing). The first
    ///      word is `firstWord` so a low-index output capture still sees a real value; the
    ///      remaining `extraWords` words are filler the caller must NOT be forced to copy.
    function bomb(bytes32 firstWord, uint256 extraWords) external pure returns (uint256) {
        assembly {
            mstore(0x00, firstWord)
            let total := mul(add(extraWords, 1), 0x20)
            // Fill the filler region (zeros) so returndatasize() == total.
            return(0x00, total)
        }
        return 0; // unreachable; silences the unused-return warning
    }

    /// @dev Revert carrying a colossal revert-data blob (`words` 32-byte words). ActionLib
    ///      must cap the revert data it carries in CallReverted to MAX_REVERT_BYTES.
    function boom(uint256 words) external pure {
        assembly {
            let total := mul(words, 0x20)
            revert(0x00, total)
        }
    }
}
