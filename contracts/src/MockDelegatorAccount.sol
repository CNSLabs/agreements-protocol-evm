// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.20;

/**
 * @title MockDelegatorAccount
 * @notice A minimal DeleGator-style smart account — a MODEL of MetaMask's DeleGator (NOT the audited
 *         contract). Its only job in the v3 composition trace: the trusted DelegationManager may execute
 *         a call AS this account, so the target (the AgreementEngine) sees `msg.sender == address(this)`.
 *
 * @dev This is what answers the design doc's open question — "who is msg.sender when a delegate redeems
 *      into submitInput?" On redemption the manager calls `execute(...)`, which does `target.call(data)`,
 *      so the engine's `SENDER_EQ_VAR_ADDRESS` sees this account, not the redeeming agent. On mainnet the
 *      real DeleGator (ERC-4337 smart account) drops in here.
 */
contract MockDelegatorAccount {
    address public immutable owner;
    address public immutable manager;

    error OnlyManager();

    constructor(address owner_, address manager_) {
        owner = owner_;
        manager = manager_;
    }

    /// @notice Execute a call as this account. Only the trusted manager (the DelegationManager) may call.
    function execute(address target, bytes calldata data) external returns (bytes memory) {
        if (msg.sender != manager) revert OnlyManager();
        (bool ok, bytes memory ret) = target.call(data);
        if (!ok) {
            // bubble up the target's revert reason (so the engine's SenderAddressMismatch surfaces)
            assembly {
                revert(add(ret, 0x20), mload(ret))
            }
        }
        return ret;
    }
}
