// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.20;

import {AgreementTypes} from "./AgreementTypes.sol";
import {ValueLib} from "./ValueLib.sol";

/**
 * @title ActionLib
 * @notice Composable action engine: compose call data by typed argument index,
 *         assert constraints, and execute outward calls. Stateless; operates on a
 *         passed-in evaluation context and the engine's variable store.
 * @dev The action engine: multi-call execution (calls run in order, atomic — any call
 *      reverting reverts the whole transition) and typed output capture into an
 *      action-output overlay that commits to storage only after all calls succeed.
 *
 *      Deferred (designed-for, not built): intra-action chaining (a later call's arg
 *      referencing an earlier call's captured output). That would require threading the
 *      in-memory action-output overlay through ValueLib's frozen EvalContext + a new
 *      ValueSource resolve branch — a change to the frozen resolve interface and a
 *      coupling of the action-agnostic ValueLib core to ActionLib's transient state — so
 *      it is deferred. The cross-transition equivalent (capture a value, branch a
 *      follow-up transition on it via a canonical condition) is fully supported today.
 *      Also still deferred: non-fatal calls / act-then-route.
 */
library ActionLib {
    // ------------------------------------------------------------------
    // Data model
    // ------------------------------------------------------------------

    /// @dev An action is a sequence of calls bound to a transition.
    struct Action {
        Call[] calls;
    }

    /**
     * @dev One outward call composed at execution time.
     *      - `target` resolves via ValueLib; MUST NOT resolve to address(this).
     *      - `selector` is fixed at creation and never substitutable.
     *      - `args` are ordered fixed-size (word) argument slots.
     *      - `constraints` are asserted on resolved values before the call (fatal).
     *      - `outputs` are the typed return-data capture spec (executed in the follow-up).
     */
    struct Call {
        AgreementTypes.ValueRef target;
        bytes4 selector;
        ArgSlot[] args;
        AgreementTypes.Condition[] constraints;
        Output[] outputs;
    }

    /**
     * @dev A single fixed-size (word) argument slot. Either a baked constant word
     *      (`dynamic == false`, value = `constWord`) or a runtime substitution
     *      (`dynamic == true`, resolved from `value` via ValueLib into a canonical
     *      32-byte word). Dynamic-type args (string/bytes/array) are never a runtime
     *      substitution — they exist only as pre-baked constant template words.
     */
    struct ArgSlot {
        bool dynamic;
        bytes32 constWord;
        AgreementTypes.ValueRef value;
    }

    /// @dev Typed return-data capture (executed in the deferred follow-up).
    struct Output {
        uint256 returnIndex;
        AgreementTypes.FieldType outType;
        bytes32 targetVar;
    }

    // ------------------------------------------------------------------
    // Errors
    // ------------------------------------------------------------------

    error SelfCallRejected(); // a resolved target equal to address(this)
    error ConstraintFailed(uint256 index); // a Call.constraints[index] evaluated false
    error CallReverted(address target, bytes revertData); // a fatal call reverted
    error NonWordArg(AgreementTypes.FieldType vType); // a dynamic arg slot is not a fixed-size word type
    error ResolvedArityMismatch(uint256 expected, uint256 actual); // resolved-words count != args count
    error NonWordResolved(uint256 argIndex, uint256 length); // a dynamic slot's resolved word is not 32 bytes
    error ReturnWordOutOfRange(uint256 returnIndex, uint256 returnLength); // captured word past return data
    error NonWordOutput(AgreementTypes.FieldType outType); // capture decode type is not a fixed-size word
    error NonAddressTarget(AgreementTypes.FieldType vType); // target ref does not resolve to ADDRESS
    error UnconstrainedTaintedTarget(uint256 callIndex); // a tainted target lacks an IN allowlist over non-tainted operands
    error UnconstrainedTaintedArg(uint256 callIndex, uint256 argIndex); // a tainted dynamic arg lacks a bound over non-tainted operands
    // The init-time bounded-evaluation cap error is AgreementTypes.ConfigCapExceeded (shared
    // across the engine, ValueLib, and ActionLib so every cap raises one decodable shape).

    // ------------------------------------------------------------------
    // Init-time bounded-evaluation caps (spec §13) — ACTION components.
    //
    // An action's calls / args / constraints / outputs are all walked or evaluated at
    // submit time (executeAction iterates calls; each executeCall resolves every arg,
    // asserts every constraint, and captures every output). These caps bound that
    // submit-time work so a griefing config author cannot author an action that gas-bombs a
    // counterparty's submitInput. Enforced AT INIT in the structural validation pass
    // (validateCall, run from validateAndAnalyzeActions on every call of every action),
    // raising AgreementTypes.ConfigCapExceeded. Generous for legitimate actions; TUNABLE.
    // ------------------------------------------------------------------

    uint256 internal constant MAX_CALLS_PER_ACTION = 16;
    uint256 internal constant MAX_ARGS_PER_CALL = 16;
    uint256 internal constant MAX_CONSTRAINTS_PER_CALL = 32;
    uint256 internal constant MAX_OUTPUTS_PER_CALL = 8;

    // The highest 32-byte return-word index an Output may capture. This bounds the returndata
    // a call can ever NEED — `32 * (MAX_RETURN_WORD_INDEX + 1)` bytes — so executeCall's
    // returndata copy is statically capped and a target cannot return-bomb a counterparty's
    // submitInput by returning (or reverting with) a multi-megabyte blob. 31 -> 32 words ->
    // 1024 bytes, generous for a legitimate ABI return (a function returning a large
    // tuple/struct lands well under this). Derived from the existing `outputs`, NOT an
    // author-facing field. TUNABLE.
    uint256 internal constant MAX_RETURN_WORD_INDEX = 31;

    // The maximum revert-data bytes carried in CallReverted on a failed call. A reverting
    // target's revert data is attacker-chosen, so it is bounded here too — only the first
    // MAX_REVERT_BYTES are copied, enough to surface a real custom-error/selector for
    // diagnosis without letting the revert-data variant of the bomb exhaust gas. TUNABLE.
    uint256 internal constant MAX_REVERT_BYTES = 256;

    /// @dev Revert ConfigCapExceeded if `got` exceeds `max`. `what` is the literal cap name.
    function _capCheck(bytes32 what, uint256 got, uint256 max) private pure {
        if (got > max) revert AgreementTypes.ConfigCapExceeded(what, got, max);
    }

    // ------------------------------------------------------------------
    // composeCalldata
    // ------------------------------------------------------------------

    /**
     * @notice Compose `selector ++ encoded fixed-size arg words`, substituting each
     *         dynamic ArgSlot by argument index with a pre-resolved canonical word.
     * @dev Composition is by typed argument index, not raw offset: each arg slot
     *      occupies exactly one disjoint 32-byte word at `4 + 32*i`, so substitutions
     *      can never overlap and the selector (bytes 0..3) is never substitutable.
     *
     *      For a dynamic slot, the engine passes the canonical 32-byte word produced by
     *      ValueLib.resolve (fixed-width types resolve to exactly one word); a non-32-byte
     *      resolved value is rejected (NonWordResolved) — dynamic-type (string/bytes/array)
     *      values can never be a runtime substitution. For a baked slot, `constWord` is
     *      copied verbatim. The result is byte-identical to
     *      abi.encodeWithSelector(selector, ...finalWords).
     *
     * @param selector    The 4-byte function selector (fixed; never substitutable).
     * @param args        Ordered fixed-size (word) argument slots.
     * @param resolved    Per-arg resolved canonical words; consulted only for dynamic
     *                    slots (a non-dynamic entry may be empty). Length must equal args.
     */
    function composeCalldata(
        bytes4 selector,
        ArgSlot[] memory args,
        bytes[] memory resolved
    ) internal pure returns (bytes memory) {
        if (resolved.length != args.length) {
            revert ResolvedArityMismatch(args.length, resolved.length);
        }

        // selector (4 bytes) + one 32-byte word per argument index.
        bytes memory out = new bytes(4 + 32 * args.length);

        // Write the selector into bytes 0..3. The selector lives outside the arg-word
        // region, so no arg substitution can ever land on it.
        out[0] = selector[0];
        out[1] = selector[1];
        out[2] = selector[2];
        out[3] = selector[3];

        for (uint256 i = 0; i < args.length; i++) {
            bytes32 word;
            if (args[i].dynamic) {
                bytes memory rw = resolved[i];
                // A substitution must be exactly one fixed-size word. A dynamic-TYPE
                // value (string/bytes/array) resolves to a non-32-byte (or pointer)
                // encoding and is rejected here — only word-sized values substitute.
                if (rw.length != 32) revert NonWordResolved(i, rw.length);
                assembly {
                    word := mload(add(rw, 0x20))
                }
            } else {
                word = args[i].constWord;
            }
            // Arg i occupies the disjoint word at byte 4 + 32*i.
            uint256 dst = 4 + 32 * i;
            assembly {
                mstore(add(add(out, 0x20), dst), word)
            }
        }

        return out;
    }

    // ------------------------------------------------------------------
    // validateCall
    // ------------------------------------------------------------------

    /**
     * @notice Init-time structural validation of a single Call (pure).
     * @dev Enforced here (the rest is structural by construction):
     *      - selector is non-substitutable — it is a fixed `bytes4` field, not an arg
     *        word, so no substitution can ever reach it (no offset arithmetic exists);
     *      - substitutions land only on fixed-size WORD args — a dynamic ArgSlot whose
     *        declared type is dynamic (STRING/BYTES) is rejected (NonWordArg), so a
     *        dynamic-type value can never be a runtime substitution;
     *      - no two substitutions overlap — each arg index owns one disjoint 32-byte
     *        word at 4 + 32*i, so overlap is impossible by construction;
     *      - the target ref is structurally valid (canonical CONST bytes, decodable ids,
     *        legal source) via ValueLib.validateRef, and its source-derived type is ADDRESS
     *        (NonAddressTarget otherwise) — the same ref gate condition operands get;
     *      - every dynamic arg's value ref is validated by ValueLib.validateRef (firing the
     *        canonical CONST check, rejecting malformed VAR/FIELD ids, and validating a
     *        STATIC_CALL spec) and its source-derived type must be a fixed-size word
     *        (NonWordArg otherwise);
     *      - constraints are legal (type, op) cells via ValueLib.validateLegality.
     */
    function validateCall(Call memory c) internal pure {
        // Bounded-evaluation caps: a submit resolves every arg, asserts every constraint, and
        // captures every output of this call, so each is bounded at init.
        _capCheck("MAX_ARGS_PER_CALL", c.args.length, MAX_ARGS_PER_CALL);
        _capCheck("MAX_CONSTRAINTS_PER_CALL", c.constraints.length, MAX_CONSTRAINTS_PER_CALL);
        _capCheck("MAX_OUTPUTS_PER_CALL", c.outputs.length, MAX_OUTPUTS_PER_CALL);

        // Target: same init-time ref gate as a condition operand, and it must be an ADDRESS.
        ValueLib.validateRef(c.target);
        if (ValueLib.staticType(c.target) != AgreementTypes.FieldType.ADDRESS) {
            revert NonAddressTarget(c.target.vType);
        }

        for (uint256 i = 0; i < c.args.length; i++) {
            if (c.args[i].dynamic) {
                // A dynamic arg's value ref gets the full init-time gate (canonical CONST
                // bytes, decodable VAR/FIELD ids, a validated STATIC_CALL spec), and its
                // source-derived type must be a fixed-size word (rejects STRING/BYTES).
                ValueLib.validateRef(c.args[i].value);
                if (!_isWordType(ValueLib.staticType(c.args[i].value))) {
                    revert NonWordArg(c.args[i].value.vType);
                }
            }
        }
        for (uint256 i = 0; i < c.constraints.length; i++) {
            ValueLib.validateLegality(c.constraints[i]);
        }
        // Outputs may only decode to a fixed-size word type (dynamic STRING/BYTES cannot
        // be captured from a return word) — reject a bad outType at init, not first run.
        // The return-word index is also capped so the returndata a call can ever need
        // (32 * (returnIndex + 1)) is statically bounded — executeCall copies only that
        // many bytes, so a return-bomb target cannot exhaust a counterparty's submit.
        for (uint256 i = 0; i < c.outputs.length; i++) {
            if (!_isWordType(c.outputs[i].outType)) {
                revert NonWordOutput(c.outputs[i].outType);
            }
            _capCheck("MAX_RETURN_WORD_INDEX", c.outputs[i].returnIndex, MAX_RETURN_WORD_INDEX);
        }
    }

    // ------------------------------------------------------------------
    // Taint analysis (R7) — mandatory init-time constraints on tainted components
    //
    // A call component is "tainted" if a submitting party can influence its value.
    // Computed once at init over the whole static config (no runtime cost):
    //   - DIRECT taint sources: FIELD, FIELD_LENGTH, CALLER, AUTH_SIGNER, STATIC_CALL.
    //     (STATIC_CALL (R6) reads untrusted external data, so it is a direct taint source.)
    //     Not tainted: CONST, SELF, NOW. A VAR is tainted iff its var id is in the
    //     tainted-var set (below).
    //   - VAR taint (the seed set, option B): a var is tainted if a tainted value can be
    //     written into it. The writers that exist in the current config are: an
    //     InputFieldDef with persist=true (writes a submitted FIELD into vars[fieldId])
    //     and an action Output (captures an external return into its targetVar). Both are
    //     unconditional taint seeds. The engine passes the persisted field ids as
    //     `seedTaintedVars`; output target vars are derived here from the actions.
    //
    // Requirement (reject at init if violated):
    //   - a tainted TARGET must be pinned by an IN constraint whose left equals the target
    //     and whose set operands are ALL non-tainted (CONST / non-tainted VAR / SELF);
    //   - each tainted dynamic ARG must be FULLY bounded by constraints whose left equals
    //     the arg's value, with non-tainted operands: an EQ, an IN, or a TWO-SIDED range
    //     (at least one upper op LTE/LT AND at least one lower op GTE/GT). A lone one-sided
    //     ordered op does NOT bound — e.g. `amount GTE 1` leaves amount unbounded above, so
    //     a huge transferFrom amount would slip through; the engine cannot infer which side
    //     is security-critical for an arbitrary arg, so one-sided is unsound and rejected.
    //   - In both cases a bound against ANOTHER tainted value (e.g. recipient EQ CALLER, or
    //     amount LTE FIELD(other)) does NOT count — the bounding operand(s) must be
    //     non-tainted. NEQ / NOT_IN never bound (they exclude points, not constrain a range).
    //
    // Soundness note (deliberate simplification): the bound is matched by exact
    // ValueRef equality (source + vType + keccak256(data)) between a constraint's `left`
    // and the component's ref. This is a SOUND subset — it never accepts a weak bound —
    // but it is conservative: a constraint that bounds the same value expressed through a
    // different (but equivalent) ref shape would not be recognized and the agreement is
    // rejected (a false reject, never a false accept). E.g. a constraint on FIELD(id) does
    // not credit an arg VAR(id) after persist — authors must bound the arg's EXACT ref.
    // ------------------------------------------------------------------

    /// @dev True if a ref's value can be influenced by the submitter directly (not via a
    ///      var). FIELD / FIELD_LENGTH / CALLER / AUTH_SIGNER are submitter-influenced, and
    ///      STATIC_CALL (R6) reads untrusted external data — so a STATIC_CALL result used as
    ///      a target needs an IN allowlist over non-tainted operands, and used as a dynamic
    ///      arg needs a full EQ/IN/two-sided bound, exactly like FIELD.
    function _isDirectTaintSource(AgreementTypes.ValueSource s) private pure returns (bool) {
        return
            s == AgreementTypes.ValueSource.FIELD ||
            s == AgreementTypes.ValueSource.FIELD_LENGTH ||
            s == AgreementTypes.ValueSource.CALLER ||
            s == AgreementTypes.ValueSource.AUTH_SIGNER ||
            s == AgreementTypes.ValueSource.STATIC_CALL;
    }

    /// @dev True if a resolved component ref is tainted: a direct taint source, or a VAR
    ///      whose id is in the tainted-var set.
    function _isTainted(AgreementTypes.ValueRef memory ref, bytes32[] memory taintedVars)
        private
        pure
        returns (bool)
    {
        if (_isDirectTaintSource(ref.source)) return true;
        if (ref.source == AgreementTypes.ValueSource.VAR) {
            bytes32 varId = abi.decode(ref.data, (bytes32));
            return _containsPrefix(taintedVars, taintedVars.length, varId);
        }
        return false;
    }

    /// @dev Exact ValueRef equality (source + vType + data), used to match a constraint's
    ///      left operand to the exact component (target / arg value) it must bound.
    function _refEquals(AgreementTypes.ValueRef memory a, AgreementTypes.ValueRef memory b)
        private
        pure
        returns (bool)
    {
        return
            a.source == b.source &&
            a.vType == b.vType &&
            keccak256(a.data) == keccak256(b.data);
    }

    /// @dev True if every operand in `refs` is non-tainted (a real bound's operands).
    function _allNonTainted(
        AgreementTypes.ValueRef[] memory refs,
        bytes32[] memory taintedVars
    ) private pure returns (bool) {
        for (uint256 i = 0; i < refs.length; i++) {
            if (_isTainted(refs[i], taintedVars)) return false;
        }
        return true;
    }

    /// @dev True if some constraint pins `target` to a non-tainted membership allowlist:
    ///      its left ref equals `target`, its op is IN, and every set operand is
    ///      non-tainted. A target is only ever bounded by an IN allowlist (membership) —
    ///      ordered/EQ bounds do not make sense for routing a call to a contract.
    function _targetBounded(
        AgreementTypes.ValueRef memory target,
        AgreementTypes.Condition[] memory constraints,
        bytes32[] memory taintedVars
    ) private pure returns (bool) {
        for (uint256 i = 0; i < constraints.length; i++) {
            AgreementTypes.Condition memory cn = constraints[i];
            if (cn.op != AgreementTypes.CmpOp.IN) continue;
            if (!_refEquals(cn.left, target)) continue;
            // An empty IN set constrains nothing (`IN []` is vacuously false), so it never
            // bounds a tainted target — skip it, fall through to UnconstrainedTaintedTarget.
            if (cn.right.length == 0) continue;
            if (_allNonTainted(cn.right, taintedVars)) return true;
        }
        return false;
    }

    /// @dev True if the constraints fully bound a tainted `arg` against non-tainted
    ///      operands. A single one-sided ordered op (a lone LTE/LT or GTE/GT) is NOT a
    ///      bound — it leaves the other side submitter-controlled, and the engine cannot
    ///      know which side is security-critical. So `arg` is bounded iff, across all
    ///      constraints whose left ref equals `arg` AND whose operands are all non-tainted,
    ///      the ops present include EQ, or IN, or BOTH an upper op (LTE/LT) AND a lower op
    ///      (GTE/GT). NEQ / NOT_IN never bound (they exclude points, not constrain a range).
    function _argBounded(
        AgreementTypes.ValueRef memory arg,
        AgreementTypes.Condition[] memory constraints,
        bytes32[] memory taintedVars
    ) private pure returns (bool) {
        bool hasUpper; // a real LTE / LT
        bool hasLower; // a real GTE / GT
        for (uint256 i = 0; i < constraints.length; i++) {
            AgreementTypes.Condition memory cn = constraints[i];
            if (!_refEquals(cn.left, arg)) continue;
            // Only constraints whose bounding operand(s) are all non-tainted count — a
            // bound against another tainted value (e.g. amount LTE FIELD(other)) is not real.
            if (!_allNonTainted(cn.right, taintedVars)) continue;

            if (cn.op == AgreementTypes.CmpOp.EQ) {
                return true; // a single point fully bounds the value.
            }
            // A non-empty IN membership set fully bounds the value; an empty `IN []` set is
            // vacuously false (constrains nothing), so it is not a bound — skip it.
            if (cn.op == AgreementTypes.CmpOp.IN && cn.right.length != 0) {
                return true;
            }
            if (cn.op == AgreementTypes.CmpOp.LTE || cn.op == AgreementTypes.CmpOp.LT) {
                hasUpper = true;
            } else if (cn.op == AgreementTypes.CmpOp.GTE || cn.op == AgreementTypes.CmpOp.GT) {
                hasLower = true;
            }
            // NEQ / NOT_IN: not a bound; ignored.
            if (hasUpper && hasLower) return true; // a two-sided range fully bounds it.
        }
        return false;
    }

    /**
     * @notice Taint-analyze every call in one action against the tainted-var set (pure).
     * @dev Reverts UnconstrainedTaintedTarget / UnconstrainedTaintedArg on the first
     *      tainted-and-unbounded component. The tainted-var set must already include this
     *      action's output target vars (the caller unions them in across all actions, so
     *      a var captured by a later call's output taints earlier uses too).
     */
    function _analyzeCallsTaint(Call[] memory calls, bytes32[] memory taintedVars)
        private
        pure
    {
        for (uint256 i = 0; i < calls.length; i++) {
            Call memory c = calls[i];

            // Tainted target requires a membership (IN) allowlist over non-tainted operands.
            if (_isTainted(c.target, taintedVars)) {
                if (!_targetBounded(c.target, c.constraints, taintedVars)) {
                    revert UnconstrainedTaintedTarget(i);
                }
            }

            // Each tainted dynamic arg requires a FULL bound (EQ / IN / two-sided range)
            // over non-tainted operands — a lone one-sided ordered op does not count.
            for (uint256 j = 0; j < c.args.length; j++) {
                if (!c.args[j].dynamic) continue;
                if (!_isTainted(c.args[j].value, taintedVars)) continue;
                if (!_argBounded(c.args[j].value, c.constraints, taintedVars)) {
                    revert UnconstrainedTaintedArg(i, j);
                }
            }
        }
    }

    /// @dev Whether the first `len` entries of `set` contain `id` (linear; sets are
    ///      init-time and small/bounded). A fully-populated array passes `len = set.length`;
    ///      a partially-filled buffer passes its populated prefix length.
    function _containsPrefix(bytes32[] memory set, uint256 len, bytes32 id)
        private
        pure
        returns (bool)
    {
        for (uint256 i = 0; i < len; i++) {
            if (set[i] == id) return true;
        }
        return false;
    }

    /// @dev The fixed-size (single 32-byte word) value types eligible for substitution.
    function _isWordType(AgreementTypes.FieldType t) private pure returns (bool) {
        return
            t == AgreementTypes.FieldType.UINT256 ||
            t == AgreementTypes.FieldType.ADDRESS ||
            t == AgreementTypes.FieldType.BOOL ||
            t == AgreementTypes.FieldType.BYTES32;
    }

    // ------------------------------------------------------------------
    // executeCall
    // ------------------------------------------------------------------

    /**
     * @notice Resolve target + dynamic args, assert constraints, compose, execute fatally.
     * @dev Order: resolve target (reject self) -> assert constraints against resolved
     *      values -> resolve each dynamic arg into a canonical word -> compose -> call.
     *      A failed call reverts the whole transition (atomic). Native value is dropped
     *      entirely — calls carry no ETH. Constraints reference the same ValueLib
     *      resolution the args use, so a constraint bounds exactly the value spliced in.
     *
     *      Returns the raw call return data so the caller can decode typed outputs; the
     *      capture/commit of those outputs happens in `executeAction` (after all calls).
     */
    function executeCall(
        Call memory c,
        ValueLib.EvalContext memory ctx,
        mapping(bytes32 => ValueLib.StoredVar) storage vars
    ) internal returns (bytes memory ret) {
        // 0. Resolve-once: pre-read every distinct STATIC_CALL ref reachable in THIS call
        //    (target, each dynamic arg's value, each constraint's left + right operands) into a
        //    per-call cache, ONCE each. Every later ValueLib.resolve/evaluate of one of those
        //    refs returns the memoized word — so the value a constraint CHECKS is byte-identical
        //    to the value spliced into the target/calldata. A non-deterministic external read
        //    therefore cannot pass the taint allowlist on one read and divert the call on
        //    another (the TOCTOU split is closed). A fresh cache per call gives per-call
        //    isolation (sequential calls legitimately re-read).
        _prewarmStaticCalls(c, ctx);

        // 1. Resolve the target; require it actually resolved to ADDRESS (don't discard the
        //    FieldType and blindly decode), then reject a resolved self-target (no-self).
        (AgreementTypes.FieldType tType, bytes memory targetBytes) =
            ValueLib.resolve(c.target, ctx, vars);
        if (tType != AgreementTypes.FieldType.ADDRESS) revert NonAddressTarget(tType);
        address target = abi.decode(targetBytes, (address));
        if (target == ctx.self) revert SelfCallRejected();

        // 2. Assert every constraint against the resolved values (fatal, AND semantics).
        for (uint256 i = 0; i < c.constraints.length; i++) {
            if (!ValueLib.evaluate(c.constraints[i], ctx, vars)) {
                revert ConstraintFailed(i);
            }
        }

        // 3. Resolve each dynamic arg into its canonical 32-byte word.
        bytes[] memory resolved = new bytes[](c.args.length);
        for (uint256 i = 0; i < c.args.length; i++) {
            if (c.args[i].dynamic) {
                (, bytes memory word) = ValueLib.resolve(c.args[i].value, ctx, vars);
                resolved[i] = word;
            }
        }

        // 4. Compose the calldata (byte-identical to abi.encodeWithSelector).
        bytes memory data = composeCalldata(c.selector, c.args, resolved);

        // 5. Execute fatally (no native value), copying only the returndata this call can
        //    actually consume. `_captureOutput` reads word `returnIndex` at offset
        //    `returnIndex*32`, so the most bytes any output needs is
        //    32 * (maxReturnIndex + 1); a call with NO outputs needs 0 bytes. Because part 1
        //    caps every returnIndex at MAX_RETURN_WORD_INDEX, `neededBytes` is statically
        //    bounded, so a target returning a multi-megabyte blob cannot force a giant copy
        //    (the return-bomb DoS). If the target returns FEWER bytes than needed, `ret` is
        //    short and the existing `_captureOutput` bounds check still reverts
        //    ReturnWordOutOfRange — the composed `ret` stays byte-compatible with what
        //    `_captureOutput` reads.
        uint256 neededBytes = _neededReturnBytes(c.outputs);
        ret = _boundedCall(target, data, neededBytes);
    }

    /// @dev The most returndata bytes this call's outputs can consume: 32 * (maxReturnIndex
    ///      + 1), or 0 if the call captures no outputs. Statically bounded because every
    ///      `returnIndex` is capped at MAX_RETURN_WORD_INDEX at init (validateCall).
    function _neededReturnBytes(Output[] memory outputs) private pure returns (uint256) {
        if (outputs.length == 0) return 0;
        uint256 maxIndex = outputs[0].returnIndex;
        for (uint256 i = 1; i < outputs.length; i++) {
            if (outputs[i].returnIndex > maxIndex) maxIndex = outputs[i].returnIndex;
        }
        // A validated config caps every returnIndex at MAX_RETURN_WORD_INDEX, so `32 *
        // (maxIndex + 1)` cannot overflow. The harness/runtime path can still be reached with
        // an unvalidated extreme index, so guard the multiply the same way _captureOutput
        // guards its ceiling: an index that large is unsatisfiable by any real returndata, so
        // saturate to max — the bounded copy then clamps to returndatasize() and
        // _captureOutput reverts the advertised ReturnWordOutOfRange (never an overflow panic).
        if (maxIndex > type(uint256).max / 32 - 1) return type(uint256).max;
        return 32 * (maxIndex + 1);
    }

    /**
     * @dev Execute a fatal outward call (no native value), copying only a bounded slice of
     *      the returndata instead of the whole blob a high-level `.call` would copy. On
     *      success, copies `min(returndatasize(), neededBytes)` into `ret`. On failure,
     *      reverts CallReverted carrying `min(returndatasize(), MAX_REVERT_BYTES)` of the
     *      revert data. Both copy lengths are statically bounded (neededBytes via the init
     *      returnIndex cap, MAX_REVERT_BYTES by constant), so neither a giant return blob nor
     *      giant revert data can exhaust gas — the return-bomb DoS (Codex M-02 / pashov #2).
     */
    function _boundedCall(address target, bytes memory data, uint256 neededBytes)
        private
        returns (bytes memory ret)
    {
        uint256 revertCap = MAX_REVERT_BYTES;
        bool ok;
        assembly ("memory-safe") {
            ok := call(gas(), target, 0, add(data, 0x20), mload(data), 0, 0)

            // Copy length = min(returndatasize(), cap): neededBytes on success, the revert
            // cap on failure. returndatacopy reverts if it reads past returndatasize(), so
            // clamp to the smaller of the cap and what actually came back.
            let cap := neededBytes
            if iszero(ok) { cap := revertCap }
            let n := returndatasize()
            if gt(n, cap) { n := cap }

            ret := mload(0x40)
            mstore(ret, n)
            returndatacopy(add(ret, 0x20), 0, n)
            // Bump the free-memory pointer past the bytes header + word-aligned payload.
            mstore(0x40, add(ret, add(0x20, and(add(n, 0x1f), not(0x1f)))))
        }
        if (!ok) revert CallReverted(target, ret);
    }

    /**
     * @dev Pre-fill `ctx.scCache` with the bounded read of every distinct STATIC_CALL ref
     *      reachable in this call — the resolve-once step (closes the STATIC_CALL TOCTOU).
     *      Reachable refs: the target, each DYNAMIC arg's value, and each constraint's left
     *      and every right operand. The cache is sized to an upper bound (the count of those
     *      candidate refs); prewarmStaticCall fills a slot per distinct STATIC_CALL key and
     *      no-ops a non-STATIC_CALL ref or an already-cached key, so distinct reads occupy
     *      distinct slots and duplicates collapse onto one read. Reassigned fresh per call,
     *      so sequential calls in an action are isolated (they legitimately re-read).
     */
    function _prewarmStaticCalls(Call memory c, ValueLib.EvalContext memory ctx) private view {
        // Upper bound on candidate refs: target + dynamic args + constraint (left + rights).
        uint256 cap = 1 + c.args.length;
        for (uint256 i = 0; i < c.constraints.length; i++) {
            cap += 1 + c.constraints[i].right.length;
        }
        ctx.scCache = new ValueLib.StaticCallCacheEntry[](cap);

        uint256 n = ValueLib.prewarmStaticCall(ctx, c.target, 0);
        for (uint256 i = 0; i < c.args.length; i++) {
            if (c.args[i].dynamic) {
                n = ValueLib.prewarmStaticCall(ctx, c.args[i].value, n);
            }
        }
        for (uint256 i = 0; i < c.constraints.length; i++) {
            AgreementTypes.Condition memory cn = c.constraints[i];
            n = ValueLib.prewarmStaticCall(ctx, cn.left, n);
            for (uint256 j = 0; j < cn.right.length; j++) {
                n = ValueLib.prewarmStaticCall(ctx, cn.right[j], n);
            }
        }
    }

    // ------------------------------------------------------------------
    // executeAction
    // ------------------------------------------------------------------

    /// @dev One staged output capture, held in the in-memory action-output overlay until
    ///      it is committed to storage after all calls in the action succeed.
    struct StagedOutput {
        bytes32 targetVar;
        AgreementTypes.FieldType outType;
        bytes value; // canonical encoding of the captured value
    }

    /**
     * @notice Execute every call in an action, in order (fatal), with typed output capture.
     * @dev Multi-call: calls run in declaration order; any call reverting reverts the
     *      whole transition (and thus every earlier call's external effect, via tx revert)
     *      — atomic.
     *
     *      Output capture uses an action-output OVERLAY: after each call returns, its
     *      `Output`s are decoded from the return data and STAGED into an in-memory overlay
     *      (no storage write). Only after ALL calls have executed and all outputs have
     *      validated is the overlay COMMITTED to `vars` (one write pass, last). So a
     *      later-call failure (which reverts the tx anyway) can never leave a committed
     *      capture, and the post-call storage write happens once, at the end, under the
     *      caller's nonReentrant guard (the window R5 verifies).
     */
    function executeAction(
        Action memory a,
        ValueLib.EvalContext memory ctx,
        mapping(bytes32 => ValueLib.StoredVar) storage vars
    ) internal {
        // Pre-size the overlay to the total number of outputs across all calls.
        uint256 total;
        for (uint256 i = 0; i < a.calls.length; i++) {
            total += a.calls[i].outputs.length;
        }
        StagedOutput[] memory overlay = new StagedOutput[](total);
        uint256 staged;

        for (uint256 i = 0; i < a.calls.length; i++) {
            bytes memory ret = executeCall(a.calls[i], ctx, vars);
            Output[] memory outs = a.calls[i].outputs;
            for (uint256 j = 0; j < outs.length; j++) {
                overlay[staged++] = _captureOutput(outs[j], ret);
            }
        }

        // Commit the overlay to storage — one write pass, after every call succeeded.
        for (uint256 k = 0; k < overlay.length; k++) {
            vars[overlay[k].targetVar] =
                ValueLib.StoredVar({fType: overlay[k].outType, data: overlay[k].value});
        }
    }

    /**
     * @notice Decode + canonically validate one captured return word into a StagedOutput.
     * @dev Reads the `returnIndex`-th 32-byte word from `ret` (bounds-checked,
     *      fail-closed via ReturnWordOutOfRange), interprets it as `outType`, and validates
     *      it is the canonical encoding of that type (rejecting e.g. dirty ADDRESS high
     *      bytes or a non-0/1 BOOL via MalformedValue). Only fixed-size word types are
     *      capturable (dynamic STRING/BYTES are rejected NonWordOutput).
     */
    function _captureOutput(Output memory o, bytes memory ret)
        private
        pure
        returns (StagedOutput memory s)
    {
        // Bounds: the requested word must fully lie within the return data. Check the
        // index ceiling FIRST so `(returnIndex + 1) * 32` can never overflow to a panic —
        // an extreme returnIndex fails with the advertised ReturnWordOutOfRange instead.
        if (o.returnIndex > type(uint256).max / 32 - 1) {
            revert ReturnWordOutOfRange(o.returnIndex, ret.length);
        }
        uint256 end = (o.returnIndex + 1) * 32;
        if (ret.length < end) revert ReturnWordOutOfRange(o.returnIndex, ret.length);

        bytes32 word;
        uint256 off = o.returnIndex * 32;
        assembly {
            word := mload(add(add(ret, 0x20), off))
        }

        s.targetVar = o.targetVar;
        s.outType = o.outType;
        s.value = _canonicalWord(o.outType, word);
    }

    /**
     * @dev Canonical encoding of a fixed-size return word as `outType`, validated.
     *      Delegates the per-word canonicity check + encoding to the single owner of the
     *      canonical-encoding rules, ValueLib.canonicalWord (UINT256/BYTES32 canonical
     *      as-is; ADDRESS high 12 bytes zero; BOOL 0 or 1 — else MalformedValue). A dynamic
     *      STRING/BYTES outType is never word-capturable; it is already rejected at init by
     *      validateCall (NonWordOutput), and this branch keeps that error as a defensive
     *      backstop so the dynamic-type rejection surface is unchanged.
     */
    function _canonicalWord(AgreementTypes.FieldType outType, bytes32 word)
        private
        pure
        returns (bytes memory)
    {
        if (!_isWordType(outType)) revert NonWordOutput(outType);
        return ValueLib.canonicalWord(outType, word);
    }

    // ------------------------------------------------------------------
    // Encoded entry points (PUBLIC — linked external library)
    //
    // The engine stores composable actions as the ABI-encoded Call[] (`bytes`). These
    // entry points own the nested-struct ABI coder for that encoding, so the heavy coder
    // lives in ActionLib's deployed bytecode — NOT inlined into AgreementEngine (whose
    // EIP-1167 clones must stay under the 24,576-byte code limit). They are the only
    // ActionLib functions the engine calls, and each takes primitive params (bytes +
    // an EvalContext) so passing them across the library boundary stays cheap.
    //
    // The legacy static-action -> composable desugar (`encodeLegacyCall`) was removed: legacy
    // authoring is now desugared into the composable Call[] shape OFF-CHAIN by the SDK (§9),
    // so the engine + ActionLib carry a single composable path.
    // ------------------------------------------------------------------

    /**
     * @notice Mandatory init-time taint analysis over all of an agreement's actions (R7).
     * @dev `encodedActions[k]` is one action's ABI-encoded Call[] (one per
     *      (fromState,inputId)); `persistedFieldIds` is the seed tainted-var set (every
     *      InputFieldDef with persist=true, whose var id == its field id). This:
     *        1. unions in every action's output target vars (each captures an external
     *           return — an unconditional taint seed) to form the full tainted-var set;
     *        2. taint-analyzes every call in every action against that set, reverting
     *           UnconstrainedTaintedTarget / UnconstrainedTaintedArg on the first tainted
     *           component lacking a bound over non-tainted operands.
     *      Pure and init-only — no runtime cost on submitInput. The nested-struct ABI
     *      coder lives here (not the engine) so the engine clone stays under the code limit.
     *
     *      Note on propagation completeness: the only var WRITERS in the current config are
     *      persist (seeds) and outputs (seeds), so the tainted-var set is exactly their
     *      union — no transitive var->var write chain exists to iterate. The fixpoint over
     *      such chains (e.g. an effect SET-ing a tainted var into another var) is
     *      implemented and unit-tested via `computeTaintedVars`; it is wired here as soon
     *      as the engine carries effects.
     */
    function validateActionsTaint(
        bytes[] memory encodedActions,
        bytes32[] memory persistedFieldIds
    ) public pure {
        // Decode all actions once and collect their output target vars; no validateCall
        // (taint-only — this entry point deliberately does NOT run structural validation).
        (Call[][] memory actionCalls, uint256 outputCount) = _decodeActions(encodedActions, false);
        _analyzeDecodedActionsTaint(actionCalls, outputCount, persistedFieldIds);
    }

    /**
     * @notice Single init pass over an agreement's encoded actions: structural validation
     *         (validateCall) AND the R7 taint analysis, decoding each action ONCE.
     * @dev Folds the two former init passes — a per-call `validateCall` loop and the R7
     *      taint analysis (`validateActionsTaint`) — into one, decoding each action's
     *      nested-struct Call[] ONCE instead of twice. Runs `validateCall` on every call (in
     *      action-then-call order) while collecting the output target vars for the
     *      tainted-var set, then runs the taint analysis over the full set. Accept/reject
     *      decisions and every single-fault error selector are unchanged. One ordering note:
     *      the structural pass now resolves AFTER canonical-condition validation (it used to
     *      run during action storage, before conditions), so an agreement invalid in BOTH an
     *      action way and a condition way may surface a different first revert selector;
     *      accept/reject is unaffected.
     */
    function validateAndAnalyzeActions(
        bytes[] memory encodedActions,
        bytes32[] memory persistedFieldIds
    ) public pure {
        // Decode each action once; validate every call and collect output target vars in the
        // same pass. validateCall runs across all actions first (matching the prior per-action
        // validateCall ordering) before any taint analysis.
        (Call[][] memory actionCalls, uint256 outputCount) = _decodeActions(encodedActions, true);
        _analyzeDecodedActionsTaint(actionCalls, outputCount, persistedFieldIds);
    }

    /// @dev Shared decode + output-count walk for the two taint entry points. Decodes each
    ///      action's nested-struct Call[] ONCE and sums the total output count. When
    ///      `runValidateCall` is true, runs the per-call structural `validateCall` on every
    ///      call in action-then-call order (the merged validate+analyze path) BEFORE any
    ///      taint analysis; when false, runs none (the taint-only path). This is the only
    ///      difference between the two entry points — the security ordering (validateCall on
    ///      all calls first, taint after) is preserved by running it here, in the same
    ///      action-then-call loop, before the caller invokes `_analyzeDecodedActionsTaint`.
    function _decodeActions(bytes[] memory encodedActions, bool runValidateCall)
        private
        pure
        returns (Call[][] memory actionCalls, uint256 outputCount)
    {
        actionCalls = new Call[][](encodedActions.length);
        for (uint256 k = 0; k < encodedActions.length; k++) {
            Call[] memory calls = abi.decode(encodedActions[k], (Call[]));
            actionCalls[k] = calls;
            // Bounded-evaluation cap: a submit executes every call in the action in order.
            _capCheck("MAX_CALLS_PER_ACTION", calls.length, MAX_CALLS_PER_ACTION);
            for (uint256 i = 0; i < calls.length; i++) {
                if (runValidateCall) validateCall(calls[i]);
                outputCount += calls[i].outputs.length;
            }
        }
    }

    /// @dev Build the tainted-var set (persisted seeds U output target var seeds) and run
    ///      the per-action taint analysis. Shared by validateActionsTaint and the merged
    ///      validateAndAnalyzeActions so the taint decision is one implementation.
    function _analyzeDecodedActionsTaint(
        Call[][] memory actionCalls,
        uint256 outputCount,
        bytes32[] memory persistedFieldIds
    ) private pure {
        // Tainted-var set = persisted field ids (seeds) U all output target vars (seeds).
        bytes32[] memory taintedVars = new bytes32[](persistedFieldIds.length + outputCount);
        uint256 n;
        for (uint256 p = 0; p < persistedFieldIds.length; p++) {
            taintedVars[n++] = persistedFieldIds[p];
        }
        for (uint256 k = 0; k < actionCalls.length; k++) {
            Call[] memory calls = actionCalls[k];
            for (uint256 i = 0; i < calls.length; i++) {
                Output[] memory outs = calls[i].outputs;
                for (uint256 j = 0; j < outs.length; j++) {
                    taintedVars[n++] = outs[j].targetVar;
                }
            }
        }

        // Analyze each action against the full tainted-var set.
        for (uint256 k = 0; k < actionCalls.length; k++) {
            _analyzeCallsTaint(actionCalls[k], taintedVars);
        }
    }

    /**
     * @notice Compute the transitive tainted-var set under option-B propagation (a fixpoint).
     * @dev `seeds` are unconditionally-tainted vars (persist / output / a tainted-source
     *      effect). `writeTargets[w]` is a var written from `writeSources[w]` (e.g. an
     *      effect SET): the target becomes tainted iff the source is tainted (a direct
     *      taint source, or a VAR already in the tainted set). Iterates to a fixpoint so a
     *      chain var_a <- var_b <- FIELD taints var_a transitively. Pure; exposed for the
     *      engine's future effect-bearing config and for direct unit testing of option B.
     */
    function computeTaintedVars(
        bytes32[] memory seeds,
        bytes32[] memory writeTargets,
        AgreementTypes.ValueRef[] memory writeSources
    ) public pure returns (bytes32[] memory) {
        require(writeTargets.length == writeSources.length, "taint: write arity");

        // Upper bound on the tainted set: every seed + every distinct write target.
        bytes32[] memory tainted = new bytes32[](seeds.length + writeTargets.length);
        uint256 n;
        for (uint256 i = 0; i < seeds.length; i++) {
            if (!_containsPrefix(tainted, n, seeds[i])) tainted[n++] = seeds[i];
        }

        // Fixpoint: repeatedly admit a write target whose source is tainted, until stable.
        bool changed = true;
        while (changed) {
            changed = false;
            for (uint256 w = 0; w < writeTargets.length; w++) {
                if (_containsPrefix(tainted, n, writeTargets[w])) continue;
                bool srcTainted = _isDirectTaintSource(writeSources[w].source);
                if (!srcTainted && writeSources[w].source == AgreementTypes.ValueSource.VAR) {
                    srcTainted = _containsPrefix(tainted, n, abi.decode(writeSources[w].data, (bytes32)));
                }
                if (srcTainted) {
                    tainted[n++] = writeTargets[w];
                    changed = true;
                }
            }
        }

        // Trim to the populated prefix.
        bytes32[] memory out = new bytes32[](n);
        for (uint256 i = 0; i < n; i++) out[i] = tainted[i];
        return out;
    }

    /// @notice Decode an encoded Call[] and execute the action (multi-call + output
    ///         capture, fatal, in order). Output capture commits after all calls succeed.
    function executeEncodedAction(
        bytes memory encodedCalls,
        ValueLib.EvalContext memory ctx,
        mapping(bytes32 => ValueLib.StoredVar) storage vars
    ) public {
        Call[] memory calls = abi.decode(encodedCalls, (Call[]));
        executeAction(Action({calls: calls}), ctx, vars);
    }
}
