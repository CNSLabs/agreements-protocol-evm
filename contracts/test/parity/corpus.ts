/**
 * Differential parity corpus generator.
 *
 * Emits ParityCases: each is a self-contained agreement definition (single input,
 * single transition, one or more legacy-encoded `Op` conditions) plus a submission
 * payload. The same definition + payload is deployed to a frozen Legacy clone and a
 * new-engine clone; the harness asserts the observable tuple is identical between the
 * two engines (reverted, resulting currentState, persisted-var deltas) — except for
 * the two named exceptions (absent-optional-field condition reverts; self-referential
 * persisted-VAR condition rejected at init), which are flagged and asserted as
 * divergences.
 *
 * Each `Op` family is produced by its own generator function returning ParityCase[],
 * so a family can be added by appending a generator that pushes into the same corpus
 * shape with no harness changes.
 */

import { ethers } from "ethers";

const coder = ethers.AbiCoder.defaultAbiCoder();

// ---------------------------------------------------------------------------
// Enum mirrors (must match the Solidity enums in both engines)
// ---------------------------------------------------------------------------

// FieldType (legacy + canonical share the leading 5 variants; canonical adds BYTES)
export const FieldType = {
  UINT256: 0,
  STRING: 1,
  ADDRESS: 2,
  BOOL: 3,
  BYTES32: 4,
  BYTES: 5, // canonical-only
} as const;

// Legacy Op enum (LegacyAgreementEngine.Op)
export const Op = {
  STRING_MIN_LENGTH: 0,
  STRING_MAX_LENGTH: 1,
  STRING_EQ_CONST: 2,
  STRING_EQ_VAR: 3,
  UINT_EQ_CONST: 4,
  UINT_GT_CONST: 5,
  UINT_GTE_CONST: 6,
  UINT_LT_CONST: 7,
  UINT_LTE_CONST: 8,
  UINT_EQ_VAR: 9,
  UINT_GT_VAR: 10,
  UINT_GTE_VAR: 11,
  UINT_LT_VAR: 12,
  UINT_LTE_VAR: 13,
  ADDRESS_EQ_CONST: 14,
  ADDRESS_EQ_VAR: 15,
  SENDER_EQ_VAR_ADDRESS: 16,
  SENDER_IN_ALLOWED_ADDRESSES: 17,
} as const;

// ---------------------------------------------------------------------------
// Solidity struct shapes (tuples, in the order the engines expect)
// ---------------------------------------------------------------------------

export type FieldTypeVal = (typeof FieldType)[keyof typeof FieldType];

export interface InputFieldDef {
  fieldId: string; // bytes32
  fType: FieldTypeVal;
  required: boolean;
  persist: boolean;
}

export interface LegacyCondition {
  op: number;
  fieldId: string; // bytes32
  bytesArg: string; // hex bytes
}

export interface InputDef {
  id: string; // bytes32
  fields: InputFieldDef[];
  conditions: LegacyCondition[];
  verifierKeys: string[];
}

export interface Transition {
  fromState: string;
  toState: string;
  inputId: string;
}

export interface DataField {
  id: string; // bytes32
  fType: FieldTypeVal;
  data: string; // hex bytes
}

/** A single submission to drive the FSM. */
export interface Submission {
  inputId: string;
  fields: DataField[]; // becomes abi.encode(DataField[]) payload
  // How the submission is delivered. "direct" = submitInput from `submitterIndex`;
  // "permit" = submitInputWithPermit signed by `signerIndex`, relayed by `submitterIndex`.
  mode?: "direct" | "permit";
  // Index into ethers.getSigners() for the account that sends the tx (relayer under permit).
  submitterIndex?: number;
  // Index into ethers.getSigners() for the authorizing signer (permit mode). Defaults to submitterIndex.
  signerIndex?: number;
}

/** Which named exception (if any) the case is expected to exercise. */
export type NamedException = "none" | "absentOptionalField" | "selfReferentialVar";

