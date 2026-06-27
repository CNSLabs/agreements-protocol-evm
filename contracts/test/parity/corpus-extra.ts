/**
 * Extended differential parity corpus — coverage hardening.
 *
 * Builds full ParityCase objects exercising:
 *  - multi-condition inputs (all pass / first fails / later fails / optional-absent
 *    skipped while another passes-or-fails),
 *  - cross-input two-step agreements (input A persists a var; input B compares it),
 *  - persist-before-validate (a newly-persisted field shadows a pre-existing init var),
 *  - IF_PRESENT with VAR RHS at the agreement level (optional-omitted *_VAR with the
 *    RHS var unset / wrong-type must skip; optional-present pass and fail),
 *  - stored-VAR type mismatch across families,
 *  - SENDER_IN_ALLOWED hard cases (permit-negative, early-VAR-before-unset-VAR,
 *    wrong-type VAR, empty allow-set).
 *
 * Every case carries ground-truth `expectAccept` reflecting the LEGACY engine's
 * actual behavior; the harness anchors parity to it.
 */

import { ethers } from "ethers";
import { FieldType, Op, ParityCase, InputDef, DataField, LegacyCondition, InputFieldDef } from "./corpus";

const coder = ethers.AbiCoder.defaultAbiCoder();
const id = (s: string) => ethers.id(s);
const encUint = (v: bigint) => coder.encode(["uint256"], [v]);
const encString = (s: string) => coder.encode(["string"], [s]);
const encAddr = (a: string) => coder.encode(["address"], [a]);
const encBytes32 = (v: string) => coder.encode(["bytes32"], [v]);

const STATE_START = id("START");
const STATE_MID = id("MID");
const STATE_DONE = id("DONE");

const FID_AMOUNT = id("amount");
const FID_THRESHOLD = id("threshold"); // a submittable field that also persists
const FID_NAME = id("name");
const FID_WALLET = id("wallet");
const VID_THRESHOLD = id("vThreshold");
const VID_NAME_REF = id("vNameRef");
const VID_WALLET_REF = id("vWalletRef");

const ADDR_A = ethers.getAddress("0x00000000000000000000000000000000000000aa");
const ADDR_B = ethers.getAddress("0x00000000000000000000000000000000000000bb");

const uintField = (fieldId: string, required = true, persist = false): InputFieldDef => ({
  fieldId,
  fType: FieldType.UINT256,
  required,
  persist,
});

// ---------------------------------------------------------------------------
// Major 1 — multi-condition (single input)
// ---------------------------------------------------------------------------

/**
 * One input with two UINT conditions on `amount`: amount GTE lo AND amount LTE hi.
 * Legacy evaluates all conditions; first failure reverts. expectAccept = lo<=v<=hi.
 */
function rangeCase(name: string, lo: bigint, hi: bigint, v: bigint): ParityCase {
  const inputId = id("INPUT");
  const conditions: LegacyCondition[] = [
    { op: Op.UINT_GTE_CONST, fieldId: FID_AMOUNT, bytesArg: encUint(lo) },
    { op: Op.UINT_LTE_CONST, fieldId: FID_AMOUNT, bytesArg: encUint(hi) },
  ];
  return {
    name,
    family: "MULTI",
    initialState: STATE_START,
    inputDefs: [{ id: inputId, fields: [uintField(FID_AMOUNT)], conditions, verifierKeys: [] }],
    transitions: [{ fromState: STATE_START, toState: STATE_DONE, inputId }],
    initVars: [],
    submission: { inputId, fields: [{ id: FID_AMOUNT, fType: FieldType.UINT256, data: encUint(v) }] },
    expectAccept: v >= lo && v <= hi,
    expectedToState: STATE_DONE,
    namedException: "none",
  };
}

export function multiConditionCases(): ParityCase[] {
  return [
    rangeCase("MULTI both pass (10 in [5,20])", 5n, 20n, 10n),
    rangeCase("MULTI first fails (3 < 5)", 5n, 20n, 3n),
    rangeCase("MULTI later fails (25 > 20)", 5n, 20n, 25n),
    rangeCase("MULTI both boundaries (5 in [5,20])", 5n, 20n, 5n),
    rangeCase("MULTI both boundaries (20 in [5,20])", 5n, 20n, 20n),
  ];
}

