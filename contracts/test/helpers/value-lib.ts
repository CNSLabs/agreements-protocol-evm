/**
 * Shared helpers for ValueLib unit tests.
 *
 * Enum mirrors, canonical encoders, ValueRef / Condition / Field builders, and a
 * deploy helper for the ValueLibHarness. Kept free of test assertions so both the
 * matrix test and property tests draw from one vocabulary.
 */

import { ethers } from "hardhat";

const coder = ethers.AbiCoder.defaultAbiCoder();

// ---------------------------------------------------------------------------
// Enum mirrors (must match the Solidity enums in AgreementTypes)
// ---------------------------------------------------------------------------

export const FieldType = {
  UINT256: 0,
  STRING: 1,
  ADDRESS: 2,
  BOOL: 3,
  BYTES32: 4,
  BYTES: 5,
} as const;
export type FieldTypeVal = (typeof FieldType)[keyof typeof FieldType];

export const ValueSource = {
  CONST: 0,
  VAR: 1,
  FIELD: 2,
  FIELD_LENGTH: 3,
  AUTH_SIGNER: 4,
  CALLER: 5,
  SELF: 6,
  NOW: 7,
  STATIC_CALL: 8,
} as const;
export type ValueSourceVal = (typeof ValueSource)[keyof typeof ValueSource];

export const CmpOp = {
  EQ: 0,
  NEQ: 1,
  GT: 2,
  GTE: 3,
  LT: 4,
  LTE: 5,
  IN: 6,
  NOT_IN: 7,
} as const;
export type CmpOpVal = (typeof CmpOp)[keyof typeof CmpOp];

// ---------------------------------------------------------------------------
// Canonical encoders — the single stored encoding per FieldType.
// Each value type is abi.encode(value); STRING/BYTES are abi.encode(dynamic).
// ---------------------------------------------------------------------------

export function encUint(v: bigint | number): string {
  return coder.encode(["uint256"], [v]);
}
export function encString(v: string): string {
  return coder.encode(["string"], [v]);
}
export function encAddress(v: string): string {
  return coder.encode(["address"], [v]);
}
export function encBool(v: boolean): string {
  return coder.encode(["bool"], [v]);
}
export function encBytes32(v: string): string {
  return coder.encode(["bytes32"], [v]);
}
export function encBytes(v: string): string {
  return coder.encode(["bytes"], [v]);
}

/** Canonical encode a value for a given FieldType. */
export function encFor(fType: FieldTypeVal, v: any): string {
  switch (fType) {
    case FieldType.UINT256:
      return encUint(v);
    case FieldType.STRING:
      return encString(v);
    case FieldType.ADDRESS:
      return encAddress(v);
    case FieldType.BOOL:
      return encBool(v);
    case FieldType.BYTES32:
      return encBytes32(v);
    case FieldType.BYTES:
      return encBytes(v);
    default:
      throw new Error(`unknown FieldType ${fType}`);
  }
}

// ---------------------------------------------------------------------------
// ValueRef / Condition / Field builders (tuple shapes the harness expects)
// ---------------------------------------------------------------------------

export interface ValueRef {
  source: ValueSourceVal;
  vType: FieldTypeVal;
  data: string;
}

export interface Condition {
  left: ValueRef;
  op: CmpOpVal;
  skipIfAbsent: boolean;
  right: ValueRef[];
}

export interface FieldInput {
  id: string;
  fType: FieldTypeVal;
  data: string;
}

/** CONST ref holding a canonical-encoded literal of the given type. */
export function constRef(fType: FieldTypeVal, v: any): ValueRef {
  return { source: ValueSource.CONST, vType: fType, data: encFor(fType, v) };
}

/** VAR ref pointing at a stored variable id. */
export function varRef(fType: FieldTypeVal, varId: string): ValueRef {
  return { source: ValueSource.VAR, vType: fType, data: coder.encode(["bytes32"], [varId]) };
}

/** FIELD ref pointing at an input field id. */
export function fieldRef(fType: FieldTypeVal, fieldId: string): ValueRef {
  return { source: ValueSource.FIELD, vType: fType, data: coder.encode(["bytes32"], [fieldId]) };
}