export interface ParityCase {
  name: string;
  family: string; // e.g. "UINT"
  // init params
  initialState: string;
  inputDefs: InputDef[];
  transitions: Transition[];
  initVars: DataField[];
  // submission
  submission: Submission;
  // expectations
  // Ground truth: whether the corpus expects this submission to be ACCEPTED. The
  // harness asserts legacy's *actual* outcome equals this (anchoring parity to
  // ground truth, not just mutual agreement). A reject covers both submit-revert and
  // (for cases that intend it) any other non-accept outcome.
  expectAccept: boolean;
  expectedToState: string; // resulting currentState when accepted
  // Optional: the state the FSM should be in after a REJECTED submission. Defaults to
  // initialState (a rejected submission leaves currentState unchanged). For two-step
  // cases the "current" state before the failing input may not be initialState.
  expectedRejectState?: string;
  // The named-exception classification. For "none", the prior engine and the new
  // engine must agree. For the named exception the harness asserts the *divergence*
  // (the prior engine accepts; the new engine rejects at init), not parity.
  namedException: NamedException;
  // Whether the new engine must reject at initialize (self-referential VAR case).
  expectInitRevert?: boolean;
  // For multi-step cases: inputs to submit (in order) BEFORE the asserted submission,
  // each of which must be accepted (sets up persisted vars / advances state). The
  // final `submission` is the one whose accept/reject parity is asserted.
  priorSubmissions?: Submission[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const id = (s: string): string => ethers.id(s);
const encUint = (v: bigint): string => coder.encode(["uint256"], [v]);
const encBytes32 = (v: string): string => coder.encode(["bytes32"], [v]);

const STATE_START = id("START");
const STATE_DONE = id("DONE");
const MAX_UINT = (1n << 256n) - 1n;

/** Build a minimal single-input/single-transition agreement around one condition. */
function singleConditionCase(args: {
  name: string;
  family: string;
  field: InputFieldDef;
  condition: LegacyCondition;
  submittedField: DataField | null; // null = field omitted from payload
  initVars?: DataField[];
  expectAccept: boolean; // expected Legacy accept (when namedException === "none")
  namedException?: NamedException;
  expectInitRevert?: boolean;
  extraFields?: InputFieldDef[];
  extraSubmitted?: DataField[];
  mode?: "direct" | "permit";
  submitterIndex?: number;
  signerIndex?: number;
}): ParityCase {
  const inputId = id("INPUT");
  const fields = [args.field, ...(args.extraFields ?? [])];
  const submitted: DataField[] = [];
  if (args.submittedField) submitted.push(args.submittedField);
  if (args.extraSubmitted) submitted.push(...args.extraSubmitted);

  return {
    name: args.name,
    family: args.family,
    initialState: STATE_START,
    inputDefs: [
      {
        id: inputId,
        fields,
        conditions: [args.condition],
        verifierKeys: [],
      },
    ],
    transitions: [{ fromState: STATE_START, toState: STATE_DONE, inputId }],
    initVars: args.initVars ?? [],
    submission: {
      inputId,
      fields: submitted,
      mode: args.mode,
      submitterIndex: args.submitterIndex,
      signerIndex: args.signerIndex,
    },
    expectAccept: args.expectAccept,
    expectedToState: STATE_DONE,
    namedException: args.namedException ?? "none",
    expectInitRevert: args.expectInitRevert,
  };
}

// ---------------------------------------------------------------------------
// UINT family
// ---------------------------------------------------------------------------

const FID_AMOUNT = id("amount");
const VID_THRESHOLD = id("threshold");

interface UintOpSpec {
  op: number;
  name: string; // human label
  // predicate the legacy engine evaluates: fieldValue <op> compareValue
  pass: (field: bigint, compare: bigint) => boolean;
}

const UINT_CONST_OPS: UintOpSpec[] = [
  { op: Op.UINT_EQ_CONST, name: "EQ", pass: (a, b) => a === b },
  { op: Op.UINT_GT_CONST, name: "GT", pass: (a, b) => a > b },
  { op: Op.UINT_GTE_CONST, name: "GTE", pass: (a, b) => a >= b },
  { op: Op.UINT_LT_CONST, name: "LT", pass: (a, b) => a < b },
  { op: Op.UINT_LTE_CONST, name: "LTE", pass: (a, b) => a <= b },
];

const UINT_VAR_OPS: UintOpSpec[] = [
  { op: Op.UINT_EQ_VAR, name: "EQ", pass: (a, b) => a === b },
  { op: Op.UINT_GT_VAR, name: "GT", pass: (a, b) => a > b },
  { op: Op.UINT_GTE_VAR, name: "GTE", pass: (a, b) => a >= b },
  { op: Op.UINT_LT_VAR, name: "LT", pass: (a, b) => a < b },
  { op: Op.UINT_LTE_VAR, name: "LTE", pass: (a, b) => a <= b },
];

const amountField = (required = true, persist = false): InputFieldDef => ({
  fieldId: FID_AMOUNT,
  fType: FieldType.UINT256,
  required,
  persist,
});

/** Value clusters around a threshold: boundary / just-inside / just-outside, plus edges. */
function uintValueGrid(threshold: bigint): bigint[] {
  const grid = new Set<bigint>();
  grid.add(threshold); // boundary (equal)
  if (threshold > 0n) grid.add(threshold - 1n); // just below
  if (threshold < MAX_UINT) grid.add(threshold + 1n); // just above
  grid.add(0n); // min edge
  grid.add(MAX_UINT); // max edge
  return [...grid];
}

export function uintConstCases(): ParityCase[] {
  const cases: ParityCase[] = [];
  const thresholds = [0n, 1n, 100n, MAX_UINT];

  for (const spec of UINT_CONST_OPS) {
    for (const threshold of thresholds) {
      for (const fieldValue of uintValueGrid(threshold)) {
        cases.push(
          singleConditionCase({
            name: `UINT ${spec.name}_CONST field=${fieldValue} const=${threshold}`,
            family: "UINT",
            field: amountField(),
            condition: {
              op: spec.op,
              fieldId: FID_AMOUNT,
              bytesArg: encUint(threshold),
            },
            submittedField: { id: FID_AMOUNT, fType: FieldType.UINT256, data: encUint(fieldValue) },
            expectAccept: spec.pass(fieldValue, threshold),
          })
        );
      }
    }
  }
  return cases;
}

export function uintVarCases(): ParityCase[] {
  const cases: ParityCase[] = [];
  const thresholds = [0n, 1n, 100n, MAX_UINT];

  for (const spec of UINT_VAR_OPS) {
    for (const threshold of thresholds) {
      for (const fieldValue of uintValueGrid(threshold)) {
        cases.push(
          singleConditionCase({
            name: `UINT ${spec.name}_VAR field=${fieldValue} var(threshold)=${threshold}`,
            family: "UINT",
            field: amountField(),
            condition: {
              op: spec.op,
              fieldId: FID_AMOUNT,
              bytesArg: encBytes32(VID_THRESHOLD),
            },
            submittedField: { id: FID_AMOUNT, fType: FieldType.UINT256, data: encUint(fieldValue) },
            initVars: [{ id: VID_THRESHOLD, fType: FieldType.UINT256, data: encUint(threshold) }],
            expectAccept: spec.pass(fieldValue, threshold),
          })
        );
      }
    }
  }
  return cases;
}

/** Type-mismatch: condition on a uint op but the submitted field is the wrong type. */
export function uintTypeMismatchCases(): ParityCase[] {
  const cases: ParityCase[] = [];
  // Field declared+submitted as ADDRESS while the condition is a UINT op.
  // Legacy: _evalUintCondition reverts TypeMismatch. the new engine must also reject.
  cases.push(
    singleConditionCase({
      name: "UINT EQ_CONST on ADDRESS field (type mismatch)",
      family: "UINT",
      field: { fieldId: FID_AMOUNT, fType: FieldType.ADDRESS, required: true, persist: false },
      condition: { op: Op.UINT_EQ_CONST, fieldId: FID_AMOUNT, bytesArg: encUint(1n) },
      submittedField: {
        id: FID_AMOUNT,
        fType: FieldType.ADDRESS,
        data: coder.encode(["address"], ["0x000000000000000000000000000000000000dEaD"]),
      },
      expectAccept: false, // legacy reverts; harness treats revert as reject
    })
  );
  return cases;
}

/** Missing-required field: legacy reverts in _validateFields ("Required field missing"). */
export function uintMissingRequiredCases(): ParityCase[] {
  return [
    singleConditionCase({
      name: "UINT GT_CONST with required field omitted",
      family: "UINT",
      field: amountField(true),
      condition: { op: Op.UINT_GT_CONST, fieldId: FID_AMOUNT, bytesArg: encUint(5n) },
      submittedField: null,
      expectAccept: false,
    }),
  ];
}

/**
 * Missing-optional field: parity case.
 * Field is declared optional and omitted. The legacy engine silently skips the
 * condition; the new engine desugars the condition to IF_PRESENT (because the field
 * is optional) and likewise skips it. Both ACCEPT — full parity, no divergence.
 */
export function uintMissingOptionalCases(): ParityCase[] {
  return [
    singleConditionCase({
      name: "UINT GT_CONST with optional field omitted (both skip via IF_PRESENT)",
      family: "UINT",
      field: amountField(false), // optional
      condition: { op: Op.UINT_GT_CONST, fieldId: FID_AMOUNT, bytesArg: encUint(5n) },
      submittedField: null,
      expectAccept: true, // both engines skip the condition on the absent optional field
    }),
  ];
}

/**
 * VAR-set vs VAR-unset for _VAR ops.
 * VAR-unset: legacy _getUintFromStored reverts VarNotSet. the new engine must also reject.
 */
export function uintVarUnsetCases(): ParityCase[] {
  return [
    singleConditionCase({
      name: "UINT GTE_VAR with referenced var unset (VarNotSet)",
      family: "UINT",
      field: amountField(),
      condition: { op: Op.UINT_GTE_VAR, fieldId: FID_AMOUNT, bytesArg: encBytes32(VID_THRESHOLD) },
      submittedField: { id: FID_AMOUNT, fType: FieldType.UINT256, data: encUint(10n) },
      initVars: [], // threshold var intentionally not set
      expectAccept: false,
    }),
  ];
}

/**
 * Self-referential persisted-field VAR condition (NAMED EXCEPTION).
 *
 * A persisted (persist=true) field carries a `*_EQ_VAR`-style condition comparing the
 * field against the SAME var id it auto-persists into. Legacy persists the field
 * BEFORE evaluating conditions, so the comparison is degenerate (field vs itself); the
 * new engine REJECTS such a condition at `initialize`. Broadened from UINT to all
 * `*_EQ_VAR` families (UINT's five VAR ops, STRING_EQ_VAR, ADDRESS_EQ_VAR).
 */
interface SelfRefSpec {
  name: string;
  family: string;
  op: number;
  fType: FieldTypeVal;
  data: string; // submitted field value (also the persisted var value)
  // Legacy's outcome for the degenerate self-comparison (field vs itself):
  // EQ/GTE/LTE pass; GT/LT fail. (Only relevant for the init-divergence assertion's
  // documentation; legacy must init successfully regardless.)
  legacyAccepts: boolean;
}

function selfRefCase(spec: SelfRefSpec): ParityCase {
  const inputId = id("INPUT");
  const fid = id("selfField");
  return {
    name: spec.name,
    family: spec.family,
    initialState: STATE_START,
    inputDefs: [
      {
        id: inputId,
        fields: [{ fieldId: fid, fType: spec.fType, required: true, persist: true }],
        // Self-reference: condition's referenced var id == the field id it persists into.
        conditions: [{ op: spec.op, fieldId: fid, bytesArg: encBytes32(fid) }],
        verifierKeys: [],
      },
    ],
    transitions: [{ fromState: STATE_START, toState: STATE_DONE, inputId }],
    initVars: [],
    submission: { inputId, fields: [{ id: fid, fType: spec.fType, data: spec.data }] },
    expectAccept: spec.legacyAccepts,
    expectedToState: STATE_DONE,
    namedException: "selfReferentialVar",
    expectInitRevert: true,
  };
}

export function selfReferentialVarCases(): ParityCase[] {
  const u = (op: number, name: string, accepts: boolean): SelfRefSpec => ({
    name: `UINT ${name}_VAR self-referential on persisted field (reject at init)`,
    family: "UINT",
    op,
    fType: FieldType.UINT256,
    data: encUint(42n),
    legacyAccepts: accepts,
  });
  return [
    // All five UINT *_VAR ops. EQ/GTE/LTE accept (42 vs 42); GT/LT fail on legacy.
    selfRefCase(u(Op.UINT_EQ_VAR, "EQ", true)),
    selfRefCase(u(Op.UINT_GT_VAR, "GT", false)),
    selfRefCase(u(Op.UINT_GTE_VAR, "GTE", true)),
    selfRefCase(u(Op.UINT_LT_VAR, "LT", false)),
    selfRefCase(u(Op.UINT_LTE_VAR, "LTE", true)),
    // STRING_EQ_VAR and ADDRESS_EQ_VAR (both degenerate-equal -> legacy accepts).
    selfRefCase({
      name: "STRING EQ_VAR self-referential on persisted field (reject at init)",
      family: "STRING",
      op: Op.STRING_EQ_VAR,
      fType: FieldType.STRING,
      data: encString("hello"),
      legacyAccepts: true,
    }),
    selfRefCase({
      name: "ADDRESS EQ_VAR self-referential on persisted field (reject at init)",
      family: "ADDRESS",
      op: Op.ADDRESS_EQ_VAR,
      fType: FieldType.ADDRESS,
      data: encAddr(ADDR_A),
      legacyAccepts: true,
    }),
  ];
}

// ---------------------------------------------------------------------------
// STRING family
// ---------------------------------------------------------------------------

const FID_NAME = id("name");
const VID_NAME_REF = id("nameRef");
const encString = (s: string): string => coder.encode(["string"], [s]);
const encStringConst = encString; // CONST bytesArg for STRING_EQ_CONST is abi.encode(string)

const stringField = (required = true, persist = false): InputFieldDef => ({
  fieldId: FID_NAME,
  fType: FieldType.STRING,
  required,
  persist,
});

/** byte-length of a JS string under UTF-8 (matches Solidity bytes(s).length). */
const byteLen = (s: string): number => Buffer.from(s, "utf8").length;

/** A spread of strings with notable byte lengths: empty, 1, N-1, N, N+1, long, multibyte. */
function stringLengthGrid(): string[] {
  return [
    "", // 0
    "a", // 1
    "abcd", // 4
    "abcde", // 5
    "abcdef", // 6
    "the quick brown fox jumps over", // 30
    "x".repeat(64), // 64 (matches the legacy >= 64 *encoding* length nuance is on the abi blob, not the string)
    "héllo", // multibyte: 6 bytes, 5 codepoints (proves byte-length, not codepoint)
  ];
}

export function stringLengthCases(): ParityCase[] {
  const cases: ParityCase[] = [];
  const limits = [0, 1, 5, 6, 64];

  for (const isMin of [true, false]) {
    const op = isMin ? Op.STRING_MIN_LENGTH : Op.STRING_MAX_LENGTH;
    const opName = isMin ? "MIN_LENGTH" : "MAX_LENGTH";
    for (const limit of limits) {
      for (const s of stringLengthGrid()) {
        const len = byteLen(s);
        const accept = isMin ? len >= limit : len <= limit;
        cases.push(
          singleConditionCase({
            name: `STRING ${opName} len(${len}) limit=${limit} s="${s.slice(0, 12)}"`,
            family: "STRING",
            field: stringField(),
            condition: { op, fieldId: FID_NAME, bytesArg: encUint(BigInt(limit)) },
            submittedField: { id: FID_NAME, fType: FieldType.STRING, data: encString(s) },
            expectAccept: accept,
          })
        );
      }
    }
  }
  return cases;
}

export function stringEqConstCases(): ParityCase[] {
  const cases: ParityCase[] = [];
  const pairs: Array<[string, string]> = [
    ["hello", "hello"], // equal
    ["hello", "world"], // unequal
    ["", ""], // both empty -> equal
    ["", "x"], // empty vs non-empty
    ["héllo", "héllo"], // multibyte equal
    ["héllo", "hello"], // multibyte unequal (different bytes)
  ];
  for (const [fieldVal, constVal] of pairs) {
    cases.push(
      singleConditionCase({
        name: `STRING EQ_CONST field="${fieldVal}" const="${constVal}"`,
        family: "STRING",
        field: stringField(),
        condition: { op: Op.STRING_EQ_CONST, fieldId: FID_NAME, bytesArg: encStringConst(constVal) },
        submittedField: { id: FID_NAME, fType: FieldType.STRING, data: encString(fieldVal) },
        expectAccept: fieldVal === constVal,
      })
    );
  }
  return cases;
}

export function stringEqVarCases(): ParityCase[] {
  const cases: ParityCase[] = [];
  const pairs: Array<[string, string]> = [
    ["hello", "hello"],
    ["hello", "world"],
    ["", ""],
  ];
  for (const [fieldVal, varVal] of pairs) {
    cases.push(
      singleConditionCase({
        name: `STRING EQ_VAR field="${fieldVal}" var="${varVal}"`,
        family: "STRING",
        field: stringField(),
        condition: { op: Op.STRING_EQ_VAR, fieldId: FID_NAME, bytesArg: encBytes32(VID_NAME_REF) },
        submittedField: { id: FID_NAME, fType: FieldType.STRING, data: encString(fieldVal) },
        initVars: [{ id: VID_NAME_REF, fType: FieldType.STRING, data: encString(varVal) }],
        expectAccept: fieldVal === varVal,
      })
    );
  }
  // VAR unset: legacy _getStringFromStored reverts VarNotSet.
  cases.push(
    singleConditionCase({
      name: "STRING EQ_VAR with referenced var unset (VarNotSet)",
      family: "STRING",
      field: stringField(),
      condition: { op: Op.STRING_EQ_VAR, fieldId: FID_NAME, bytesArg: encBytes32(VID_NAME_REF) },
      submittedField: { id: FID_NAME, fType: FieldType.STRING, data: encString("hello") },
      initVars: [],
      expectAccept: false,
    })
  );
  return cases;
}

/** Type-mismatch: STRING op on a non-string field. */
export function stringTypeMismatchCases(): ParityCase[] {
  return [
    singleConditionCase({
      name: "STRING MIN_LENGTH on UINT field (type mismatch)",
      family: "STRING",
      field: { fieldId: FID_NAME, fType: FieldType.UINT256, required: true, persist: false },
      condition: { op: Op.STRING_MIN_LENGTH, fieldId: FID_NAME, bytesArg: encUint(1n) },
      submittedField: { id: FID_NAME, fType: FieldType.UINT256, data: encUint(5n) },
      expectAccept: false,
    }),
  ];
}

export function stringMissingRequiredCases(): ParityCase[] {
  return [
    singleConditionCase({
      name: "STRING EQ_CONST with required field omitted",
      family: "STRING",
      field: stringField(true),
      condition: { op: Op.STRING_EQ_CONST, fieldId: FID_NAME, bytesArg: encStringConst("x") },
      submittedField: null,
      expectAccept: false,
    }),
  ];
}

// ---------------------------------------------------------------------------
// ADDRESS family
// ---------------------------------------------------------------------------

const FID_WALLET = id("wallet");
const VID_WALLET_REF = id("walletRef");
const ADDR_A = ethers.getAddress("0x00000000000000000000000000000000000000aa");
const ADDR_B = ethers.getAddress("0x00000000000000000000000000000000000000bb");
const ADDR_ZERO = "0x0000000000000000000000000000000000000000";
const encAddr = (a: string): string => coder.encode(["address"], [a]);

const walletField = (required = true, persist = false): InputFieldDef => ({
  fieldId: FID_WALLET,
  fType: FieldType.ADDRESS,
  required,
  persist,
});

export function addressEqConstCases(): ParityCase[] {
  const cases: ParityCase[] = [];
  const pairs: Array<[string, string]> = [
    [ADDR_A, ADDR_A], // match
    [ADDR_A, ADDR_B], // mismatch
    [ADDR_ZERO, ADDR_ZERO], // zero match
    [ADDR_A, ADDR_ZERO], // mismatch vs zero
  ];
  for (const [fieldVal, constVal] of pairs) {
    cases.push(
      singleConditionCase({
        name: `ADDRESS EQ_CONST field=${fieldVal} const=${constVal}`,
        family: "ADDRESS",
        field: walletField(),
        condition: { op: Op.ADDRESS_EQ_CONST, fieldId: FID_WALLET, bytesArg: encAddr(constVal) },
        submittedField: { id: FID_WALLET, fType: FieldType.ADDRESS, data: encAddr(fieldVal) },
        expectAccept: fieldVal.toLowerCase() === constVal.toLowerCase(),
      })
    );
  }
  return cases;
}

export function addressEqVarCases(): ParityCase[] {
  const cases: ParityCase[] = [];
  const pairs: Array<[string, string]> = [
    [ADDR_A, ADDR_A],
    [ADDR_A, ADDR_B],
    [ADDR_ZERO, ADDR_ZERO],
  ];
  for (const [fieldVal, varVal] of pairs) {
    cases.push(
      singleConditionCase({
        name: `ADDRESS EQ_VAR field=${fieldVal} var=${varVal}`,
        family: "ADDRESS",
        field: walletField(),
        condition: { op: Op.ADDRESS_EQ_VAR, fieldId: FID_WALLET, bytesArg: encBytes32(VID_WALLET_REF) },
        submittedField: { id: FID_WALLET, fType: FieldType.ADDRESS, data: encAddr(fieldVal) },
        initVars: [{ id: VID_WALLET_REF, fType: FieldType.ADDRESS, data: encAddr(varVal) }],
        expectAccept: fieldVal.toLowerCase() === varVal.toLowerCase(),
      })
    );
  }
  // VAR unset
  cases.push(
    singleConditionCase({
      name: "ADDRESS EQ_VAR with referenced var unset (VarNotSet)",
      family: "ADDRESS",
      field: walletField(),
      condition: { op: Op.ADDRESS_EQ_VAR, fieldId: FID_WALLET, bytesArg: encBytes32(VID_WALLET_REF) },
      submittedField: { id: FID_WALLET, fType: FieldType.ADDRESS, data: encAddr(ADDR_A) },
      initVars: [],
      expectAccept: false,
    })
  );
  return cases;
}

export function addressTypeMismatchCases(): ParityCase[] {
  return [
    singleConditionCase({
      name: "ADDRESS EQ_CONST on UINT field (type mismatch)",
      family: "ADDRESS",
      field: { fieldId: FID_WALLET, fType: FieldType.UINT256, required: true, persist: false },
      condition: { op: Op.ADDRESS_EQ_CONST, fieldId: FID_WALLET, bytesArg: encAddr(ADDR_A) },
      submittedField: { id: FID_WALLET, fType: FieldType.UINT256, data: encUint(1n) },
      expectAccept: false,
    }),
  ];
}

// ---------------------------------------------------------------------------
// SENDER family
// ---------------------------------------------------------------------------
//
// Signer-role convention (indices into ethers.getSigners()):
//   0 = owner/grantor (deploys the agreement), 1 = the "expected" signer,
//   2 = a "wrong" signer/relayer.
// SENDER conditions resolve AUTH_SIGNER = permit signer under permit, else msg.sender.

const VID_SENDER = id("expectedSender"); // address var the signer must equal
const VID_PARTY_A = id("partyA");
const VID_PARTY_B = id("partyB");

// We need a trivial input field so the payload is structurally valid (a marker uint).
const FID_MARKER = id("marker");
const markerField: InputFieldDef = {
  fieldId: FID_MARKER,
  fType: FieldType.UINT256,
  required: true,
  persist: false,
};
const markerSubmitted: DataField = { id: FID_MARKER, fType: FieldType.UINT256, data: encUint(1n) };

/** SENDER_EQ_VAR_ADDRESS: AUTH_SIGNER must equal a stored address var (var id = condition.fieldId). */
export function senderEqVarCases(initSignerAddr: string, wrongAddr: string): ParityCase[] {
  const cases: ParityCase[] = [];

  // direct match (submitter index 1 == stored)
  cases.push(
    senderCase({
      name: "SENDER EQ_VAR direct: signer matches stored",
      storedSender: initSignerAddr,
      mode: "direct",
      submitterIndex: 1,
      expectAccept: true,
    })
  );
  // direct mismatch (submitter index 2 != stored)
  cases.push(
    senderCase({
      name: "SENDER EQ_VAR direct: signer mismatch",
      storedSender: initSignerAddr,
      mode: "direct",
      submitterIndex: 2,
      expectAccept: false,
    })
  );
  // permit match: signer index 1 (== stored) signs, relayer index 2 sends
  cases.push(
    senderCase({
      name: "SENDER EQ_VAR permit: permit signer matches stored (relayed by other)",
      storedSender: initSignerAddr,
      mode: "permit",
      signerIndex: 1,
      submitterIndex: 2,
      expectAccept: true,
    })
  );
  // permit mismatch: signer index 2 (!= stored) signs, relayer index 1 sends.
  // Proves AUTH_SIGNER follows the *signer*, not the relayer (relayer 1 == stored, but rejected).
  cases.push(
    senderCase({
      name: "SENDER EQ_VAR permit: permit signer mismatch even though relayer matches",
      storedSender: initSignerAddr,
      mode: "permit",
      signerIndex: 2,
      submitterIndex: 1,
      expectAccept: false,
    })
  );
  // VAR unset
  cases.push(
    senderCase({
      name: "SENDER EQ_VAR with sender var unset (VarNotSet)",
      storedSender: null,
      mode: "direct",
      submitterIndex: 1,
      expectAccept: false,
    })
  );
  return cases;
}

function senderCase(args: {
  name: string;
  storedSender: string | null;
  mode: "direct" | "permit";
  submitterIndex: number;
  signerIndex?: number;
  expectAccept: boolean;
}): ParityCase {
  const inputId = id("INPUT");
  const initVars: DataField[] =
    args.storedSender === null
      ? []
      : [{ id: VID_SENDER, fType: FieldType.ADDRESS, data: encAddr(args.storedSender) }];
  return {
    name: args.name,
    family: "SENDER",
    initialState: STATE_START,
    inputDefs: [
      {
        id: inputId,
        fields: [markerField],
        // legacy: SENDER_EQ_VAR_ADDRESS reads vars[condition.fieldId]; fieldId = VID_SENDER.
        conditions: [{ op: Op.SENDER_EQ_VAR_ADDRESS, fieldId: VID_SENDER, bytesArg: "0x" }],
        verifierKeys: [],
      },
    ],
    transitions: [{ fromState: STATE_START, toState: STATE_DONE, inputId }],
    initVars,
    submission: {
      inputId,
      fields: [markerSubmitted],
      mode: args.mode,
      submitterIndex: args.submitterIndex,
      signerIndex: args.signerIndex,
    },
    expectAccept: args.expectAccept,
    expectedToState: STATE_DONE,
    namedException: "none",
  };
}

/**
 * SENDER_IN_ALLOWED_ADDRESSES: heterogeneous allow-set.
 * bytesArg = abi.encode(bytes32[] allowedVarFieldIds, address[] allowedAddresses).
 * Legacy checks VARs first (reverting VarNotSet on an unset var), then literals.
 */
export function senderInAllowedCases(signerAddr: string, otherAddr: string): ParityCase[] {
  const inputId = id("INPUT");

  const mk = (args: {
    name: string;
    varIds: string[];
    addrs: string[];
    initVars: DataField[];
    expectAccept: boolean;
    submitterIndex?: number;
    mode?: "direct" | "permit";
    signerIndex?: number;
  }): ParityCase => {
    const bytesArg = coder.encode(["bytes32[]", "address[]"], [args.varIds, args.addrs]);
    return {
      name: args.name,
      family: "SENDER",
      initialState: STATE_START,
      inputDefs: [
        {
          id: inputId,
          fields: [markerField],
          conditions: [{ op: Op.SENDER_IN_ALLOWED_ADDRESSES, fieldId: id("ignored"), bytesArg }],
          verifierKeys: [],
        },
      ],
      transitions: [{ fromState: STATE_START, toState: STATE_DONE, inputId }],
      initVars: args.initVars,
      submission: {
        inputId,
        fields: [markerSubmitted],
        mode: args.mode ?? "direct",
        submitterIndex: args.submitterIndex ?? 1,
        signerIndex: args.signerIndex,
      },
      expectAccept: args.expectAccept,
      expectedToState: STATE_DONE,
      namedException: "none",
    };
  };

  const partyAVar: DataField = { id: VID_PARTY_A, fType: FieldType.ADDRESS, data: encAddr(signerAddr) };
  const partyBVar: DataField = { id: VID_PARTY_B, fType: FieldType.ADDRESS, data: encAddr(otherAddr) };

  return [
    // in-set via a CONST entry (signer is a literal in the allow-list)
    mk({
      name: "SENDER_IN_ALLOWED: in-set via CONST entry",
      varIds: [VID_PARTY_B],
      addrs: [signerAddr],
      initVars: [partyBVar],
      expectAccept: true,
    }),
    // in-set via a VAR entry (signer equals a stored address var)
    mk({
      name: "SENDER_IN_ALLOWED: in-set via VAR entry",
      varIds: [VID_PARTY_A],
      addrs: [otherAddr],
      initVars: [partyAVar],
      expectAccept: true,
    }),
    // not in-set (neither var nor const matches)
    mk({
      name: "SENDER_IN_ALLOWED: not in-set",
      varIds: [VID_PARTY_B],
      addrs: [otherAddr],
      initVars: [partyBVar],
      expectAccept: false,
    }),
    // mixed set, in-set via VAR while a CONST also present
    mk({
      name: "SENDER_IN_ALLOWED: mixed VAR+CONST, match on VAR",
      varIds: [VID_PARTY_A],
      addrs: [otherAddr, signerAddr],
      initVars: [partyAVar],
      expectAccept: true,
    }),
    // VAR entry unset -> legacy reverts VarNotSet (even though signer matches a later CONST)
    mk({
      name: "SENDER_IN_ALLOWED: unset VAR entry reverts (before reaching matching CONST)",
      varIds: [VID_PARTY_A], // not in initVars
      addrs: [signerAddr],
      initVars: [],
      expectAccept: false,
    }),
    // permit: signer (index 1) in-set via CONST, relayed by index 2
    mk({
      name: "SENDER_IN_ALLOWED permit: permit signer in-set via CONST (relayed)",
      varIds: [],
      addrs: [signerAddr],
      initVars: [],
      expectAccept: true,
      mode: "permit",
      signerIndex: 1,
      submitterIndex: 2,
    }),
  ];
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

/** Parity cases where the prior engine and the new engine must agree exactly (namedException === "none"). */
export function uintParityCases(): ParityCase[] {
  return [
    ...uintConstCases(),
    ...uintVarCases(),
    ...uintTypeMismatchCases(),
    ...uintMissingRequiredCases(),
    ...uintVarUnsetCases(),
    ...uintMissingOptionalCases(),
  ];
}

export function stringParityCases(): ParityCase[] {
  return [
    ...stringLengthCases(),
    ...stringEqConstCases(),
    ...stringEqVarCases(),
    ...stringTypeMismatchCases(),
    ...stringMissingRequiredCases(),
    ...stringMissingOptionalCases(),
  ];
}

export function addressParityCases(): ParityCase[] {
  return [
    ...addressEqConstCases(),
    ...addressEqVarCases(),
    ...addressTypeMismatchCases(),
    ...addressMissingOptionalCases(),
  ];
}

/** SENDER cases depend on runtime signer addresses; the test injects them. */
export function senderParityCases(signerAddr: string, otherAddr: string): ParityCase[] {
  return [...senderEqVarCases(signerAddr, otherAddr), ...senderInAllowedCases(signerAddr, otherAddr)];
}

/**
 * Absent-optional-field parity generalized to STRING/ADDRESS.
 * Both engines skip the condition on the omitted optional field (the new engine via
 * IF_PRESENT desugar), so both ACCEPT — full parity across families.
 */
export function stringMissingOptionalCases(): ParityCase[] {
  return [
    singleConditionCase({
      name: "STRING MIN_LENGTH with optional field omitted (both skip via IF_PRESENT)",
      family: "STRING",
      field: stringField(false),
      condition: { op: Op.STRING_MIN_LENGTH, fieldId: FID_NAME, bytesArg: encUint(1n) },
      submittedField: null,
      expectAccept: true,
    }),
  ];
}

export function addressMissingOptionalCases(): ParityCase[] {
  return [
    singleConditionCase({
      name: "ADDRESS EQ_CONST with optional field omitted (both skip via IF_PRESENT)",
      family: "ADDRESS",
      field: walletField(false),
      condition: { op: Op.ADDRESS_EQ_CONST, fieldId: FID_WALLET, bytesArg: encAddr(ADDR_A) },
      submittedField: null,
      expectAccept: true,
    }),
  ];
}

/** Named-exception cases (asserted as deliberate divergences, not parity). */
export function namedExceptionCases(): ParityCase[] {
  return [...selfReferentialVarCases()];
}
