// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.20;

import {AgreementTypes} from "./AgreementTypes.sol";

/**
 * @title ValueLib
 * @notice The resolve/compare core. Stateless; operates on a passed-in evaluation
 *         context and a storage reference to the engine's variable store.
 * @dev Implements the full source x type x op matrix: sources CONST / VAR / FIELD /
 *      FIELD_LENGTH / AUTH_SIGNER / CALLER / SELF / NOW / STATIC_CALL (R6, the bounded
 *      read-only external read), and the type set UINT256 / STRING / ADDRESS / BOOL /
 *      BYTES32 / BYTES. EQ/NEQ are defined for every type (value compare for fixed-width
 *      types; keccak256 for STRING/BYTES); ordered ops (GT/GTE/LT/LTE) are UINT256-only;
 *      IN/NOT_IN are limited to UINT256/ADDRESS/BYTES32. Illegal cells revert cleanly
 *      (IllegalComparison) rather than misbehaving.
 *
 *      STATIC_CALL (R6) is a bounded read-only external read: a fixed CONST target +
 *      selector + pre-baked CONST args, a gas stipend, a return-size cap, and a fail mode
 *      (REVERT or ABSENT). It resolves to a single canonical word of the declared word
 *      vType. A failed read reverts in REVERT mode; in ABSENT mode a failing STATIC_CALL
 *      LEFT operand is SKIPPED by `evaluate` (treated as satisfied), so a griefing read in
 *      one guard candidate cannot block later candidates. No self-target (runtime guard).
 *
 *      The interface is deliberately minimal but general: one resolve path, one
 *      check path, and an explicit per-type comparison-legality gate. Adding a
 *      source or type extends the bodies, not the signatures.
 *
 *      Legality matrix (per type, which CmpOps are legal; everything else is a
 *      defined IllegalComparison revert):
 *
 *        type      EQ NEQ | GT GTE LT LTE | IN NOT_IN
 *        UINT256    Y  Y  |  Y   Y  Y  Y  |  Y    Y
 *        ADDRESS    Y  Y  |  -   -  -  -  |  Y    Y
 *        BYTES32    Y  Y  |  -   -  -  -  |  Y    Y
 *        STRING     Y  Y  |  -   -  -  -  |  -    -
 *        BOOL       Y  Y  |  -   -  -  -  |  -    -
 *        BYTES      Y  Y  |  -   -  -  -  |  -    -
 *
 *      Ordered ops are UINT256-only (string length comparisons go through
 *      FIELD_LENGTH -> UINT256, not ordered-on-STRING). IN/NOT_IN are limited to
 *      the fixed-width comparable value types; STRING/BYTES keccak-set membership
 *      is intentionally not offered (see validateLegality). EQ/NEQ compare by
 *      value for fixed-width types and by keccak256 of the bytes for STRING/BYTES.
 *
 *      `validateLegality` is the init-time backstop: where a (type, op) cell is
 *      statically known illegal it is rejected at initialization; the eval-time
 *      gate in `check` is the runtime backstop. Both raise IllegalComparison.
 */