/**
 * Multi-condition where one condition targets an OPTIONAL absent field (skipped via
 * IF_PRESENT) while a second condition on a present required field passes or fails.
 */
export function multiConditionOptionalSkipCases(): ParityCase[] {
  const mk = (name: string, amount: bigint, expectAccept: boolean): ParityCase => {
    const inputId = id("INPUT");
    const fields: InputFieldDef[] = [
      uintField(FID_AMOUNT, true, false), // required, present
      uintField(FID_THRESHOLD, false, false), // optional, omitted
    ];
    const conditions: LegacyCondition[] = [
      // optional field condition (will be skipped — field absent)
      { op: Op.UINT_GT_CONST, fieldId: FID_THRESHOLD, bytesArg: encUint(1000n) },
      // required field condition (evaluated)
      { op: Op.UINT_GTE_CONST, fieldId: FID_AMOUNT, bytesArg: encUint(10n) },
    ];
    return {
      name,
      family: "MULTI",
      initialState: STATE_START,
      inputDefs: [{ id: inputId, fields, conditions, verifierKeys: [] }],
      transitions: [{ fromState: STATE_START, toState: STATE_DONE, inputId }],
      initVars: [],
      submission: { inputId, fields: [{ id: FID_AMOUNT, fType: FieldType.UINT256, data: encUint(amount) }] },
      expectAccept,
      expectedToState: STATE_DONE,
      namedException: "none",
    };
  };
  return [
    mk("MULTI optional-absent skipped + required passes (amount=20>=10)", 20n, true),
    mk("MULTI optional-absent skipped + required fails (amount=5<10)", 5n, false),
  ];
}

// ---------------------------------------------------------------------------
// Major 1 — cross-input two-step: input A persists threshold; input B uses VAR(threshold)
// ---------------------------------------------------------------------------

export function crossInputCases(): ParityCase[] {
  const setThreshold = id("setThreshold");
  const checkAmount = id("checkAmount");

  const mk = (name: string, thresholdVal: bigint, amountVal: bigint, expectAccept: boolean): ParityCase => {
    const inputDefs: InputDef[] = [
      {
        id: setThreshold,
        // threshold submitted and PERSISTED into vars[FID_THRESHOLD]
        fields: [uintField(FID_THRESHOLD, true, /*persist*/ true)],
        conditions: [],
        verifierKeys: [],
      },
      {
        id: checkAmount,
        // amount compared against the persisted threshold var
        fields: [uintField(FID_AMOUNT, true, false)],
        conditions: [{ op: Op.UINT_GTE_VAR, fieldId: FID_AMOUNT, bytesArg: encBytes32(FID_THRESHOLD) }],
        verifierKeys: [],
      },
    ];
    return {
      name,
      family: "CROSS",
      initialState: STATE_START,
      inputDefs,
      transitions: [
        { fromState: STATE_START, toState: STATE_MID, inputId: setThreshold },
        { fromState: STATE_MID, toState: STATE_DONE, inputId: checkAmount },
      ],
      initVars: [],
      priorSubmissions: [
        {
          inputId: setThreshold,
          fields: [{ id: FID_THRESHOLD, fType: FieldType.UINT256, data: encUint(thresholdVal) }],
        },
      ],
      submission: {
        inputId: checkAmount,
        fields: [{ id: FID_AMOUNT, fType: FieldType.UINT256, data: encUint(amountVal) }],
      },
      expectAccept,
      expectedToState: STATE_DONE,
      namedException: "none",
    };
  };
  return [
    mk("CROSS: amount(50) >= persisted threshold(30) -> accept", 30n, 50n, true),
    mk("CROSS: amount(10) < persisted threshold(30) -> reject", 30n, 10n, false),
    mk("CROSS: amount == persisted threshold (boundary) -> accept", 42n, 42n, true),
  ];
}

// ---------------------------------------------------------------------------
// Major 2 — persist-before-validate: newly persisted field shadows init var
// ---------------------------------------------------------------------------