/** FIELD_LENGTH ref (resolves to UINT256 byte length of a STRING/BYTES field). */
export function fieldLengthRef(fieldId: string): ValueRef {
  return {
    source: ValueSource.FIELD_LENGTH,
    vType: FieldType.UINT256,
    data: coder.encode(["bytes32"], [fieldId]),
  };
}

/** Synthesized-source ref (AUTH_SIGNER / CALLER / SELF / NOW). data is unused. */
export function synthRef(source: ValueSourceVal, fType: FieldTypeVal): ValueRef {
  return { source, vType: fType, data: "0x" };
}

// ---------------------------------------------------------------------------
// STATIC_CALL (R6): a bounded read-only external call decoded to one canonical word.
// ref.data ABI-encodes a StaticCallSpec tuple (must match the Solidity struct order):
//   (address target, bytes4 selector, bytes args, uint256 gas, uint16 maxReturnBytes,
//    uint8 failMode)
// ---------------------------------------------------------------------------

/** Fail mode for a STATIC_CALL ValueRef. */
export const FailMode = {
  REVERT: 0,
  ABSENT: 1,
} as const;
export type FailModeVal = (typeof FailMode)[keyof typeof FailMode];

export const STATIC_CALL_SPEC_TUPLE =
  "(address target, bytes4 selector, bytes args, uint256 gas, uint16 maxReturnBytes, uint8 failMode)";

export interface StaticCallSpec {
  target: string;
  selector: string; // bytes4
  args: string; // bytes (pre-baked CONST args; may be "0x")
  gas: bigint | number;
  maxReturnBytes: number;
  failMode: FailModeVal;
}

/** ABI-encode a StaticCallSpec into the `data` field of a STATIC_CALL ValueRef. */
export function encStaticCallSpec(spec: StaticCallSpec): string {
  return coder.encode(
    [STATIC_CALL_SPEC_TUPLE],
    [[spec.target, spec.selector, spec.args, spec.gas, spec.maxReturnBytes, spec.failMode]]
  );
}

/** STATIC_CALL ref decoding the first return word to `fType`. */
export function staticCallRef(
  fType: FieldTypeVal,
  spec: Partial<StaticCallSpec> & { target: string; selector: string }
): ValueRef {
  const full: StaticCallSpec = {
    target: spec.target,
    selector: spec.selector,
    args: spec.args ?? "0x",
    gas: spec.gas ?? 100_000n,
    maxReturnBytes: spec.maxReturnBytes ?? 32,
    failMode: spec.failMode ?? FailMode.REVERT,
  };
  return { source: ValueSource.STATIC_CALL, vType: fType, data: encStaticCallSpec(full) };
}

/** Raw ref with arbitrary source/type/data (for injecting malformed encodings in tests). */
export function rawRef(source: ValueSourceVal, fType: FieldTypeVal, data: string): ValueRef {
  return { source, vType: fType, data };
}

/** A field input row for the harness EvalContext. */
export function field(fType: FieldTypeVal, fieldId: string, v: any): FieldInput {
  return { id: fieldId, fType, data: encFor(fType, v) };
}

/** Build a Condition. `right` may be a single ref or an array. */
export function cond(
  left: ValueRef,
  op: CmpOpVal,
  right: ValueRef | ValueRef[],
  skipIfAbsent = false
): Condition {
  return { left, op, skipIfAbsent, right: Array.isArray(right) ? right : [right] };
}

// ---------------------------------------------------------------------------
// Deploy
// ---------------------------------------------------------------------------

let _harness: any | null = null;

/** Deploy (and cache) the ValueLibHarness real contract — no mocks. */
export async function deployValueLibHarness(): Promise<any> {
  if (_harness) return _harness;
  _harness = await ethers.deployContract("ValueLibHarness");
  await _harness.waitForDeployment();
  return _harness;
}

/** Force a fresh harness (used when a test needs an isolated var store). */
export async function freshValueLibHarness(): Promise<any> {
  const h = await ethers.deployContract("ValueLibHarness");
  await h.waitForDeployment();
  return h;
}

/** Convenient bytes32 id from a label. */
export function id(label: string): string {
  return ethers.id(label);
}

export { coder };
