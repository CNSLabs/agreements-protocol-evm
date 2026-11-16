// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.20;

import "../AgreementEngine.sol";

/// @dev Test-only observation surface; submission behavior is inherited unchanged.
contract AgreementEngineStateHarness is AgreementEngine {
    function getStoredVar(bytes32 fieldId) external view returns (FieldType, bytes memory) {
        StoredVar storage value = vars[fieldId];
        return (value.fType, value.data);
    }
}

/// @dev Verifiers must see pre-submission storage; actions must see committed storage.
contract SubmissionValidationProbe is IInputVerifier {
    bytes32 private immutable fieldId;
    address private immutable beforeValue;
    address private immutable afterValue;
    bytes32 private immutable fromState;
    bytes32 private immutable toState;
    address private immutable expectedSender;

    bool public failVerification;
    bool public failAction;
    uint256 public actionsExecuted;

    constructor(
        bytes32 fieldId_,
        address beforeValue_,
        address afterValue_,
        bytes32 fromState_,
        bytes32 toState_,
        address expectedSender_
    ) {
        fieldId = fieldId_;
        beforeValue = beforeValue_;
        afterValue = afterValue_;
        fromState = fromState_;
        toState = toState_;
        expectedSender = expectedSender_;
    }

    function setFailures(bool verification, bool action) external {
        failVerification = verification;
        failAction = action;
    }

    function verify(address agreement, bytes32, bytes calldata, address sender) external view {
        require(sender == expectedSender, "Unexpected verifier sender");
        _checkState(agreement, beforeValue, fromState);
        require(!failVerification, "Verifier rejected");
    }

    function execute() external {
        _checkState(msg.sender, afterValue, toState);
        require(!failAction, "Action rejected");
        actionsExecuted++;
    }

    function _checkState(address agreement, address expectedValue, bytes32 expectedState) private view {
        AgreementEngineStateHarness engine = AgreementEngineStateHarness(agreement);
        (, bytes memory data) = engine.getStoredVar(fieldId);
        require(abi.decode(data, (address)) == expectedValue, "Unexpected stored authority");
        require(engine.currentState() == expectedState, "Unexpected agreement state");
    }
}