library ValueLib {
    using AgreementTypes for *;

    /// @dev Mirror of the engine's stored-variable record from the uniform store.
    struct StoredVar {
        AgreementTypes.FieldType fType;
        bytes data;
    }

    // ------------------------------------------------------------------
    // Init-time bounded-evaluation caps (spec §13). These bound submit-time evaluation
    // cost so a griefing config author cannot gas-bomb a counterparty. Enforced at init in
    // the shared legality / canonical-encoding gates (so both the legacy desugar and the
    // canonical authoring paths are covered), raising AgreementTypes.ConfigCapExceeded.
    // Generous for legitimate agreements; TUNABLE constants.
    // ------------------------------------------------------------------

    /// @dev Max right-operand count of an IN / NOT_IN condition. The set is compared
    ///      element-by-element on submit, so its size is a submit-time evaluation cost.
    uint256 internal constant MAX_IN_SET_SIZE = 64;

    /// @dev Max byte length of a dynamic (STRING / BYTES) value supplied as a canonical
    ///      CONST. A submit-time EQ/NEQ over a dynamic value keccak256-hashes its bytes, so
    ///      the value length bounds that submit-time hash/compare cost.
    uint256 internal constant MAX_DYNAMIC_VALUE_BYTES = 4096;

    /// @dev Per-submission evaluation context. Input fields are pre-decoded by the engine.
    ///      `scCache` is the resolve-once STATIC_CALL cache (see StaticCallCacheEntry): a
    ///      memory array, empty on the guard/condition path and pre-filled by ActionLib on the
    ///      action path so a STATIC_CALL used as a target / dynamic arg / constraint operand is
    ///      read EXACTLY ONCE — closing the check-vs-use TOCTOU split.
    struct EvalContext {
        Field[] fields; // decoded submitted input fields
        address authSigner; // permit signer, else msg.sender
        address caller; // msg.sender
        address self; // address(this)
        uint256 timestamp; // block.timestamp
        StaticCallCacheEntry[] scCache; // resolve-once STATIC_CALL read cache (memory)
    }

    /**
     * @dev One memoized STATIC_CALL READ, keyed by keccak256(ref.data) (the StaticCallSpec).
     *      Caches the RAW first return word + success flag — NOT a decoded value — so two refs
     *      with the same spec but different decode `vType` share the one external read and each
     *      decodes the shared word independently. `filled` marks a populated slot (a default
     *      zero entry is not a hit). A cache miss means resolve performs the call directly (the
     *      guard path, whose cache is empty); a hit returns the memoized word, so within one
     *      action-call execution the value a constraint CHECKS is byte-identical to the value
     *      the target/calldata USES — a non-deterministic target cannot split the two.
     */
    struct StaticCallCacheEntry {
        bytes32 key; // keccak256(ref.data)
        bool filled; // this slot holds a memoized read
        bool ok; // the bounded read succeeded (>= 32 bytes returned within stipend)
        bytes32 word; // the first 32-byte return word (raw; decoded per-ref via canonicalWord)
    }

    struct Field {
        bytes32 id;
        AgreementTypes.FieldType fType;
        bytes data;
    }

    // ------------------------------------------------------------------
    // check
    // ------------------------------------------------------------------

    /**
     * @notice Evaluate a Condition; revert if it does not hold.
     * @dev Resolves left and (each) right through `resolve`, then applies the CmpOp
     *      with per-type legality enforced. Reverts ComparisonFailed on a false result;
     *      reverts IllegalComparison if the (type, op) cell is not legal (the eval-time
     *      backstop to the init-time `validateLegality` gate). A skipped IF_PRESENT
     *      condition is treated as satisfied.
     */
    function check(
        AgreementTypes.Condition memory cond,
        EvalContext memory ctx,
        mapping(bytes32 => StoredVar) storage vars
    ) internal view {
        if (!evaluate(cond, ctx, vars)) revert AgreementTypes.ComparisonFailed();
    }

    /**
     * @notice Evaluate a Condition to a boolean (no revert on a false result).
     * @dev Same resolution and legality discipline as `check`; an illegal (type, op)
     *      still reverts IllegalComparison, and an absent non-IF_PRESENT field still
     *      reverts FieldAbsent during resolve. Returns true for a skipped IF_PRESENT
     *      condition. This is the shared core used by `check` (revert-on-false), by
     *      guard selection (first candidate whose guards pass), and by constraint
     *      assertion — one evaluation path, many call sites.
     */
    function evaluate(
        AgreementTypes.Condition memory cond,
        EvalContext memory ctx,
        mapping(bytes32 => StoredVar) storage vars
    ) internal view returns (bool) {
        // Resolve the left operand, honoring the two "absent -> skip-as-satisfied" notions in
        // a SINGLE pass (so an ABSENT-mode STATIC_CALL left is read exactly once, never probed
        // then re-resolved):
        //   - IF_PRESENT (cond.skipIfAbsent): a FIELD / FIELD_LENGTH left whose input field
        //     is missing from the submission.
        //   - ABSENT-mode STATIC_CALL: a left STATIC_CALL whose failMode == ABSENT and whose
        //     bounded read FAILS (reverts / out-of-stipend / short return). This is the
        //     griefing-resistance path — a reverting/griefing read in one guard candidate is
        //     treated as absent so it does not block later transition candidates. The ABSENT
        //     skip is driven by the ref's own failMode, NOT by cond.skipIfAbsent.
        (bool absent, AgreementTypes.FieldType lt, bytes memory lv) =
            _resolveLeft(cond.left, cond.skipIfAbsent, ctx, vars);
        if (absent) return true;

        AgreementTypes.CmpOp op = cond.op;

        if (op == AgreementTypes.CmpOp.IN || op == AgreementTypes.CmpOp.NOT_IN) {
            // Membership is defined only for the fixed-width comparable types.
            if (!_inLegal(lt)) revert AgreementTypes.IllegalComparison(lt, op);
            bool member = false;
            for (uint256 i = 0; i < cond.right.length; i++) {
                (AgreementTypes.FieldType et, bytes memory ev) = resolve(cond.right[i], ctx, vars);
                if (_equals(lt, lv, et, ev)) {
                    member = true;
                    break;
                }
            }
            return (op == AgreementTypes.CmpOp.IN) ? member : !member;
        }

        // Scalar comparisons: exactly one right operand.
        require(cond.right.length == 1, "ValueLib: scalar op needs one rhs");
        (AgreementTypes.FieldType rt, bytes memory rv) = resolve(cond.right[0], ctx, vars);

        return _compare(lt, lv, op, rt, rv);
    }

    /**
     * @notice Init-time legality gate for a Condition whose (type, op) is statically known.
     * @dev Rejects, at initialization, any cell that the eval-time path would also reject —
     *      surfacing a misconfigured comparison at creation rather than first submission.
     *      Checks the declared left `vType` against the op (left's `vType` is the comparison
     *      type for all sources except FIELD_LENGTH, which always resolves to UINT256).
     *      Reverts IllegalComparison on an illegal cell. Pure: it inspects only the
     *      declared types, not runtime values.
     */
    function validateLegality(AgreementTypes.Condition memory cond) internal pure {
        validateRef(cond.left);
        AgreementTypes.FieldType lt = staticType(cond.left);
        AgreementTypes.CmpOp op = cond.op;

        // Structural arity + RHS-type checks: a malformed canonical condition (authored
        // directly by guards/constraints/effects, not just legacy desugar) is rejected
        // at init, not at first submission.
        if (op == AgreementTypes.CmpOp.IN || op == AgreementTypes.CmpOp.NOT_IN) {
            if (!_inLegal(lt)) revert AgreementTypes.IllegalComparison(lt, op);
            // Bounded-evaluation cap: the membership set is compared element-by-element on
            // submit, so its size is bounded at init.
            if (cond.right.length > MAX_IN_SET_SIZE) {
                revert AgreementTypes.ConfigCapExceeded(
                    "MAX_IN_SET_SIZE", cond.right.length, MAX_IN_SET_SIZE
                );
            }
            // Each element's source-derived type must match the left type (eval compares
            // element-by-element against the left value). An empty set is structurally
            // valid (membership is simply always-false / NOT_IN always-true).
            for (uint256 i = 0; i < cond.right.length; i++) {
                validateRef(cond.right[i]);
                AgreementTypes.FieldType et = staticType(cond.right[i]);
                if (et != lt) revert AgreementTypes.TypeMismatch(lt, et);
            }
            return;
        }

        // Scalar ops (EQ/NEQ/ordered): exactly one RHS, whose type matches the left.
        if (cond.right.length != 1) revert AgreementTypes.ArityMismatch(op, cond.right.length);
        validateRef(cond.right[0]);
        AgreementTypes.FieldType rt = staticType(cond.right[0]);
        if (rt != lt) revert AgreementTypes.TypeMismatch(lt, rt);

        if (op == AgreementTypes.CmpOp.EQ || op == AgreementTypes.CmpOp.NEQ) {
            return; // EQ/NEQ legal for every type.
        }
        // Ordered: UINT256 only.
        if (lt != AgreementTypes.FieldType.UINT256) {
            revert AgreementTypes.IllegalComparison(lt, op);
        }
    }

    /**
     * @notice Init-time structural validation of a single ValueRef.
     * @dev For a synthesized/derived source, the declared `vType` must agree with the
     *      source-fixed type (the same rule resolve enforces). For CONST, the raw `data`
     *      must be the canonical encoding of its declared type — author-supplied bytes are
     *      the only ones not already validated by engine storage/input plumbing, so this is
     *      where the "resolve returns canonically-encoded bytes" contract is anchored.
     *      VAR/FIELD/FIELD_LENGTH refs encode a bytes32 id, validated for decodability.
     *
     *      Exposed (internal) so ActionLib can apply the SAME init-time ref gate to an
     *      action's target and dynamic-arg refs that condition operands already get —
     *      one validation path, not a duplicate.
     */
    function validateRef(AgreementTypes.ValueRef memory ref) internal pure {
        AgreementTypes.ValueSource s = ref.source;

        if (s == AgreementTypes.ValueSource.CONST) {
            _validateCanonical(ref.vType, ref.data);
            return;
        }
        if (
            s == AgreementTypes.ValueSource.AUTH_SIGNER ||
            s == AgreementTypes.ValueSource.CALLER ||
            s == AgreementTypes.ValueSource.SELF
        ) {
            _requireDeclared(ref.vType, AgreementTypes.FieldType.ADDRESS);
            return;
        }
        if (s == AgreementTypes.ValueSource.NOW) {
            _requireDeclared(ref.vType, AgreementTypes.FieldType.UINT256);
            return;
        }
        if (s == AgreementTypes.ValueSource.FIELD_LENGTH) {
            _requireDeclared(ref.vType, AgreementTypes.FieldType.UINT256);
            abi.decode(ref.data, (bytes32)); // a field id must be decodable
            return;
        }
        if (s == AgreementTypes.ValueSource.VAR || s == AgreementTypes.ValueSource.FIELD) {
            abi.decode(ref.data, (bytes32)); // a var / field id must be decodable
            return;
        }
        if (s == AgreementTypes.ValueSource.STATIC_CALL) {
            _validateStaticCallSpec(ref.vType, ref.data);
            return;
        }
        revert AgreementTypes.UnsupportedSource(s);
    }

    /**
     * @notice Init-time structural validation of a STATIC_CALL spec (pure).
     * @dev Guards the decode with a minimum-length pre-check, so a too-short payload
     *      surfaces the typed MalformedStaticCallSpec rather than panicking in abi.decode
     *      (a payload long enough to enter abi.decode but still malformed may revert there —
     *      fail-closed either way, and this is init-time, author-provided data). Then
     *      requires: the decode `vType` is a fixed-size word type (UINT256/ADDRESS/BOOL/
     *      BYTES32 — a STATIC_CALL yields one canonical word, never STRING/BYTES); target
     *      != 0 (the no-self check is a runtime guard in resolve — validateRef is pure and
     *      has no address(this)); 0 < gas <= MAX_STATIC_CALL_GAS (a positive but bounded
     *      stipend, so a griefing target cannot be handed a near-all-gas budget);
     *      maxReturnBytes == 32 (exactly one word is ever read, so any other cap is
     *      misleading); failMode in {0,1}. Anything else is MalformedStaticCallSpec.
     *      Selector and args are unconstrained here (args are pre-baked CONST bytes; an
     *      empty args is valid).
     */
    function _validateStaticCallSpec(AgreementTypes.FieldType vType, bytes memory data)
        private
        pure
    {
        if (!_isWordType(vType)) revert AgreementTypes.MalformedStaticCallSpec();
        // Min-length pre-check: a payload too short to be a valid StaticCallSpec encoding is
        // rejected with the typed error rather than panicking inside abi.decode.
        if (data.length < MIN_STATIC_CALL_SPEC_BYTES) revert AgreementTypes.MalformedStaticCallSpec();
        StaticCallSpec memory spec = _decodeStaticCallSpec(data);
        if (spec.target == address(0)) revert AgreementTypes.MalformedStaticCallSpec();
        if (spec.gas == 0 || spec.gas > MAX_STATIC_CALL_GAS) {
            revert AgreementTypes.MalformedStaticCallSpec();
        }
        if (spec.maxReturnBytes != 32) revert AgreementTypes.MalformedStaticCallSpec();
        if (spec.failMode > FAIL_MODE_ABSENT) revert AgreementTypes.MalformedStaticCallSpec();
    }

    /// @dev Upper bound on the RAW byte length of a dynamic (STRING/BYTES) value before it is
    ///      decoded — a pre-decode DoS guard that bounds the abi.decode walk over `data`. It is
    ///      DELIBERATELY LOOSER than the canonical size of a MAX_DYNAMIC_VALUE_BYTES payload so the
    ///      DECODED-length cap (MAX_DYNAMIC_VALUE_BYTES) stays the binding, observable limit for a
    ///      value at/near the boundary: a value whose decoded length is just over the decoded cap
    ///      still passes this raw gate, decodes, and is rejected by the decoded cap (the semantic
    ///      limit), while a grossly oversized raw payload (huge padding / a non-canonical trailing
    ///      blob inflating `data`) is rejected here first. Two canonical-frames of headroom over the
    ///      decoded cap is ample slack for the boundary while still bounding the decode cost.
    ///      (abi.decode itself bounds-checks the claimed length against data.length, so the decode
    ///      walk is already O(data.length) — this cap simply bounds data.length.)
    uint256 internal constant MAX_DYNAMIC_RAW_BYTES = 128 + 2 * (((MAX_DYNAMIC_VALUE_BYTES + 31) / 32) * 32);

    /**
     * @notice Validate `data` as the canonical encoding of `vType` and return that canonical
     *         encoding (the single owner of the "store only canonical bytes" contract).
     * @dev The engine routes init-var and persisted STRING/BYTES (and word) values through here
     *      so storage holds exactly one canonical encoding per value — closing the non-canonical
     *      storage gap where a value could decode to a short string/bytes while carrying a huge
     *      trailing blob (bypassing the dynamic-value cap and bloating storage). Fixed-width word
     *      types return the canonical word encoding (rejecting dirty ADDRESS high bytes / a
     *      non-0/1 BOOL). Dynamic types cap the RAW length pre-decode, cap the DECODED length,
     *      then re-encode and require byte-exact equality to `data` (rejecting any non-canonical
     *      payload). Reverts MalformedValue / ConfigCapExceeded on a deviation. The returned
     *      bytes are byte-identical to `data` for an already-canonical input, so storing the
     *      return value preserves wire/round-trip parity for honest callers.
     */
    function canonicalize(AgreementTypes.FieldType vType, bytes memory data)
        internal
        pure
        returns (bytes memory)
    {
        if (_isWordType(vType)) {
            if (data.length != 32) revert AgreementTypes.MalformedValue(vType);
            bytes32 word;
            assembly ("memory-safe") {
                word := mload(add(data, 0x20))
            }
            return canonicalWord(vType, word);
        }
        if (vType == AgreementTypes.FieldType.STRING) {
            if (data.length > MAX_DYNAMIC_RAW_BYTES) {
                revert AgreementTypes.ConfigCapExceeded(
                    "MAX_DYNAMIC_RAW_BYTES", data.length, MAX_DYNAMIC_RAW_BYTES
                );
            }
            string memory sv = abi.decode(data, (string));
            _capDynamicBytes(bytes(sv).length);
            bytes memory re = abi.encode(sv);
            if (keccak256(re) != keccak256(data)) revert AgreementTypes.MalformedValue(vType);
            return re;
        }
        // BYTES
        if (data.length > MAX_DYNAMIC_RAW_BYTES) {
            revert AgreementTypes.ConfigCapExceeded(
                "MAX_DYNAMIC_RAW_BYTES", data.length, MAX_DYNAMIC_RAW_BYTES
            );
        }
        bytes memory bv = abi.decode(data, (bytes));
        _capDynamicBytes(bv.length);
        bytes memory reb = abi.encode(bv);
        if (keccak256(reb) != keccak256(data)) revert AgreementTypes.MalformedValue(vType);
        return reb;
    }

    /**
     * @notice Assert `data` is the single canonical encoding of `vType`.
     * @dev Fixed-width types must be exactly one 32-byte word whose decode-then-re-encode
     *      is identity (rejects dirty address high-bytes and non-0/1 bool words). Dynamic
     *      types (STRING/BYTES) must decode and re-encode identically (rejects truncated /
     *      overlong / mis-offset payloads). Raises MalformedValue on any deviation.
     */
    function _validateCanonical(AgreementTypes.FieldType vType, bytes memory data) private pure {
        if (_isWordType(vType)) {
            if (data.length != 32) revert AgreementTypes.MalformedValue(vType);
            // Read the single word and run the shared per-type word canonicity check
            // (rejecting dirty ADDRESS high bytes / a non-0/1 BOOL via MalformedValue).
            bytes32 word;
            assembly ("memory-safe") {
                word := mload(add(data, 0x20))
            }
            canonicalWord(vType, word);
            return;
        }
        if (vType == AgreementTypes.FieldType.STRING) {
            string memory sv = abi.decode(data, (string));
            _capDynamicBytes(bytes(sv).length);
            bytes memory re = abi.encode(sv);
            if (keccak256(re) != keccak256(data)) revert AgreementTypes.MalformedValue(vType);
            return;
        }
        // BYTES
        bytes memory bv = abi.decode(data, (bytes));
        _capDynamicBytes(bv.length);
        bytes memory reb = abi.encode(bv);
        if (keccak256(reb) != keccak256(data)) revert AgreementTypes.MalformedValue(vType);
    }

    /// @dev Bounded-evaluation cap: a dynamic (STRING/BYTES) CONST value's payload length is
    ///      bounded at init (its bytes are keccak256-hashed on a submit-time EQ/NEQ).
    function _capDynamicBytes(uint256 len) private pure {
        if (len > MAX_DYNAMIC_VALUE_BYTES) {
            revert AgreementTypes.ConfigCapExceeded("MAX_DYNAMIC_VALUE_BYTES", len, MAX_DYNAMIC_VALUE_BYTES);
        }
    }

    /**
     * @notice Validate a single 32-byte word as the canonical value of a fixed-size
     *         `wordType`, returning its canonical `bytes` encoding.
     * @dev The single owner of the per-word canonicity rules (ValueLib owns the canonical
     *      encoding contract). UINT256/BYTES32: every word is canonical. ADDRESS: the high
     *      12 bytes must be zero. BOOL: the word must be 0 or 1. A non-canonical word raises
     *      MalformedValue. A non-word (STRING/BYTES) type raises MalformedValue too — those
     *      are not word-encodable. Exposed (internal) so a 32-byte-word call site (e.g.
     *      ActionLib's captured return word) shares this exact check instead of duplicating
     *      the per-type canonical rules.
     */
    function canonicalWord(AgreementTypes.FieldType wordType, bytes32 word)
        internal
        pure
        returns (bytes memory)
    {
        if (wordType == AgreementTypes.FieldType.UINT256) {
            return abi.encode(uint256(word));
        }
        if (wordType == AgreementTypes.FieldType.BYTES32) {
            return abi.encode(word);
        }
        if (wordType == AgreementTypes.FieldType.ADDRESS) {
            // High 12 bytes must be zero for a canonical address word.
            if (uint256(word) >> 160 != 0) revert AgreementTypes.MalformedValue(wordType);
            return abi.encode(address(uint160(uint256(word))));
        }
        if (wordType == AgreementTypes.FieldType.BOOL) {
            uint256 v = uint256(word);
            if (v > 1) revert AgreementTypes.MalformedValue(wordType);
            return abi.encode(v == 1);
        }
        // STRING / BYTES are dynamic — not encodable from a fixed-size word.
        revert AgreementTypes.MalformedValue(wordType);
    }

    /// @dev The fixed-size (single 32-byte word) value types.
    function _isWordType(AgreementTypes.FieldType t) private pure returns (bool) {
        return
            t == AgreementTypes.FieldType.UINT256 ||
            t == AgreementTypes.FieldType.ADDRESS ||
            t == AgreementTypes.FieldType.BOOL ||
            t == AgreementTypes.FieldType.BYTES32;
    }

    /**
     * @notice The type a ValueRef statically resolves to, derived from its SOURCE.
     * @dev Synthesized/derived sources fix the type; the author-declared `vType` for
     *      those is required to agree (resolve enforces this at runtime, here we use the
     *      source-derived type so the legality gate cannot be fooled by a misdeclared
     *      vType). CONST/VAR/FIELD carry their declared `vType` (validated against the
     *      concrete value at resolve). STATIC_CALL declares its decode type via `vType`.
     */
    function staticType(AgreementTypes.ValueRef memory ref)
        internal
        pure
        returns (AgreementTypes.FieldType)
    {
        AgreementTypes.ValueSource s = ref.source;
        if (
            s == AgreementTypes.ValueSource.AUTH_SIGNER ||
            s == AgreementTypes.ValueSource.CALLER ||
            s == AgreementTypes.ValueSource.SELF
        ) {
            return AgreementTypes.FieldType.ADDRESS;
        }
        if (
            s == AgreementTypes.ValueSource.NOW ||
            s == AgreementTypes.ValueSource.FIELD_LENGTH
        ) {
            return AgreementTypes.FieldType.UINT256;
        }
        // CONST / VAR / FIELD / STATIC_CALL: the declared type.
        return ref.vType;
    }

    /// @dev A synthesized/derived source fixes its resolved type; a misdeclared `vType`
    ///      on such a ref is a TypeMismatch (caught at resolve, mirroring the legality
    ///      gate's source-derived type so the two never disagree).
    function _requireDeclared(
        AgreementTypes.FieldType declared,
        AgreementTypes.FieldType fixedType
    ) private pure {
        if (declared != fixedType) revert AgreementTypes.TypeMismatch(fixedType, declared);
    }

    /// @dev IN / NOT_IN are legal for the fixed-width comparable value types only.
    ///      STRING/BYTES keccak-set membership and BOOL membership are intentionally
    ///      excluded (a BOOL "set" degenerates to EQ; STRING/BYTES sets are deferred).
    function _inLegal(AgreementTypes.FieldType t) private pure returns (bool) {
        return
            t == AgreementTypes.FieldType.UINT256 ||
            t == AgreementTypes.FieldType.ADDRESS ||
            t == AgreementTypes.FieldType.BYTES32;
    }

    // ------------------------------------------------------------------
    // resolve
    // ------------------------------------------------------------------

    /**
     * @notice Resolve a ValueRef to (FieldType, bytes) against the context + var store.
     * @dev CONST, VAR, FIELD, FIELD_LENGTH, AUTH_SIGNER, CALLER, SELF, NOW, and STATIC_CALL
     *      (the bounded read-only external read) are resolved here.
     */
    function resolve(
        AgreementTypes.ValueRef memory ref,
        EvalContext memory ctx,
        mapping(bytes32 => StoredVar) storage vars
    ) internal view returns (AgreementTypes.FieldType, bytes memory) {
        AgreementTypes.ValueSource src = ref.source;

        if (src == AgreementTypes.ValueSource.CONST) {
            return (ref.vType, ref.data);
        }

        if (src == AgreementTypes.ValueSource.VAR) {
            bytes32 varId = abi.decode(ref.data, (bytes32));
            StoredVar storage v = vars[varId];
            if (v.data.length == 0) revert AgreementTypes.VarNotSet(varId);
            if (v.fType != ref.vType) revert AgreementTypes.TypeMismatch(ref.vType, v.fType);
            return (v.fType, v.data);
        }

        if (src == AgreementTypes.ValueSource.FIELD) {
            bytes32 fieldId = abi.decode(ref.data, (bytes32));
            (bool found, Field memory f) = _findField(ctx.fields, fieldId);
            // resolve never skips: an absent field reverts FieldAbsent here. The
            // IF_PRESENT skip is handled one level up in `evaluate` (it short-circuits to
            // true before calling resolve when skipIfAbsent and the field is absent).
            if (!found) revert AgreementTypes.FieldAbsent(fieldId);
            if (f.fType != ref.vType) revert AgreementTypes.TypeMismatch(ref.vType, f.fType);
            return (f.fType, f.data);
        }

        if (src == AgreementTypes.ValueSource.FIELD_LENGTH) {
            // Byte length of a STRING (or BYTES) input field, as a UINT256.
            // Matches legacy bytes(s).length (UTF-8 byte count, not codepoints).
            _requireDeclared(ref.vType, AgreementTypes.FieldType.UINT256);
            bytes32 fieldId = abi.decode(ref.data, (bytes32));
            (bool found, Field memory f) = _findField(ctx.fields, fieldId);
            if (!found) revert AgreementTypes.FieldAbsent(fieldId);
            uint256 len;
            if (f.fType == AgreementTypes.FieldType.STRING) {
                len = bytes(abi.decode(f.data, (string))).length;
            } else if (f.fType == AgreementTypes.FieldType.BYTES) {
                len = abi.decode(f.data, (bytes)).length;
            } else {
                // Legacy STRING length ops revert TypeMismatch on a non-string field.
                revert AgreementTypes.TypeMismatch(AgreementTypes.FieldType.STRING, f.fType);
            }
            return (AgreementTypes.FieldType.UINT256, abi.encode(len));
        }

        if (src == AgreementTypes.ValueSource.AUTH_SIGNER) {
            // The authorizing identity (permit signer, else msg.sender), as an ADDRESS.
            _requireDeclared(ref.vType, AgreementTypes.FieldType.ADDRESS);
            return (AgreementTypes.FieldType.ADDRESS, abi.encode(ctx.authSigner));
        }

        if (src == AgreementTypes.ValueSource.CALLER) {
            _requireDeclared(ref.vType, AgreementTypes.FieldType.ADDRESS);
            return (AgreementTypes.FieldType.ADDRESS, abi.encode(ctx.caller));
        }

        if (src == AgreementTypes.ValueSource.SELF) {
            _requireDeclared(ref.vType, AgreementTypes.FieldType.ADDRESS);
            return (AgreementTypes.FieldType.ADDRESS, abi.encode(ctx.self));
        }

        if (src == AgreementTypes.ValueSource.NOW) {
            _requireDeclared(ref.vType, AgreementTypes.FieldType.UINT256);
            return (AgreementTypes.FieldType.UINT256, abi.encode(ctx.timestamp));
        }

        if (src == AgreementTypes.ValueSource.STATIC_CALL) {
            // Bounded read-only external call -> first 32-byte return word -> canonical
            // word of the declared vType. The spec caps forwarded gas and copied return
            // bytes (return-bomb defence). A failed call (revert / out-of-stipend / short
            // return) reverts resolution here: an arg or any non-ABSENT-skipped operand
            // must produce a concrete value. The ABSENT fail mode's guard-candidate skip is
            // handled one level up in `evaluate` (it probes the call and short-circuits to
            // true before resolve is reached for an ABSENT-mode left operand that fails).
            //
            // Resolve-once: on the action path ActionLib pre-fills ctx.scCache with this
            // call's STATIC_CALL reads, so a cache HIT returns the one memoized word (the
            // value a constraint checked == the value spliced into the call — no TOCTOU
            // split). On the guard path the cache is empty (a miss), so the read runs
            // directly here, then is immediately compared — also single-read, also safe.
            StaticCallSpec memory spec = _decodeStaticCallSpec(ref.data);
            if (spec.target == ctx.self) revert AgreementTypes.StaticCallSelfTarget();
            (bool ok, bytes32 word) = _readStaticCall(ref, spec, ctx);
            if (!ok) revert AgreementTypes.StaticCallFailed(spec.target);
            return (ref.vType, canonicalWord(ref.vType, word));
        }

        // No remaining source is unimplemented; an unknown enum value reverts.
        revert AgreementTypes.UnsupportedSource(src);
    }

    // ------------------------------------------------------------------
    // STATIC_CALL: bounded read-only external read (R6)
    // ------------------------------------------------------------------

    /**
     * @dev Spec for a STATIC_CALL, ABI-encoded into a STATIC_CALL ValueRef's `data`.
     *      - `target`/`selector` are fixed at creation (no allowlist/dynamic target yet).
     *      - `args` are pre-baked CONST argument bytes (may be empty); calldata is
     *        `selector ++ args` — no FIELD-derived args inside the static call (deferred).
     *      - `gas` is the forwarded gas stipend (the time bound).
     *      - `maxReturnBytes` caps the copied returndata (the return-bomb bound); >= 32.
     *      - `failMode` is REVERT (0) or ABSENT (1).
     */
    struct StaticCallSpec {
        address target;
        bytes4 selector;
        bytes args;
        uint256 gas;
        uint16 maxReturnBytes;
        uint8 failMode;
    }

    uint8 internal constant FAIL_MODE_REVERT = 0;
    uint8 internal constant FAIL_MODE_ABSENT = 1;

    /// @dev Maximum forwarded gas stipend for a bounded STATIC_CALL. A read is a single
    ///      bounded probe of external state, not a computation budget — 100_000 gas is
    ///      ample for any honest view (an SLOAD-heavy getter is well under it) while
    ///      capping how much an author can hand a griefing target: without a cap an author
    ///      could set a near-all-gas stipend and a target that burns it would starve the
    ///      outer transition. The cap bounds the per-read griefing loss to <= 100_000 gas.
    uint256 internal constant MAX_STATIC_CALL_GAS = 100_000;

    /// @dev Minimum byte length of an ABI-encoded StaticCallSpec (a tuple param with one
    ///      dynamic `args` member, args empty): a 0x20 outer offset + a 6-word tuple head +
    ///      a 1-word args length = 256 bytes. A shorter payload cannot be a valid encoding,
    ///      so it is rejected as MalformedStaticCallSpec instead of reaching a raw
    ///      abi.decode panic (an opaque Panic(0x..) rather than the typed custom error).
    uint256 internal constant MIN_STATIC_CALL_SPEC_BYTES = 256;

    /// @dev Decode a STATIC_CALL spec from a ref's `data`. A non-decodable payload reverts.
    function _decodeStaticCallSpec(bytes memory data)
        private
        pure
        returns (StaticCallSpec memory)
    {
        return abi.decode(data, (StaticCallSpec));
    }

    /**
     * @dev Perform the bounded read-only call and read the FIRST 32-byte return word.
     *      Forwards at most `spec.gas`, copies at most `spec.maxReturnBytes` of returndata
     *      (so a return-bomb cannot blow up memory), and treats a return shorter than 32
     *      bytes as a failure. Returns (false, 0) on any failure; never reverts itself
     *      (the caller decides REVERT vs ABSENT). `view`: a staticcall cannot mutate state.
     */
    function _staticCall(StaticCallSpec memory spec)
        private
        view
        returns (bool ok, bytes32 word)
    {
        bytes memory callData = abi.encodePacked(spec.selector, spec.args);
        // Cap the bytes we are willing to copy back at maxReturnBytes (>= 32 by init
        // validation; we read exactly the first word, so 32 is all we ever consult).
        uint256 cap = spec.maxReturnBytes;
        if (cap > 32) cap = 32;

        address target = spec.target;
        uint256 gasStipend = spec.gas;
        assembly ("memory-safe") {
            // Scratch buffer for the (capped) returndata. 64 bytes is ample for a 32-byte
            // copy; the copy itself is clamped to `cap` so a return-bomb is never copied.
            let buf := mload(0x40)
            let success := staticcall(
                gasStipend,
                target,
                add(callData, 0x20),
                mload(callData),
                0,
                0
            )
            if success {
                // Only treat it as a usable result if at least one full word came back.
                if iszero(lt(returndatasize(), 0x20)) {
                    returndatacopy(buf, 0, cap)
                    word := mload(buf)
                    ok := 1
                }
            }
        }
    }

    /**
     * @dev Read a STATIC_CALL's first word THROUGH the resolve-once cache. A cache HIT (an
     *      entry whose key == keccak256(ref.data) was pre-filled by prewarmStaticCall) returns
     *      the one memoized (ok, word) so every consult of this ref in the call sees the SAME
     *      read. A MISS (the guard path's empty cache, or a ref not prewarmed) performs the
     *      bounded read directly. The raw word — not a decoded value — is cached, so two refs
     *      with the same spec but different decode vType share the read and decode separately.
     */
    function _readStaticCall(
        AgreementTypes.ValueRef memory ref,
        StaticCallSpec memory spec,
        EvalContext memory ctx
    ) private view returns (bool ok, bytes32 word) {
        (bool hit, uint256 i) = _findCacheEntry(ctx, keccak256(ref.data));
        if (hit) return (ctx.scCache[i].ok, ctx.scCache[i].word);
        return _staticCall(spec);
    }

    /// @dev Find a filled cache entry for `key`. Linear over the (small, per-call) cache.
    function _findCacheEntry(EvalContext memory ctx, bytes32 key)
        private
        pure
        returns (bool, uint256)
    {
        StaticCallCacheEntry[] memory cache = ctx.scCache;
        for (uint256 i = 0; i < cache.length; i++) {
            if (cache[i].filled && cache[i].key == key) return (true, i);
        }
        return (false, 0);
    }

    /**
     * @notice Pre-resolve one STATIC_CALL ref into `ctx.scCache` if not already present.
     * @dev The resolve-once primitive ActionLib drives before it resolves the target /
     *      checks constraints / resolves dynamic args: for a STATIC_CALL `ref` whose key is
     *      not yet cached, perform the bounded read ONCE and store (key, ok, word) into
     *      `ctx.scCache[nextFree]`, returning nextFree + 1. A non-STATIC_CALL ref, or a key
     *      already cached, is a no-op (returns nextFree unchanged). The caller pre-sizes
     *      `ctx.scCache` to the count of STATIC_CALL refs reachable in the call (an upper
     *      bound; distinct keys fill distinct slots, duplicates collapse). A self-targeted
     *      STATIC_CALL is intentionally NOT cached (left to resolve's no-self guard to revert
     *      StaticCallSelfTarget). Reverting/short reads are cached as ok=false, so the later
     *      REVERT-mode resolve still reverts and the ABSENT-mode left still skips — off ONE read.
     */
    function prewarmStaticCall(
        EvalContext memory ctx,
        AgreementTypes.ValueRef memory ref,
        uint256 nextFree
    ) internal view returns (uint256) {
        if (ref.source != AgreementTypes.ValueSource.STATIC_CALL) return nextFree;
        bytes32 key = keccak256(ref.data);
        (bool hit, ) = _findCacheEntry(ctx, key);
        if (hit) return nextFree;

        StaticCallSpec memory spec = _decodeStaticCallSpec(ref.data);
        // Leave a self-target uncached: resolve must still hit StaticCallSelfTarget on it.
        if (spec.target == ctx.self) return nextFree;

        (bool ok, bytes32 word) = _staticCall(spec);
        ctx.scCache[nextFree] = StaticCallCacheEntry({key: key, filled: true, ok: ok, word: word});
        return nextFree + 1;
    }

    /**
     * @notice Resolve-once the STATIC_CALL refs reachable across a SET of conditions evaluated
     *         on one submission, pre-filling `ctx.scCache` so every condition that references the
     *         same STATIC_CALL spec sees the SAME (first-read) word.
     * @dev The condition/guard-path twin of ActionLib._prewarmStaticCalls (which prewarms one
     *      call's refs): the engine's _validateConditions evaluates EVERY condition for an input
     *      against ONE shared EvalContext, so without prewarming a STATIC_CALL referenced by two
     *      conditions (e.g. `SC GTE min` and `SC LTE max`) is read TWICE and a non-deterministic /
     *      manipulable target can return DIFFERENT words within one submission — a within-submit
     *      read-inconsistency / single-tx spot-manipulation vector that can flip which transitions
     *      are permitted. This pre-reads each distinct reachable STATIC_CALL ONCE up front.
     *
     *      Reachable refs across the set: every condition's left ref and all of its right operands.
     *      `ctx.scCache` is (re)sized to an upper bound (the count of those candidate refs);
     *      prewarmStaticCall fills a slot per distinct STATIC_CALL key, no-ops a non-STATIC_CALL
     *      ref or an already-cached key, and leaves a self-target uncached (resolve still reverts
     *      StaticCallSelfTarget) — so distinct reads occupy distinct slots and duplicates collapse
     *      onto one read. The caller builds `ctx` fresh per submission, so the cache is per-
     *      submission isolated (a later submission legitimately re-reads), mirroring the per-call
     *      isolation on the action path.
     */
    function prewarmConditions(
        EvalContext memory ctx,
        AgreementTypes.Condition[] memory conds
    ) internal view {
        // Upper bound on candidate refs: each condition's left + every right operand.
        uint256 cap;
        for (uint256 i = 0; i < conds.length; i++) {
            cap += 1 + conds[i].right.length;
        }
        ctx.scCache = new StaticCallCacheEntry[](cap);

        uint256 n;
        for (uint256 i = 0; i < conds.length; i++) {
            AgreementTypes.Condition memory cn = conds[i];
            n = prewarmStaticCall(ctx, cn.left, n);
            for (uint256 j = 0; j < cn.right.length; j++) {
                n = prewarmStaticCall(ctx, cn.right[j], n);
            }
        }
    }

    // ------------------------------------------------------------------
    // comparison primitives (per-type legality)
    // ------------------------------------------------------------------

    function _compare(
        AgreementTypes.FieldType lt,
        bytes memory lv,
        AgreementTypes.CmpOp op,
        AgreementTypes.FieldType rt,
        bytes memory rv
    ) private pure returns (bool) {
        if (op == AgreementTypes.CmpOp.EQ) return _equals(lt, lv, rt, rv);
        if (op == AgreementTypes.CmpOp.NEQ) return !_equals(lt, lv, rt, rv);

        // Ordered comparisons are UINT256-only. Other types revert IllegalComparison
        // (string length comparisons go through FIELD_LENGTH -> UINT256, never
        // ordered-on-STRING). This is the eval-time backstop to validateLegality.
        if (
            op == AgreementTypes.CmpOp.GT ||
            op == AgreementTypes.CmpOp.GTE ||
            op == AgreementTypes.CmpOp.LT ||
            op == AgreementTypes.CmpOp.LTE
        ) {
            if (lt != AgreementTypes.FieldType.UINT256 || rt != AgreementTypes.FieldType.UINT256) {
                revert AgreementTypes.IllegalComparison(lt, op);
            }
            uint256 a = abi.decode(lv, (uint256));
            uint256 b = abi.decode(rv, (uint256));
            if (op == AgreementTypes.CmpOp.GT) return a > b;
            if (op == AgreementTypes.CmpOp.GTE) return a >= b;
            if (op == AgreementTypes.CmpOp.LT) return a < b;
            return a <= b; // LTE
        }

        revert AgreementTypes.IllegalComparison(lt, op);
    }

    /// @dev Equality over the uniform (FieldType, bytes) store, defined for every type.
    ///      Fixed-width types (UINT256/ADDRESS/BOOL/BYTES32) compare by decoded value;
    ///      dynamic types (STRING/BYTES) compare by keccak256 of their bytes — so two
    ///      semantically-equal values compare equal regardless of compare-representation
    ///      (the canonical-encoding discipline keeps storage and compare forms aligned).
    function _equals(
        AgreementTypes.FieldType lt,
        bytes memory lv,
        AgreementTypes.FieldType rt,
        bytes memory rv
    ) private pure returns (bool) {
        if (lt != rt) revert AgreementTypes.TypeMismatch(lt, rt);

        if (lt == AgreementTypes.FieldType.UINT256) {
            return abi.decode(lv, (uint256)) == abi.decode(rv, (uint256));
        }
        if (lt == AgreementTypes.FieldType.STRING) {
            // keccak256(bytes(s)) equality, matching the legacy string evaluators.
            return
                keccak256(bytes(abi.decode(lv, (string)))) ==
                keccak256(bytes(abi.decode(rv, (string))));
        }
        if (lt == AgreementTypes.FieldType.ADDRESS) {
            return abi.decode(lv, (address)) == abi.decode(rv, (address));
        }
        if (lt == AgreementTypes.FieldType.BOOL) {
            return abi.decode(lv, (bool)) == abi.decode(rv, (bool));
        }
        if (lt == AgreementTypes.FieldType.BYTES32) {
            return abi.decode(lv, (bytes32)) == abi.decode(rv, (bytes32));
        }
        // BYTES: keccak256 of the raw bytes payload (dynamic, like STRING).
        return keccak256(abi.decode(lv, (bytes))) == keccak256(abi.decode(rv, (bytes)));
    }

    /// @dev True if `left` targets an input field (FIELD / FIELD_LENGTH) that is not
    ///      present in the submission. Non-field sources are never "absent".
    function _leftFieldAbsent(AgreementTypes.ValueRef memory left, EvalContext memory ctx)
        private
        pure
        returns (bool)
    {
        if (
            left.source != AgreementTypes.ValueSource.FIELD &&
            left.source != AgreementTypes.ValueSource.FIELD_LENGTH
        ) {
            return false;
        }
        bytes32 fieldId = abi.decode(left.data, (bytes32));
        (bool found, ) = _findField(ctx.fields, fieldId);
        return !found;
    }

    /**
     * @dev Resolve a condition's LEFT operand in a SINGLE pass, reporting the two "absent ->
     *      skip-as-satisfied" notions via `absent` (so an ABSENT-mode STATIC_CALL left is read
     *      exactly once — never probed then re-resolved, the Major double-call fix):
     *        - skipIfAbsent FIELD/FIELD_LENGTH whose input field is missing  -> absent.
     *        - ABSENT-mode STATIC_CALL whose bounded read FAILS              -> absent (the
     *          griefing-resistance skip; a reverting/griefing read in one guard candidate is
     *          treated as absent rather than aborting evaluation of later candidates).
     *      On a SUCCEEDING ABSENT-mode STATIC_CALL the read just performed is decoded and
     *      returned directly — no second external read. Every other case (and a REVERT-mode
     *      STATIC_CALL) falls through to a normal `resolve`, which reverts on a real failure.
     *      A self-targeted STATIC_CALL is never "absent" — it falls through so resolve's
     *      no-self guard (StaticCallSelfTarget) still fires.
     */
    function _resolveLeft(
        AgreementTypes.ValueRef memory left,
        bool skipIfAbsent,
        EvalContext memory ctx,
        mapping(bytes32 => StoredVar) storage vars
    ) private view returns (bool absent, AgreementTypes.FieldType lt, bytes memory lv) {
        if (skipIfAbsent && _leftFieldAbsent(left, ctx)) {
            return (true, AgreementTypes.FieldType.UINT256, "");
        }

        if (left.source == AgreementTypes.ValueSource.STATIC_CALL) {
            StaticCallSpec memory spec = _decodeStaticCallSpec(left.data);
            if (spec.failMode == FAIL_MODE_ABSENT && spec.target != ctx.self) {
                // ONE read: fail -> absent (skip); success -> decode that same word here, so a
                // successful ABSENT-mode left is read exactly once (no probe-then-resolve).
                (bool ok, bytes32 word) = _readStaticCall(left, spec, ctx);
                if (!ok) return (true, AgreementTypes.FieldType.UINT256, "");
                return (false, left.vType, canonicalWord(left.vType, word));
            }
        }

        (lt, lv) = resolve(left, ctx, vars);
    }

    function _findField(Field[] memory fields, bytes32 fieldId)
        private
        pure
        returns (bool, Field memory)
    {
        for (uint256 i = 0; i < fields.length; i++) {
            if (fields[i].id == fieldId) return (true, fields[i]);
        }
        return (false, Field({id: bytes32(0), fType: AgreementTypes.FieldType.UINT256, data: ""}));
    }
}
