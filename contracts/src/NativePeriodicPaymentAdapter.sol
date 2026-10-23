// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.20;

interface INativeDelegationManager {
    function redeemDelegations(
        bytes[] calldata permissionContexts,
        bytes32[] calldata modes,
        bytes[] calldata executionCallDatas
    ) external;
}

contract NativePeriodicPaymentAdapter {
    struct Caveat {
        address enforcer;
        bytes terms;
        bytes args;
    }

    struct Delegation {
        address delegate;
        address delegator;
        bytes32 authority;
        Caveat[] caveats;
        uint256 salt;
        bytes signature;
    }

    INativeDelegationManager public immutable manager;
    address public immutable subscriber;
    address public immutable payer;
    address public immutable merchant;
    uint256 public immutable periodAmount;
    uint256 public immutable startTime;
    uint256 public immutable periodDuration;

    address public agreement;
    bytes public permissionContext;
    uint256 public lastPaidThrough;

    error AgreementAlreadyBound();
    error InvalidPermissionContext();
    error NotAgreement();
    error NotSubscriber();
    error PermissionContextAlreadyInstalled();
    error PermissionContextNotInstalled();
    error RenewalNotDue(uint256 nextCollectionAt);
    error SubscriptionNotStarted();
    error ZeroAddress();
    error ZeroPeriodTerms();

    event Renewed(uint256 paidThrough, uint256 amount);

    constructor(
        address manager_,
        address subscriber_,
        address payer_,
        address merchant_,
        uint256 periodAmount_,
        uint256 startTime_,
        uint256 periodDuration_
    ) {
        if (manager_ == address(0) || subscriber_ == address(0) || payer_ == address(0) || merchant_ == address(0)) {
            revert ZeroAddress();
        }
        if (periodAmount_ == 0 || startTime_ == 0 || periodDuration_ < 2) revert ZeroPeriodTerms();

        manager = INativeDelegationManager(manager_);
        subscriber = subscriber_;
        payer = payer_;
        merchant = merchant_;
        periodAmount = periodAmount_;
        startTime = startTime_;
        periodDuration = periodDuration_;
    }

    function bindAgreement(address agreement_) external {
        if (msg.sender != subscriber) revert NotSubscriber();
        if (agreement != address(0)) revert AgreementAlreadyBound();
        if (agreement_ == address(0)) revert ZeroAddress();
        agreement = agreement_;
    }

    function installPermissionContext(bytes calldata permissionContext_) external {
        if (msg.sender != subscriber) revert NotSubscriber();
        if (permissionContext.length != 0) revert PermissionContextAlreadyInstalled();
        if (permissionContext_.length == 0) revert PermissionContextNotInstalled();
        Delegation[] memory delegations = abi.decode(permissionContext_, (Delegation[]));
        if (
            delegations.length == 0 || delegations[0].delegate != address(this)
                || delegations[delegations.length - 1].delegator != payer
        ) revert InvalidPermissionContext();
        permissionContext = permissionContext_;
    }

    function renew() external {
        if (msg.sender != agreement) revert NotAgreement();
        if (permissionContext.length == 0) revert PermissionContextNotInstalled();
        if (block.timestamp < startTime) revert SubscriptionNotStarted();

        // The final second of a term permits an on-time pull without allowing
        // two collections for that term, even if both land in one block.
        uint256 nextCollectionAt = lastPaidThrough == 0 ? 0 : lastPaidThrough - 1;
        if (lastPaidThrough != 0 && block.timestamp < nextCollectionAt) revert RenewalNotDue(nextCollectionAt);

        bytes[] memory contexts = new bytes[](1);
        contexts[0] = permissionContext;
        bytes32[] memory modes = new bytes32[](1);
        modes[0] = bytes32(0);
        bytes[] memory executions = new bytes[](1);
        executions[0] = abi.encodePacked(merchant, periodAmount, bytes(""));

        manager.redeemDelegations(contexts, modes, executions);

        uint256 paidThrough = block.timestamp < lastPaidThrough
            ? lastPaidThrough + periodDuration
            : block.timestamp + periodDuration;
        lastPaidThrough = paidThrough;
        emit Renewed(paidThrough, periodAmount);
    }
}