/**
 * One input with a persisted `threshold` field AND an `amount` condition comparing
 * VAR(threshold). A pre-existing init var threshold is set to a value that would give
 * the OPPOSITE accept/reject. Legacy persists the submitted field before evaluating
 * conditions, so the *submitted* threshold is the one used — proving persist-before-
 * validate ordering.
 */
export function persistBeforeValidateCases(): ParityCase[] {
  const inputId = id("INPUT");

  const mk = (
    name: string,
    initThreshold: bigint,
    submittedThreshold: bigint,
    amount: bigint,
    expectAccept: boolean
  ): ParityCase => {
    const fields: InputFieldDef[] = [
      uintField(FID_AMOUNT, true, false),
      uintField(FID_THRESHOLD, true, /*persist*/ true),
    ];
    const conditions: LegacyCondition[] = [
      { op: Op.UINT_GTE_VAR, fieldId: FID_AMOUNT, bytesArg: encBytes32(FID_THRESHOLD) },
    ];
    return {
      name,
      family: "PERSIST",
      initialState: STATE_START,
      inputDefs: [{ id: inputId, fields, conditions, verifierKeys: [] }],
      transitions: [{ fromState: STATE_START, toState: STATE_DONE, inputId }],
      initVars: [{ id: FID_THRESHOLD, fType: FieldType.UINT256, data: encUint(initThreshold) }],
      submission: {
        inputId,
        fields: [
          { id: FID_AMOUNT, fType: FieldType.UINT256, data: encUint(amount) },
          { id: FID_THRESHOLD, fType: FieldType.UINT256, data: encUint(submittedThreshold) },
        ],
      },
      expectAccept,
      expectedToState: STATE_DONE,
      namedException: "none",
    };
  };
  return [
    // init threshold=1000 (would reject amount=50); submitted threshold=30 (accepts 50).
    // If the newly persisted value is used, accept. Legacy persists-before-validate -> accept.
    mk("PERSIST: submitted threshold(30) shadows init(1000); amount(50)>=30 -> accept", 1000n, 30n, 50n, true),
    // init threshold=0 (would accept amount=50); submitted threshold=100 (rejects 50).
    mk("PERSIST: submitted threshold(100) shadows init(0); amount(50)<100 -> reject", 0n, 100n, 50n, false),
  ];
}

// ---------------------------------------------------------------------------
// Major 4 — IF_PRESENT with VAR RHS at the agreement level
// ---------------------------------------------------------------------------

/**
 * Optional-omitted `*_VAR` conditions: the condition is skipped (field absent), so the
 * RHS var being unset / wrong-type must NOT cause a revert. Legacy skips the absent
 * optional field's condition entirely -> accept. Plus optional-present pass and fail.
 */
