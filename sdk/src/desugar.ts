/**
 * Off-chain legacy -> canonical/composable desugar.
 *
 * The AgreementEngine is composable-only: it ingests canonical `Condition`s over `ValueRef`s
 * and composable `Call[]` actions, and has NO on-chain legacy `Op` encoding or desugar. This
 * module is the off-chain port of what `OpDesugarLib` and `ActionLib.encodeLegacyCall` did
 * on-chain — it translates the transformer's legacy intermediate representation (legacy `Op`
 * conditions + static `ActionInit`s) into the composable shape the engine accepts:
 *
 *   - legacy `Op` condition -> one canonical `(left, op, right)` over `ValueRef`s
 *     (the ~18-variant `{TYPE}_{COMPARISON}_{SOURCE}` matrix), with a condition on an
 *     OPTIONAL field marked `IF_PRESENT` (skipIfAbsent) to reproduce legacy skip-if-absent;
 *   - static `ActionInit {target, value, data}` -> one composable `Call` with a CONST(address)
 *     target and one baked constant ArgSlot per 32-byte word of `data` (no substitutions),
 *     composing back to byte-identical calldata (the `encodeLegacyCall` word composition).
 *
 * The parity guarantee (legacy authoring reproduces the prior engine's observable behavior)
 * therefore holds across "SDK desugar + canonical engine".
 */

import { encodeAbiParameters, decodeAbiParameters, Hex } from "viem";
import {
  CreateAgreementParams,
  ComposableCreateParams,
  InputDef,
  InputDefInit,
  ActionInit,
  Op,
  FieldType,
  ValueSource,
  CmpOp,
  ValueRef,
  CanonicalCondition,
  Call,
  ArgSlot,
  ComposableActionInit,
  CanonicalConditionInit,
} from "./types.js";

const ZERO_BYTES32 =
  "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex;
const ZERO_REF: ValueRef = { source: ValueSource.CONST, vType: FieldType.UINT256, data: "0x" as Hex };

// ---------------------------------------------------------------------------
// ABI tuple definitions (must match AgreementTypes / ActionLib struct layouts).
// ---------------------------------------------------------------------------

const VALUE_REF_TUPLE = {
  type: "tuple",
  components: [
    { name: "source", type: "uint8" },
    { name: "vType", type: "uint8" },
    { name: "data", type: "bytes" },
  ],
} as const;

const CONDITION_TUPLE = {
  type: "tuple",
  components: [
    { ...VALUE_REF_TUPLE, name: "left" },
    { name: "op", type: "uint8" },
    { name: "skipIfAbsent", type: "bool" },
    { ...VALUE_REF_TUPLE, type: "tuple[]", name: "right" },
  ],
} as const;

const ARG_SLOT_TUPLE = {
  type: "tuple",
  components: [
    { name: "dynamic", type: "bool" },
    { name: "constWord", type: "bytes32" },
    { ...VALUE_REF_TUPLE, name: "value" },
  ],
} as const;

const OUTPUT_TUPLE = {
  type: "tuple",
  components: [
    { name: "returnIndex", type: "uint256" },
    { name: "outType", type: "uint8" },
    { name: "targetVar", type: "bytes32" },
  ],
} as const;

const CALL_TUPLE = {
  type: "tuple",
  components: [
    { ...VALUE_REF_TUPLE, name: "target" },
    { name: "selector", type: "bytes4" },
    { ...ARG_SLOT_TUPLE, type: "tuple[]", name: "args" },
    { ...CONDITION_TUPLE, type: "tuple[]", name: "constraints" },
    { ...OUTPUT_TUPLE, type: "tuple[]", name: "outputs" },
  ],
} as const;

/** ABI-encode a canonical Condition[] (the engine's CanonicalConditionInit.encodedConditions). */
export function encodeConditions(conditions: CanonicalCondition[]): Hex {
  return encodeAbiParameters([{ ...CONDITION_TUPLE, type: "tuple[]" }], [conditions]) as Hex;
}

/** ABI-encode a composable Call[] (the engine's ComposableActionInit.encodedCalls). */
export function encodeCalls(calls: Call[]): Hex {
  return encodeAbiParameters([{ ...CALL_TUPLE, type: "tuple[]" }], [calls]) as Hex;
}

// ---------------------------------------------------------------------------
// Condition desugar (legacy Op -> canonical Condition).
// Mirrors OpDesugarLib._desugar; `skipIfAbsent` is set from the field's optionality.
// ---------------------------------------------------------------------------

const ref = (source: ValueSource, vType: FieldType, data: Hex): ValueRef => ({ source, vType, data });
const fieldData = (fieldId: Hex): Hex => encodeAbiParameters([{ type: "bytes32" }], [fieldId]) as Hex;

