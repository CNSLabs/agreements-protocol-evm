// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.20;

/// @dev Test-only smart account whose ERC-1271 check misbehaves in one chosen way.
///      None of the modes is a valid approval, so a permit naming this account
///      must be refused whatever signature accompanies it.
contract MisbehavingERC1271Signer {
    enum Mode {
        Revert, // the check reverts
        EmptyReturn, // the check succeeds and returns nothing
        ShortMagic, // the ERC-1271 magic value in 4 bytes, not padded to a word
        BooleanTrue // a 32-byte `true` instead of the magic value
    }

    Mode private immutable mode;

    constructor(Mode mode_) {
        mode = mode_;
    }

    function isValidSignature(bytes32, bytes calldata) external view returns (bytes4) {
        Mode mode_ = mode;
        if (mode_ == Mode.Revert) revert("signature check unavailable");
        if (mode_ == Mode.EmptyReturn) {
            assembly {
                return(0, 0)
            }
        }
        if (mode_ == Mode.ShortMagic) {
            assembly {
                mstore(0, 0x1626ba7e00000000000000000000000000000000000000000000000000000000)
                return(0, 4)
            }
        }
        assembly {
            mstore(0, 1)
            return(0, 32)
        }
    }
}