export function ifPresentVarRhsCases(): ParityCase[] {
  const cases: ParityCase[] = [];

  // Helper: single optional field + single *_VAR condition referencing VID.
  const mk = (args: {
    name: string;
    field: InputFieldDef;
    op: number;
    refVarId: string;
    initVars: DataField[];
    submitted: DataField | null;
    expectAccept: boolean;
  }): ParityCase => {
    const inputId = id("INPUT");
    return {
      name: args.name,
      family: "IFPRESENT",
      initialState: STATE_START,
      inputDefs: [
        {
          id: inputId,
          fields: [args.field],
          conditions: [{ op: args.op, fieldId: args.field.fieldId, bytesArg: encBytes32(args.refVarId) }],
          verifierKeys: [],
        },
      ],
      transitions: [{ fromState: STATE_START, toState: STATE_DONE, inputId }],
      initVars: args.initVars,
      submission: { inputId, fields: args.submitted ? [args.submitted] : [] },
      expectAccept: args.expectAccept,
      expectedToState: STATE_DONE,
      namedException: "none",
    };
  };

  // UINT _VAR, optional omitted, RHS var UNSET -> skip -> accept.
  cases.push(
    mk({
      name: "IF_PRESENT UINT GTE_VAR optional omitted, RHS var unset -> skip/accept",
      field: uintField(FID_AMOUNT, false),
      op: Op.UINT_GTE_VAR,
      refVarId: VID_THRESHOLD,
      initVars: [],
      submitted: null,
      expectAccept: true,
    })
  );
  // UINT _VAR, optional omitted, RHS var WRONG TYPE (address) -> skip -> accept.
  cases.push(
    mk({
      name: "IF_PRESENT UINT GTE_VAR optional omitted, RHS var wrong type -> skip/accept",
      field: uintField(FID_AMOUNT, false),
      op: Op.UINT_GTE_VAR,
      refVarId: VID_THRESHOLD,
      initVars: [{ id: VID_THRESHOLD, fType: FieldType.ADDRESS, data: encAddr(ADDR_A) }],
      submitted: null,
      expectAccept: true,
    })
  );
  // UINT _VAR optional PRESENT, pass.
  cases.push(
    mk({
      name: "IF_PRESENT UINT GTE_VAR optional present, var set -> evaluates (pass)",
      field: uintField(FID_AMOUNT, false),
      op: Op.UINT_GTE_VAR,
      refVarId: VID_THRESHOLD,
      initVars: [{ id: VID_THRESHOLD, fType: FieldType.UINT256, data: encUint(10n) }],
      submitted: { id: FID_AMOUNT, fType: FieldType.UINT256, data: encUint(20n) },
      expectAccept: true,
    })
  );
  // UINT _VAR optional PRESENT, fail.
  cases.push(
    mk({
      name: "IF_PRESENT UINT GTE_VAR optional present, var set -> evaluates (fail)",
      field: uintField(FID_AMOUNT, false),
      op: Op.UINT_GTE_VAR,
      refVarId: VID_THRESHOLD,
      initVars: [{ id: VID_THRESHOLD, fType: FieldType.UINT256, data: encUint(100n) }],
      submitted: { id: FID_AMOUNT, fType: FieldType.UINT256, data: encUint(20n) },
      expectAccept: false,
    })
  );

  // STRING_EQ_VAR optional omitted, RHS var unset -> skip -> accept; present pass/fail.
  const strField = (req: boolean): InputFieldDef => ({ fieldId: FID_NAME, fType: FieldType.STRING, required: req, persist: false });
  cases.push(
    mk({
      name: "IF_PRESENT STRING EQ_VAR optional omitted, RHS var unset -> skip/accept",
      field: strField(false),
      op: Op.STRING_EQ_VAR,
      refVarId: VID_NAME_REF,
      initVars: [],
      submitted: null,
      expectAccept: true,
    })
  );
  cases.push(
    mk({
      name: "IF_PRESENT STRING EQ_VAR optional omitted, RHS var wrong type -> skip/accept",
      field: strField(false),
      op: Op.STRING_EQ_VAR,
      refVarId: VID_NAME_REF,
      initVars: [{ id: VID_NAME_REF, fType: FieldType.UINT256, data: encUint(1n) }],
      submitted: null,
      expectAccept: true,
    })
  );
  cases.push(
    mk({
      name: "IF_PRESENT STRING EQ_VAR optional present, var set -> evaluates (pass)",
      field: strField(false),
      op: Op.STRING_EQ_VAR,
      refVarId: VID_NAME_REF,
      initVars: [{ id: VID_NAME_REF, fType: FieldType.STRING, data: encString("hi") }],
      submitted: { id: FID_NAME, fType: FieldType.STRING, data: encString("hi") },
      expectAccept: true,
    })
  );
  cases.push(
    mk({
      name: "IF_PRESENT STRING EQ_VAR optional present, var set -> evaluates (fail)",
      field: strField(false),
      op: Op.STRING_EQ_VAR,
      refVarId: VID_NAME_REF,
      initVars: [{ id: VID_NAME_REF, fType: FieldType.STRING, data: encString("hi") }],
      submitted: { id: FID_NAME, fType: FieldType.STRING, data: encString("bye") },
      expectAccept: false,
    })
  );

  // ADDRESS_EQ_VAR optional omitted, RHS var unset -> skip -> accept; present pass/fail.
  const addrField = (req: boolean): InputFieldDef => ({ fieldId: FID_WALLET, fType: FieldType.ADDRESS, required: req, persist: false });
  cases.push(
    mk({
      name: "IF_PRESENT ADDRESS EQ_VAR optional omitted, RHS var unset -> skip/accept",
      field: addrField(false),
      op: Op.ADDRESS_EQ_VAR,
      refVarId: VID_WALLET_REF,
      initVars: [],
      submitted: null,
      expectAccept: true,
    })
  );
  cases.push(
    mk({
      name: "IF_PRESENT ADDRESS EQ_VAR optional omitted, RHS var wrong type -> skip/accept",
      field: addrField(false),
      op: Op.ADDRESS_EQ_VAR,
      refVarId: VID_WALLET_REF,
      initVars: [{ id: VID_WALLET_REF, fType: FieldType.UINT256, data: encUint(1n) }],
      submitted: null,
      expectAccept: true,
    })
  );
  cases.push(
    mk({
      name: "IF_PRESENT ADDRESS EQ_VAR optional present, var set -> evaluates (pass)",
      field: addrField(false),
      op: Op.ADDRESS_EQ_VAR,
      refVarId: VID_WALLET_REF,
      initVars: [{ id: VID_WALLET_REF, fType: FieldType.ADDRESS, data: encAddr(ADDR_A) }],
      submitted: { id: FID_WALLET, fType: FieldType.ADDRESS, data: encAddr(ADDR_A) },
      expectAccept: true,
    })
  );
  cases.push(
    mk({
      name: "IF_PRESENT ADDRESS EQ_VAR optional present, var set -> evaluates (fail)",
      field: addrField(false),
      op: Op.ADDRESS_EQ_VAR,
      refVarId: VID_WALLET_REF,
      initVars: [{ id: VID_WALLET_REF, fType: FieldType.ADDRESS, data: encAddr(ADDR_A) }],
      submitted: { id: FID_WALLET, fType: FieldType.ADDRESS, data: encAddr(ADDR_B) },
      expectAccept: false,
    })
  );

  return cases;
}