/** UINT_*_CONST/VAR op -> canonical CmpOp (legacy VAR ops are CONST ops + 5). */
function uintCmp(op: Op): CmpOp {
  let n = op;
  if (op >= Op.UINT_EQ_VAR) n = (op - 5) as Op;
  switch (n) {
    case Op.UINT_EQ_CONST:
      return CmpOp.EQ;
    case Op.UINT_GT_CONST:
      return CmpOp.GT;
    case Op.UINT_GTE_CONST:
      return CmpOp.GTE;
    case Op.UINT_LT_CONST:
      return CmpOp.LT;
    default:
      return CmpOp.LTE; // UINT_LTE_CONST
  }
}

/** Decode a legacy *_VAR condition's bytesArg (abi.encode(bytes32 varId)). */
function decodeVarId(bytesArg: Hex): Hex {
  return decodeAbiParameters([{ type: "bytes32" }], bytesArg)[0] as Hex;
}

/** FIELD EQ CONST/VAR shape for STRING / ADDRESS equality ops. */
function eqCondition(
  fieldId: Hex,
  bytesArg: Hex,
  vType: FieldType,
  isVar: boolean,
  skipIfAbsent: boolean
): CanonicalCondition {
  const right = isVar
    ? ref(ValueSource.VAR, vType, fieldData(decodeVarId(bytesArg)))
    : ref(ValueSource.CONST, vType, bytesArg);
  return {
    left: ref(ValueSource.FIELD, vType, fieldData(fieldId)),
    op: CmpOp.EQ,
    skipIfAbsent,
    right: [right],
  };
}

/**
 * Desugar one legacy condition into exactly one canonical Condition.
 * @param op/fieldId/bytesArg the legacy condition fields.
 * @param fieldOptional whether the targeted field is optional (-> IF_PRESENT).
 */
export function desugarCondition(
  op: Op,
  fieldId: Hex,
  bytesArg: Hex,
  fieldOptional: boolean
): CanonicalCondition {
  // --- UINT family: FIELD(uint) <op> CONST(uint) | VAR(uint) ---
  if (op >= Op.UINT_EQ_CONST && op <= Op.UINT_LTE_VAR) {
    const isVar = op >= Op.UINT_EQ_VAR;
    const right = isVar
      ? ref(ValueSource.VAR, FieldType.UINT256, fieldData(decodeVarId(bytesArg)))
      : ref(ValueSource.CONST, FieldType.UINT256, bytesArg);
    return {
      left: ref(ValueSource.FIELD, FieldType.UINT256, fieldData(fieldId)),
      op: uintCmp(op),
      skipIfAbsent: fieldOptional,
      right: [right],
    };
  }

  // --- STRING length ops: FIELD_LENGTH(field) GTE|LTE CONST(uint) ---
  if (op === Op.STRING_MIN_LENGTH || op === Op.STRING_MAX_LENGTH) {
    return {
      left: ref(ValueSource.FIELD_LENGTH, FieldType.UINT256, fieldData(fieldId)),
      op: op === Op.STRING_MIN_LENGTH ? CmpOp.GTE : CmpOp.LTE,
      skipIfAbsent: fieldOptional,
      right: [ref(ValueSource.CONST, FieldType.UINT256, bytesArg)],
    };
  }

  // --- STRING equality ops ---
  if (op === Op.STRING_EQ_CONST || op === Op.STRING_EQ_VAR) {
    return eqCondition(fieldId, bytesArg, FieldType.STRING, op === Op.STRING_EQ_VAR, fieldOptional);
  }

  // --- ADDRESS equality ops ---
  if (op === Op.ADDRESS_EQ_CONST || op === Op.ADDRESS_EQ_VAR) {
    return eqCondition(fieldId, bytesArg, FieldType.ADDRESS, op === Op.ADDRESS_EQ_VAR, fieldOptional);
  }

  // --- SENDER equality: AUTH_SIGNER EQ VAR(address, fieldId) ---
  // Legacy reads vars[fieldId] (the field slot doubles as the var id; bytesArg is ignored).
  if (op === Op.SENDER_EQ_VAR_ADDRESS) {
    return {
      left: ref(ValueSource.AUTH_SIGNER, FieldType.ADDRESS, "0x" as Hex),
      op: CmpOp.EQ,
      skipIfAbsent: fieldOptional,
      right: [ref(ValueSource.VAR, FieldType.ADDRESS, fieldData(fieldId))],
    };
  }

  // --- SENDER membership: AUTH_SIGNER IN [VAR(address)..., CONST(address)...] ---
  // bytesArg = abi.encode(bytes32[] allowedVarFieldIds, address[] allowedAddresses).
  // VARs emitted first (legacy checks stored-var membership before literals).
  if (op === Op.SENDER_IN_ALLOWED_ADDRESSES) {
    const [varIds, addrs] = decodeAbiParameters(
      [{ type: "bytes32[]" }, { type: "address[]" }],
      bytesArg
    ) as [readonly Hex[], readonly Hex[]];
    const right: ValueRef[] = [];
    for (const v of varIds) right.push(ref(ValueSource.VAR, FieldType.ADDRESS, fieldData(v)));
    for (const a of addrs) {
      right.push(ref(ValueSource.CONST, FieldType.ADDRESS, encodeAbiParameters([{ type: "address" }], [a]) as Hex));
    }
    return {
      left: ref(ValueSource.AUTH_SIGNER, FieldType.ADDRESS, "0x" as Hex),
      op: CmpOp.IN,
      skipIfAbsent: fieldOptional,
      right,
    };
  }

  throw new Error(`desugarCondition: unsupported legacy Op ${op}`);
}

