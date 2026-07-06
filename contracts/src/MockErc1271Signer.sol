// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/interfaces/IERC1271.sol";

/**
 * @title MockErc1271Signer
 * @notice A minimal smart-account signer (a MODEL of a Safe / ERC-4337 account) that validates a
 *         signature via ERC-1271 by recovering it to its own EOA owner. Used to prove the delegation
 *         path works when the DELEGATOR is a smart account, not an EOA — the D-0039 gap
 *         ("the built proof-of-control can't verify smart-account wallets") for the signing leg.
 */
contract MockErc1271Signer is IERC1271 {
    bytes4 private constant MAGICVALUE = 0x1626ba7e; // IERC1271.isValidSignature.selector
    address public immutable owner;

    constructor(address owner_) {
        owner = owner_;
    }

    function isValidSignature(bytes32 hash, bytes calldata signature) external view override returns (bytes4) {
        (address recovered, ECDSA.RecoverError err, ) = ECDSA.tryRecover(hash, signature);
        if (err == ECDSA.RecoverError.NoError && recovered == owner) {
            return MAGICVALUE;
        }
        return 0xffffffff;
    }
}
