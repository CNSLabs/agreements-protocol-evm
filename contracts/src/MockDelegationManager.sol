// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import "./MockDelegatorAccount.sol";

/**
 * @title MockDelegationManager
 * @notice A MODEL of MetaMask's ERC-7710 DelegationManager (NOT the audited contract). It captures the
 *         load-bearing mechanics the v3 route depends on, so the composition + gas can be traced on a devnet:
 *
 *         1. a delegate calls `redeemDelegation(...)`;
 *         2. the manager verifies the delegation SIGNATURE, the REVOCATION state, and the CAVEATS on-chain
 *            (this is the enforcement — state-changing, which is why a `view` verifier could not do it);
 *         3. the delegator's smart account then EXECUTES the authorized call, so the target (the
 *            AgreementEngine) sees `msg.sender = the account`.
 *
 * @dev The engine is UNCHANGED — the account is allow-listed via the existing `SENDER_EQ_VAR_ADDRESS`
 *      condition, and the DelegationManager gates who may cause that account to act. On mainnet the real
 *      audited `DelegationManager` + DeleGator replace these mocks; the interface shape and the msg.sender
 *      composition are the point. Caveats here are the two load-bearing ones (allowed target + selector);
 *      the real framework has ~37 caveat enforcers, which slot in the same place.
 */
contract MockDelegationManager is EIP712 {
    struct Delegation {
        address delegate; // who may redeem
        address delegator; // the account owner who signed (caveat root)
        address allowedTarget; // caveat: only this target may be called
        bytes4 allowedSelector; // caveat: only this function selector
        uint256 salt;
    }

    bytes32 private constant DELEGATION_TYPEHASH = keccak256(
        "Delegation(address delegate,address delegator,address allowedTarget,bytes4 allowedSelector,uint256 salt)"
    );

    mapping(bytes32 => bool) public disabled;

    error NotDelegate(address caller, address delegate);
    error BadSignature();
    error DelegationDisabled();
    error WrongAccountOwner();
    error SelectorNotAllowed(bytes4 got, bytes4 allowed);
    error EmptyCallData();

    event Redeemed(bytes32 indexed delegationHash, address indexed delegate, address indexed account, address target);
    event Disabled(bytes32 indexed delegationHash);

    constructor() EIP712("ShodaiDelegationManager", "1") {}

    function hashDelegation(Delegation calldata d) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(abi.encode(DELEGATION_TYPEHASH, d.delegate, d.delegator, d.allowedTarget, d.allowedSelector, d.salt))
        );
    }

    /// @notice The on-chain off-switch — only the delegator may disable their delegation (rotation/revocation).
    function disable(Delegation calldata d) external {
        require(msg.sender == d.delegator, "only delegator");
        bytes32 h = hashDelegation(d);
        disabled[h] = true;
        emit Disabled(h);
    }

    /// @notice Redeem a delegation: verify + enforce caveats on-chain, then execute AS the delegator's account.
    /// @param account The delegator's smart account (MockDelegatorAccount) that will execute the call.
    function redeemDelegation(Delegation calldata d, bytes calldata signature, address account, bytes calldata callData)
        external
        returns (bytes memory)
    {
        if (msg.sender != d.delegate) revert NotDelegate(msg.sender, d.delegate);

        bytes32 h = hashDelegation(d);
        if (disabled[h]) revert DelegationDisabled();
        // SignatureChecker validates BOTH an EOA delegator (ecrecover) AND a smart-account delegator
        // (ERC-1271 `isValidSignature` staticcall) — closes the D-0039 smart-account-signer leg.
        if (!SignatureChecker.isValidSignatureNow(d.delegator, h, signature)) revert BadSignature();
        if (MockDelegatorAccount(account).owner() != d.delegator) revert WrongAccountOwner();

        // Caveats (the load-bearing two). `allowedTarget` is both the caveat and the actual target — a
        // delegate cannot redirect the call. `allowedSelector` binds it to the authorized method.
        if (callData.length < 4) revert EmptyCallData();
        bytes4 sel = bytes4(callData[:4]);
        if (sel != d.allowedSelector) revert SelectorNotAllowed(sel, d.allowedSelector);

        // Execute AS the delegator's account → the target sees msg.sender = account.
        bytes memory ret = MockDelegatorAccount(account).execute(d.allowedTarget, callData);
        emit Redeemed(h, d.delegate, account, d.allowedTarget);
        return ret;
    }
}