// ---------------------------------------------------------------------------
// Major 6 — stored-VAR type mismatch
// ---------------------------------------------------------------------------

/**
 * A `*_VAR` condition where the stored var is the WRONG type. Legacy's typed getters
 * (_getUintFromStored / _getAddressFromStored / _getStringFromStored) revert
 * TypeMismatch -> reject. The new engine's VAR resolve checks vType -> reject. Both
 * reject (parity); the field is PRESENT so IF_PRESENT does not skip.
 */
export function storedVarTypeMismatchCases(): ParityCase[] {
  const cases: ParityCase[] = [];
  const mk = (args: {
    name: string;
    family: string;
    field: InputFieldDef;
    op: number;
    refVarId: string;
    storedVarType: number;
    storedVarData: string;
    submitted: DataField;
  }): ParityCase => {
    const inputId = id("INPUT");
    return {
      name: args.name,
      family: args.family,
      initialState: STATE_START,
      inputDefs: [
        {
          id: inputId,
          fields: [args.field],
          conditions: [{ op: args.op, fieldId: args.field.fieldId, bytesArg: encBytes32(args.refVarId) }],
          verifierKeys: [],
        },
      ],
      transitions: [{ fromState: STATE_START, toState: STATE_DONE, inputId }],
      initVars: [{ id: args.refVarId, fType: args.storedVarType as any, data: args.storedVarData }],
      submission: { inputId, fields: [args.submitted] },
      expectAccept: false, // wrong-type stored var -> both engines revert
      expectedToState: STATE_DONE,
      namedException: "none",
    };
  };

  // UINT_GTE_VAR with stored STRING
  cases.push(
    mk({
      name: "TYPEVAR UINT GTE_VAR with stored STRING var -> reject",
      family: "TYPEVAR",
      field: uintField(FID_AMOUNT),
      op: Op.UINT_GTE_VAR,
      refVarId: VID_THRESHOLD,
      storedVarType: FieldType.STRING,
      storedVarData: encString("nope"),
      submitted: { id: FID_AMOUNT, fType: FieldType.UINT256, data: encUint(5n) },
    })
  );
  // UINT_EQ_VAR with stored ADDRESS
  cases.push(
    mk({
      name: "TYPEVAR UINT EQ_VAR with stored ADDRESS var -> reject",
      family: "TYPEVAR",
      field: uintField(FID_AMOUNT),
      op: Op.UINT_EQ_VAR,
      refVarId: VID_THRESHOLD,
      storedVarType: FieldType.ADDRESS,
      storedVarData: encAddr(ADDR_A),
      submitted: { id: FID_AMOUNT, fType: FieldType.UINT256, data: encUint(5n) },
    })
  );
  // STRING_EQ_VAR with stored ADDRESS
  cases.push(
    mk({
      name: "TYPEVAR STRING EQ_VAR with stored ADDRESS var -> reject",
      family: "TYPEVAR",
      field: { fieldId: FID_NAME, fType: FieldType.STRING, required: true, persist: false },
      op: Op.STRING_EQ_VAR,
      refVarId: VID_NAME_REF,
      storedVarType: FieldType.ADDRESS,
      storedVarData: encAddr(ADDR_A),
      submitted: { id: FID_NAME, fType: FieldType.STRING, data: encString("x") },
    })
  );
  // ADDRESS_EQ_VAR with stored UINT
  cases.push(
    mk({
      name: "TYPEVAR ADDRESS EQ_VAR with stored UINT var -> reject",
      family: "TYPEVAR",
      field: { fieldId: FID_WALLET, fType: FieldType.ADDRESS, required: true, persist: false },
      op: Op.ADDRESS_EQ_VAR,
      refVarId: VID_WALLET_REF,
      storedVarType: FieldType.UINT256,
      storedVarData: encUint(1n),
      submitted: { id: FID_WALLET, fType: FieldType.ADDRESS, data: encAddr(ADDR_A) },
    })
  );
  return cases;
}

