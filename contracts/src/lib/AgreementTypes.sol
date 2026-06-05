// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.20;

/**
 * @title AgreementTypes
 * @notice Canonical data model for the agreement engine: the value-resolution core.
 * @dev Shared enums, structs, and custom errors. No logic, no state.
 *
 *      The full source/type/op surface is declared so ValueLib has a stable, general
 *      type surface. ValueLib resolves/compares the full type set
 *      (UINT256/STRING/ADDRESS/BOOL/BYTES32/BYTES) and every source, including STATIC_CALL
 *      (R6: the bounded read-only external read). Legacy `Op`-encoded conditions are
 *      desugared into these canonical `Condition`s OFF-CHAIN by the SDK (§6); there is no
 *      on-chain legacy condition encoding.
 */
library AgreementTypes {
    // ------------------------------------------------------------------
    // Canonical field types. The leading five variants match the legacy
    // FieldType ordinals, so abi-encoded field/var data round-trips across the
    // legacy-condition desugar boundary; BYTES is the canonical-only addition.
    // ------------------------------------------------------------------
    enum FieldType {
        UINT256, // 0
        STRING, // 1
        ADDRESS, // 2
        BOOL, // 3
        BYTES32, // 4
        BYTES // 5 (canonical-only)
    }

    // ------------------------------------------------------------------
    // Value-resolution core: where a value comes from.
    // ------------------------------------------------------------------
    enum ValueSource {
        CONST, // literal fixed at creation (data = abi.encode(value))
        VAR, // stored agreement variable (data = abi.encode(bytes32 varId))
        FIELD, // a field of the submitted input (data = abi.encode(bytes32 fieldId))
        FIELD_LENGTH, // byte length of a STRING/BYTES input field (data = fieldId)
        AUTH_SIGNER, // authorizing identity: permit signer, else msg.sender
        CALLER, // actual msg.sender (the relayer under permit)
        SELF, // the agreement's own address
        NOW, // block.timestamp
        STATIC_CALL // bounded read-only external call result (data = abi.encode(StaticCallSpec))
    }

    enum CmpOp {
        EQ,
        NEQ,
        GT,
        GTE,
        LT,
        LTE,
        IN,
        NOT_IN
    }

    struct ValueRef {
        ValueSource source;
        FieldType vType;
        bytes data;
    }

    /// @dev right holds 1 scalar for EQ/NEQ/GT/GTE/LT/LTE, or N for IN / NOT_IN.
    ///      skipIfAbsent (IF_PRESENT): when true and the left operand targets an input
    ///      field that is absent, the condition is skipped (treated as satisfied)
    ///      instead of reverting. Default false: an absent target field reverts.
    struct Condition {
        ValueRef left;
        CmpOp op;
        bool skipIfAbsent;
        ValueRef[] right;
    }

    // ------------------------------------------------------------------
    // Errors: the typed reverts raised while resolving and comparing values.
    // ------------------------------------------------------------------
    error ComparisonFailed(); // a Condition evaluated to false
    error IllegalComparison(FieldType vType, CmpOp op); // op not legal for this type
    error TypeMismatch(FieldType expected, FieldType actual);
    error VarNotSet(bytes32 varId);
    error FieldAbsent(bytes32 fieldId); // a condition targeted a field absent from the input
    error UnsupportedSource(ValueSource source); // value source not yet resolvable
    error SelfReferentialVar(bytes32 varId); // self-referential persisted-field VAR, rejected at init
    /// @notice A persisted input field was declared required=false. Rejected at init.
    /// @dev persist=true means the field's submitted value is auto-written into vars[fieldId]
    ///      before conditions/actions run. If such a field were optional it could be omitted on
    ///      a later submission, leaving the var at a STALE prior value while a skipIfAbsent guard
    ///      is skipped and an action still spends VAR(fieldId). Requiring required=true makes the
    ///      "a persisted field is always present" invariant hold (the invariant _persistFields
    ///      already assumes). `inputId`/`fieldId` name the offending field.
    error PersistRequiresRequired(bytes32 inputId, bytes32 fieldId);
    error ArityMismatch(CmpOp op, uint256 rightLength); // wrong number of RHS operands for the op
    error MalformedValue(FieldType vType); // a value's bytes are not the canonical encoding of vType
    error StaticCallFailed(address target); // a bounded STATIC_CALL reverted, ran out of its gas
    // stipend, or returned fewer than 32 bytes — in REVERT fail mode this aborts resolution
    error StaticCallSelfTarget(); // a STATIC_CALL resolved target == address(this) (no-self)
    error MalformedStaticCallSpec(); // a STATIC_CALL spec is structurally invalid at init
    /// @notice An init-time bounded-evaluation cap was exceeded by the supplied config.
    /// @dev Shared across the engine, ValueLib, and ActionLib so every init-time cap raises
    ///      one decodable error shape. `what` names the violated cap (a short literal cap
    ///      name, one word), `got` is the supplied count, `max` is the cap. Caps bound how
    ///      much work a submit-time evaluation can be made to do, so a griefing config author
    ///      cannot gas-bomb a counterparty at submit time. See each lib's CONFIG/ACTION caps.
    error ConfigCapExceeded(bytes32 what, uint256 got, uint256 max);
}
