// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.20;

import {AgreementTypes} from "../../src/lib/AgreementTypes.sol";
import {ValueLib} from "../../src/lib/ValueLib.sol";

/**
 * @title ValueLibHarness
 * @notice Test-only harness exposing ValueLib's resolve/check/evaluate/validateLegality
 *         against an injected evaluation context and a writable variable store. Used to
 *         exercise the resolve/compare core directly — the full source x type x op matrix,
 *         including the IF_PRESENT presence flag and synthesized sources — without standing
 *         up a full agreement.
 * @dev The evaluation context (authSigner / caller / self / timestamp) defaults to
 *      sensible values but is overridable via `setContext`, so AUTH_SIGNER vs CALLER vs
 *      SELF vs NOW can be asserted to synthesize distinctly. No mocks: this calls the real
 *      ValueLib over a real storage mapping.
 */
contract ValueLibHarness {
    mapping(bytes32 => ValueLib.StoredVar) internal vars;

    // Overridable context (defaults applied lazily in _ctx when unset).
    address internal ctxAuthSigner;
    address internal ctxCaller;
    address internal ctxSelf;
    uint256 internal ctxTimestamp;
    bool internal ctxConfigured;

    /// @notice Set a variable in the harness store.
    function setVar(bytes32 id, AgreementTypes.FieldType fType, bytes calldata data) external {
        vars[id] = ValueLib.StoredVar({fType: fType, data: data});
    }

    /// @notice Override the evaluation context used by check/evaluate/resolve.
    function setContext(address authSigner, address caller, address self, uint256 timestamp)
        external
    {
        ctxAuthSigner = authSigner;
        ctxCaller = caller;
        ctxSelf = self;
        ctxTimestamp = timestamp;
        ctxConfigured = true;
    }

    /// @notice Evaluate a condition against the given input fields; reverts on failure.
    function check(
        AgreementTypes.Condition calldata cond,
        ValueLib.Field[] calldata fields
    ) external view {
        ValueLib.check(_toMemory(cond), _ctx(fields), vars);
    }

    /// @notice Evaluate a condition to a boolean (no revert on a false result).
    function checkBool(
        AgreementTypes.Condition calldata cond,
        ValueLib.Field[] calldata fields
    ) external view returns (bool) {
        return ValueLib.evaluate(_toMemory(cond), _ctx(fields), vars);
    }

    /**
     * @notice Evaluate a SET of conditions against ONE shared EvalContext, with the
     *         condition-path resolve-once prewarm applied first — exactly mirroring the
     *         engine's _validateConditions. Reverts on the first condition that fails.
     * @dev This is the condition/guard-path twin of ActionLib's per-call prewarm: a STATIC_CALL
     *      ref shared across two conditions is read ONCE here (via ValueLib.prewarmConditions),
     *      so every condition in the set sees the SAME (first-read) word. Used to prove a non-
     *      deterministic STATIC_CALL target cannot return different words to different conditions
     *      within one submission. The boolean array is returned (no revert) so a test can assert
     *      the per-condition outcomes are consistent.
     */
    function checkConditionsConsistent(
        AgreementTypes.Condition[] calldata conds,
        ValueLib.Field[] calldata fields
    ) external view returns (bool[] memory results) {
        ValueLib.EvalContext memory ctx = _ctx(fields);
        AgreementTypes.Condition[] memory condsMem = _toMemoryArray(conds);
        ValueLib.prewarmConditions(ctx, condsMem);
        results = new bool[](condsMem.length);
        for (uint256 i = 0; i < condsMem.length; i++) {
            results[i] = ValueLib.evaluate(condsMem[i], ctx, vars);
        }
    }

    /**
     * @notice Same as checkConditionsConsistent but WITHOUT the prewarm — a shared EvalContext
     *         whose scCache stays empty, so each condition resolves its STATIC_CALL refs
     *         independently. Exposes the pre-fix within-submit double-read behavior for contrast.
     */
    function checkConditionsNoPrewarm(
        AgreementTypes.Condition[] calldata conds,
        ValueLib.Field[] calldata fields
    ) external view returns (bool[] memory results) {
        ValueLib.EvalContext memory ctx = _ctx(fields);
        AgreementTypes.Condition[] memory condsMem = _toMemoryArray(conds);
        results = new bool[](condsMem.length);
        for (uint256 i = 0; i < condsMem.length; i++) {
            results[i] = ValueLib.evaluate(condsMem[i], ctx, vars);
        }
    }

    /// @notice Resolve a single ValueRef to (FieldType, bytes).
    function resolve(
        AgreementTypes.ValueRef calldata ref,
        ValueLib.Field[] calldata fields
    ) external view returns (AgreementTypes.FieldType, bytes memory) {
        return ValueLib.resolve(ref, _ctx(fields), vars);
    }

    /// @notice Init-time legality gate for a condition (statically-known (type, op) cell).
    function validateLegality(AgreementTypes.Condition calldata cond) external pure {
        ValueLib.validateLegality(_toMemory(cond));
    }

    /// @notice Init-time structural validation of a single ValueRef (exposed helper).
    function validateRef(AgreementTypes.ValueRef calldata ref) external pure {
        ValueLib.validateRef(ref);
    }

    /// @notice Source-derived static type of a ValueRef (exposed helper).
    function staticType(AgreementTypes.ValueRef calldata ref)
        external
        pure
        returns (AgreementTypes.FieldType)
    {
        return ValueLib.staticType(ref);
    }

    /// @dev Build the EvalContext, applying defaults if setContext was never called.
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
                scCache: new ValueLib.StaticCallCacheEntry[](0)
            });
    }

    /// @dev calldata Condition -> memory.
    function _toMemory(AgreementTypes.Condition calldata cond)
        private
        pure
        returns (AgreementTypes.Condition memory m)
    {
        m.left = cond.left;
        m.op = cond.op;
        m.skipIfAbsent = cond.skipIfAbsent;
        m.right = new AgreementTypes.ValueRef[](cond.right.length);
        for (uint256 i = 0; i < cond.right.length; i++) {
            m.right[i] = cond.right[i];
        }
    }

    /// @dev calldata Condition[] -> memory Condition[].
    function _toMemoryArray(AgreementTypes.Condition[] calldata conds)
        private
        pure
        returns (AgreementTypes.Condition[] memory m)
    {
        m = new AgreementTypes.Condition[](conds.length);
        for (uint256 i = 0; i < conds.length; i++) {
            m[i] = _toMemory(conds[i]);
        }
    }
}