/**
 * SENDER_EQ_VAR_ADDRESS with a non-address stored var, and SENDER_IN_ALLOWED with a
 * wrong-type VAR entry. Addresses come from runtime signers (injected).
 */
export function senderVarTypeMismatchCases(signerAddr: string): ParityCase[] {
  const FID_MARKER = id("marker");
  const marker: InputFieldDef = { fieldId: FID_MARKER, fType: FieldType.UINT256, required: true, persist: false };
  const markerSub: DataField = { id: FID_MARKER, fType: FieldType.UINT256, data: encUint(1n) };

  const senderVar = id("expectedSenderTV");
  const eqVarCase: ParityCase = {
    name: "TYPEVAR SENDER_EQ_VAR with non-address (UINT) stored var -> reject",
    family: "SENDER",
    initialState: STATE_START,
    inputDefs: [
      {
        id: id("INPUT"),
        fields: [marker],
        conditions: [{ op: Op.SENDER_EQ_VAR_ADDRESS, fieldId: senderVar, bytesArg: "0x" }],
        verifierKeys: [],
      },
    ],
    transitions: [{ fromState: STATE_START, toState: STATE_DONE, inputId: id("INPUT") }],
    initVars: [{ id: senderVar, fType: FieldType.UINT256, data: encUint(1n) }],
    submission: { inputId: id("INPUT"), fields: [markerSub], mode: "direct", submitterIndex: 1 },
    expectAccept: false,
    expectedToState: STATE_DONE,
    namedException: "none",
  };

  const partyVar = id("partyTV");
  const inAllowedWrongType: ParityCase = {
    name: "TYPEVAR SENDER_IN_ALLOWED with wrong-type VAR entry -> reject",
    family: "SENDER",
    initialState: STATE_START,
    inputDefs: [
      {
        id: id("INPUT"),
        fields: [marker],
        conditions: [
          {
            op: Op.SENDER_IN_ALLOWED_ADDRESSES,
            fieldId: id("ignored"),
            // VAR entry partyVar is wrong-type (UINT); legacy _getAddressFromStored reverts.
            bytesArg: coder.encode(["bytes32[]", "address[]"], [[partyVar], [signerAddr]]),
          },
        ],
        verifierKeys: [],
      },
    ],
    transitions: [{ fromState: STATE_START, toState: STATE_DONE, inputId: id("INPUT") }],
    initVars: [{ id: partyVar, fType: FieldType.UINT256, data: encUint(7n) }],
    submission: { inputId: id("INPUT"), fields: [markerSub], mode: "direct", submitterIndex: 1 },
    // Legacy iterates VAR entries first and reverts TypeMismatch on the wrong-type var,
    // before reaching the matching CONST -> reject.
    expectAccept: false,
    expectedToState: STATE_DONE,
    namedException: "none",
  };

  return [eqVarCase, inAllowedWrongType];
}

