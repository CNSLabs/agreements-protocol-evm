// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.20;

import {IAgreementEngine} from "../../src/interfaces/IAgreementEngine.sol";

/**
 * @title MockReentrantTarget
 * @notice Adversarial action-call target for the R5 CEI + reentrancy spike. The engine
 *         executes a registered action via `target.call(composedCalldata)`, so when one of
 *         these functions runs, `msg.sender` is the AgreementEngine clone mid-transition —
 *         AFTER the variable overlay committed and `currentState` was set, but BEFORE the
 *         action's outputs are committed. No mocks-for-the-engine: the engine really calls
 *         this, and this really calls back into the engine.
 *
 * Two adversarial behaviors:
 *   - OBSERVE (CEI proof): call back into the engine's view getters (currentState / getVar)
 *     and record what they return. The recorded snapshot proves effects landed before the
 *     interaction (the engine is already in its committed post-transition state).
 *   - REENTER (reentrancy proof): call back into a state-mutating entry point
 *     (submitInput / submitInputWithPermit). The OZ ReentrancyGuard must revert this,
 *     which (being fatal) reverts the whole transition.
 */
contract MockReentrantTarget {
    // ---- Observed snapshot (CEI proof) ----
    bool public observed; // true once any OBSERVE function recorded a snapshot
    bytes32 public observedState; // currentState() as seen mid-action
    bool public observedVarSet; // getVar(probeVar).set as seen mid-action
    bytes public observedVarData; // getVar(probeVar).data as seen mid-action

    bytes32 public probeVar; // the var id to read back during OBSERVE

    function setProbeVar(bytes32 v) external {
        probeVar = v;
    }

    /**
     * @notice OBSERVE: read the engine's committed state back out, mid-action.
     * @dev Selector matches an action whose single word arg carries `unused` (so the action
     *      can splice in any bounded value; the value is ignored). `msg.sender` is the engine
     *      clone. Returns a uint so the action can optionally capture it as an output.
     */
    function observeState(uint256 unused) external returns (uint256) {
        observed = true;
        observedState = IAgreementEngine(msg.sender).currentState();
        (bool set, , bytes memory data) = _getVar(msg.sender, probeVar);
        observedVarSet = set;
        observedVarData = data;
        return unused;
    }

    // ---- Reentrancy attack surface (reentrancy proof) ----
    // Stored attack payload so the composed action call (a fixed selector + word args) can
    // trigger a re-entry whose arguments are arbitrary calldata bytes.
    bytes public reenterInputId; // bytes32 inputId, stored as bytes for flexibility
    bytes public reenterPayload;

    // permit re-entry params
    address public permitSigner;
    uint256 public permitDeadline;
    uint8 public permitV;
    bytes32 public permitR;
    bytes32 public permitS;

    function setReenterSubmit(bytes32 inputId, bytes calldata payload) external {
        reenterInputId = abi.encode(inputId);
        reenterPayload = payload;
    }

    function setReenterPermit(
        bytes32 inputId,
        bytes calldata payload,
        address signer,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        reenterInputId = abi.encode(inputId);
        reenterPayload = payload;
        permitSigner = signer;
        permitDeadline = deadline;
        permitV = v;
        permitR = r;
        permitS = s;
    }

    /**
     * @notice REENTER submitInput: re-enter the engine's primary mutator mid-action.
     * @dev Must revert under the engine's nonReentrant guard, reverting the whole transition.
     */
    function reenterSubmitInput(uint256 unused) external returns (uint256) {
        bytes32 inputId = abi.decode(reenterInputId, (bytes32));
        IAgreementEngine(msg.sender).submitInput(inputId, reenterPayload);
        return unused;
    }

    /**
     * @notice REENTER submitInputWithPermit: re-enter the permit mutator mid-action.
     * @dev Must revert under the engine's nonReentrant guard.
     */
    function reenterSubmitInputWithPermit(uint256 unused) external returns (uint256) {
        bytes32 inputId = abi.decode(reenterInputId, (bytes32));
        IAgreementEngine(msg.sender).submitInputWithPermit(
            permitSigner,
            inputId,
            reenterPayload,
            permitDeadline,
            permitV,
            permitR,
            permitS
        );
        return unused;
    }

    /// @dev Low-level getVar read (the engine's getVar lives on AgreementEngine, not the
    ///      IAgreementEngine surface, so call it by selector to stay interface-agnostic).
    function _getVar(address engine, bytes32 fieldId)
        private
        view
        returns (bool set, uint8 fType, bytes memory data)
    {
        (bool ok, bytes memory ret) = engine.staticcall(
            abi.encodeWithSignature("getVar(bytes32)", fieldId)
        );
        require(ok, "getVar failed");
        return abi.decode(ret, (bool, uint8, bytes));
    }
}