/**
 * Desugar a legacy input def into (composable input def, canonical conditions).
 * The composable InputDefInit drops the conditions; each legacy condition becomes a canonical
 * condition. A condition on an optional field (required === false) is marked IF_PRESENT.
 */
function desugarInputDef(d: InputDef): { input: InputDefInit; conditions: CanonicalCondition[] } {
  const optionalByFieldId = new Map<string, boolean>();
  for (const f of d.fields) optionalByFieldId.set(f.fieldId.toLowerCase(), !f.required);

  const conditions = d.conditions.map((c) =>
    desugarCondition(c.op, c.fieldId, c.bytesArg, optionalByFieldId.get(c.fieldId.toLowerCase()) ?? false)
  );

  return {
    input: { id: d.id, fields: d.fields, verifierKeys: d.verifierKeys },
    conditions,
  };
}

// ---------------------------------------------------------------------------
// Action desugar (legacy ActionInit -> composable Call[]).
// Mirrors ActionLib.encodeLegacyCall: data = selector ++ N 32-byte words; one baked
// constant ArgSlot per word, CONST(address) target, no substitutions.
// ---------------------------------------------------------------------------

/**
 * Desugar a legacy static action's `(target, data)` into a single composable Call.
 * `data` = selector (4 bytes) ++ N fixed-size argument words (32 bytes each). Native value
 * is dropped from the base model (the engine carries no ETH), so a non-zero `value` is
 * rejected, matching the prior on-chain LegacyActionValueUnsupported guard.
 */
export function legacyActionToCall(target: Hex, value: bigint, data: Hex): Call {
  if (value !== 0n) {
    throw new Error(`legacyActionToCall: native value unsupported (value=${value}); the engine carries no ETH`);
  }
  const hex = data.startsWith("0x") ? data.slice(2) : data;
  if (hex.length < 8) throw new Error(`legacyActionToCall: data shorter than a 4-byte selector (${hex.length / 2} bytes)`);
  const argHex = hex.slice(8);
  if (argHex.length % 64 !== 0) {
    throw new Error(`legacyActionToCall: arg bytes not word-aligned (${argHex.length / 2} bytes)`);
  }
  const nArgs = argHex.length / 64;
  const selector = ("0x" + hex.slice(0, 8)) as Hex;
  const args: ArgSlot[] = [];
  for (let i = 0; i < nArgs; i++) {
    const word = ("0x" + argHex.slice(i * 64, (i + 1) * 64)) as Hex;
    args.push({ dynamic: false, constWord: word, value: ZERO_REF });
  }
  return {
    target: ref(ValueSource.CONST, FieldType.ADDRESS, encodeAbiParameters([{ type: "address" }], [target]) as Hex),
    selector,
    args,
    constraints: [],
    outputs: [],
  };
}

// ---------------------------------------------------------------------------
// Top-level desugar (legacy IR -> composable params).
// ---------------------------------------------------------------------------

/**
 * Desugar the transformer's legacy IR (legacy Op conditions + static ActionInits) into the
 * composable params the engine ingests. The PUBLIC SDK surface (createAgreement(json, …) +
 * AgreementJson) is unchanged; this is the internal compile step that bridges the legacy
 * authoring shape to the composable-only engine.
 */
export function desugarToComposable(params: CreateAgreementParams): ComposableCreateParams {
  const inputDefs: InputDefInit[] = [];
  const canonicalConds: CanonicalConditionInit[] = [];
  for (const d of params.inputDefs) {
    const { input, conditions } = desugarInputDef(d);
    inputDefs.push(input);
    if (conditions.length > 0) {
      canonicalConds.push({ inputId: d.id, encodedConditions: encodeConditions(conditions) });
    }
  }

  const actions: ComposableActionInit[] = params.actions.map((a: ActionInit) => ({
    fromState: a.fromState,
    inputId: a.inputId,
    encodedCalls: encodeCalls([legacyActionToCall(a.target, a.value, a.data)]),
  }));

  return {
    docUri: params.docUri,
    docHash: params.docHash,
    initialState: params.initialState,
    inputDefs,
    transitions: params.transitions,
    initVars: params.initVars,
    actions,
    canonicalConds,
    verifiers: [], // the JSON authoring path registers no verifiers (matching prior behavior)
  };
}

export { ZERO_BYTES32 };