// ---------------------------------------------------------------------------
// Major 7 — SENDER_IN_ALLOWED hard cases (signer addresses injected)
// ---------------------------------------------------------------------------

/**
 * @param signerAddr  address of signer index 1 (the "expected" signer)
 * @param otherAddr   address of signer index 2 (the relayer / "other")
 */
export function senderInAllowedHardCases(signerAddr: string, otherAddr: string): ParityCase[] {
  const FID_MARKER = id("marker");
  const marker: InputFieldDef = { fieldId: FID_MARKER, fType: FieldType.UINT256, required: true, persist: false };
  const markerSub: DataField = { id: FID_MARKER, fType: FieldType.UINT256, data: encUint(1n) };
  const VA = id("inAllowedA");
  const VB = id("inAllowedB");

  const mk = (args: {
    name: string;
    varIds: string[];
    addrs: string[];
    initVars: DataField[];
    expectAccept: boolean;
    mode?: "direct" | "permit";
    submitterIndex?: number;
    signerIndex?: number;
  }): ParityCase => {
    const inputId = id("INPUT");
    return {
      name: args.name,
      family: "SENDER",
      initialState: STATE_START,
      inputDefs: [
        {
          id: inputId,
          fields: [marker],
          conditions: [
            {
              op: Op.SENDER_IN_ALLOWED_ADDRESSES,
              fieldId: id("ignored"),
              bytesArg: coder.encode(["bytes32[]", "address[]"], [args.varIds, args.addrs]),
            },
          ],
          verifierKeys: [],
        },
      ],
      transitions: [{ fromState: STATE_START, toState: STATE_DONE, inputId }],
      initVars: args.initVars,
      submission: {
        inputId,
        fields: [markerSub],
        mode: args.mode ?? "direct",
        submitterIndex: args.submitterIndex ?? 1,
        signerIndex: args.signerIndex,
      },
      expectAccept: args.expectAccept,
      expectedToState: STATE_DONE,
      namedException: "none",
    };
  };

  return [
    // Permit-negative: relayer (index 1) is in the allow-set, but the permit SIGNER
    // (index 2) is not -> reject (AUTH_SIGNER is the signer, not the relayer).
    mk({
      name: "SENDER_IN_ALLOWED permit-negative: relayer allowed but permit signer not -> reject",
      varIds: [],
      addrs: [signerAddr], // signer index 1 is allowed
      initVars: [],
      expectAccept: false,
      mode: "permit",
      signerIndex: 2, // signer index 2 authorizes (NOT in set)
      submitterIndex: 1, // relayer index 1 IS in set, but irrelevant
    }),
    // Matching early VAR before a later UNSET VAR: legacy matches VA and returns before
    // reaching the unset VB -> accept (no VarNotSet revert).
    mk({
      name: "SENDER_IN_ALLOWED: match early VAR before a later unset VAR -> accept",
      varIds: [VA, VB], // VA set to signer; VB intentionally unset
      addrs: [],
      initVars: [{ id: VA, fType: FieldType.ADDRESS, data: encAddr(signerAddr) }],
      expectAccept: true,
      mode: "direct",
      submitterIndex: 1,
    }),
    // Empty allow-set (no vars, no addrs) -> nobody allowed -> reject.
    mk({
      name: "SENDER_IN_ALLOWED: empty allow-set -> reject",
      varIds: [],
      addrs: [],
      initVars: [],
      expectAccept: false,
      mode: "direct",
      submitterIndex: 1,
    }),
  ];
}
