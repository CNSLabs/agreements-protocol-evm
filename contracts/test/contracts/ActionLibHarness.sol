// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.20;

import {AgreementTypes} from "../../src/lib/AgreementTypes.sol";
import {ValueLib} from "../../src/lib/ValueLib.sol";
import {ActionLib} from "../../src/lib/ActionLib.sol";

/**
 * @title ActionLibHarness
 * @notice Test-only harness exposing ActionLib's pure composition, validation, and
 *         execution against an injected evaluation context + writable variable store.
 *         Mirrors ValueLibHarness so the action engine can be exercised directly —
 *         byte-identity of composed calldata, the no-self guard, constraint assertion,
 *         and a live call — without standing up a full agreement clone.
 */
contract ActionLibHarness {
    mapping(bytes32 => ValueLib.StoredVar) internal vars;

    address internal ctxAuthSigner;
    address internal ctxCaller;
    address internal ctxSelf;
    uint256 internal ctxTimestamp;
    bool internal ctxConfigured;

    function setVar(bytes32 id, AgreementTypes.FieldType fType, bytes calldata data) external {
        vars[id] = ValueLib.StoredVar({fType: fType, data: data});
    }

    function setContext(address authSigner, address caller, address self, uint256 timestamp)
        external
    {
        ctxAuthSigner = authSigner;
        ctxCaller = caller;
        ctxSelf = self;
        ctxTimestamp = timestamp;
        ctxConfigured = true;
    }

    /// @notice Compose calldata from selector + arg slots + pre-resolved dynamic words.
    function composeCalldata(
        bytes4 selector,
        ActionLib.ArgSlot[] calldata args,
        bytes[] calldata resolved
    ) external pure returns (bytes memory) {
        ActionLib.ArgSlot[] memory a = _toMemoryArgs(args);
        bytes[] memory r = new bytes[](resolved.length);
        for (uint256 i = 0; i < resolved.length; i++) {
            r[i] = resolved[i];
        }
        return ActionLib.composeCalldata(selector, a, r);
    }

    /// @notice Init-time structural validation of a single Call (pure).
    function validateCall(ActionLib.Call calldata c) external pure {
        ActionLib.validateCall(_toMemoryCall(c));
    }

    /// @notice Run the init-time taint analysis over encoded actions + persisted seeds (R7).
    function validateActionsTaint(
        bytes[] calldata encodedActions,
        bytes32[] calldata persistedFieldIds
    ) external pure {
        bytes[] memory ea = new bytes[](encodedActions.length);
        for (uint256 i = 0; i < encodedActions.length; i++) ea[i] = encodedActions[i];
        bytes32[] memory pf = new bytes32[](persistedFieldIds.length);
        for (uint256 i = 0; i < persistedFieldIds.length; i++) pf[i] = persistedFieldIds[i];
        ActionLib.validateActionsTaint(ea, pf);
    }

    /// @notice Compute the transitive tainted-var set (option-B fixpoint over var writes).
    function computeTaintedVars(
        bytes32[] calldata seeds,
        bytes32[] calldata writeTargets,
        AgreementTypes.ValueRef[] calldata writeSources
    ) external pure returns (bytes32[] memory) {
        bytes32[] memory s = new bytes32[](seeds.length);
        for (uint256 i = 0; i < seeds.length; i++) s[i] = seeds[i];
        bytes32[] memory wt = new bytes32[](writeTargets.length);
        for (uint256 i = 0; i < writeTargets.length; i++) wt[i] = writeTargets[i];
        AgreementTypes.ValueRef[] memory ws = new AgreementTypes.ValueRef[](writeSources.length);
        for (uint256 i = 0; i < writeSources.length; i++) ws[i] = writeSources[i];
        return ActionLib.computeTaintedVars(s, wt, ws);
    }

    /// @notice Resolve target + dynamic args, assert constraints, and execute the call.
    function executeCall(
        ActionLib.Call calldata c,
        ValueLib.Field[] calldata fields
    ) external {
        ActionLib.executeCall(_toMemoryCall(c), _ctx(fields), vars);
    }

    /// @notice Execute every call in an action in order (multi-call), with output capture.
    function executeAction(
        ActionLib.Call[] calldata calls,
        ValueLib.Field[] calldata fields
    ) external {
        ActionLib.Call[] memory m = new ActionLib.Call[](calls.length);
        for (uint256 i = 0; i < calls.length; i++) {
            m[i] = _toMemoryCall(calls[i]);
        }
        ActionLib.executeAction(ActionLib.Action({calls: m}), _ctx(fields), vars);
    }

    /// @notice Read a stored var (for asserting captured outputs).
    function getVar(bytes32 id)
        external
        view
        returns (bool set, AgreementTypes.FieldType fType, bytes memory data)
    {
        ValueLib.StoredVar storage v = vars[id];
        return (v.data.length != 0, v.fType, v.data);
    }

    function _toMemoryCall(ActionLib.Call calldata c)
        private
        pure
        returns (ActionLib.Call memory m)
    {
        m.target = c.target;
        m.selector = c.selector;
        m.args = _toMemoryArgs(c.args);
        m.constraints = new AgreementTypes.Condition[](c.constraints.length);
        for (uint256 i = 0; i < c.constraints.length; i++) {
            AgreementTypes.Condition calldata cc = c.constraints[i];
            AgreementTypes.Condition memory mc;
            mc.left = cc.left;
            mc.op = cc.op;
            mc.skipIfAbsent = cc.skipIfAbsent;
            mc.right = new AgreementTypes.ValueRef[](cc.right.length);
            for (uint256 j = 0; j < cc.right.length; j++) {
                mc.right[j] = cc.right[j];
            }
            m.constraints[i] = mc;
        }
        m.outputs = new ActionLib.Output[](c.outputs.length);
        for (uint256 i = 0; i < c.outputs.length; i++) {
            m.outputs[i] = c.outputs[i];
        }
    }

    function _ctx(ValueLib.Field[] calldata fields)
        private
        view
        returns (ValueLib.EvalContext memory)
    {
        return
            ValueLib.EvalContext({
                fields: fields,
                authSigner: ctxConfigured ? ctxAuthSigner : msg.sender,
                caller: ctxConfigured ? ctxCaller : msg.sender,
                self: ctxConfigured ? ctxSelf : address(this),
                timestamp: ctxConfigured ? ctxTimestamp : block.timestamp,
                // ActionLib pre-fills its own STATIC_CALL cache per executeCall; start empty.
                scCache: new ValueLib.StaticCallCacheEntry[](0)
            });
    }

    function _toMemoryArgs(ActionLib.ArgSlot[] calldata args)
        private
        pure
        returns (ActionLib.ArgSlot[] memory m)
    {
        m = new ActionLib.ArgSlot[](args.length);
        for (uint256 i = 0; i < args.length; i++) {
            m[i] = args[i];
        }
    }
}
