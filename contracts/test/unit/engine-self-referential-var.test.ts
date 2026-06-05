/**
 * Self-referential persisted-VAR rejection symmetry (§6 named parity deviation).
 *
 * `_storeCanonicalConditions` rejects a degenerate self-referential persisted-field
 * VAR condition at init: a condition that compares a persisted input FIELD against
 * the SAME var that field auto-persists into. Persist-before-validate writes the
 * field into vars[id] BEFORE the condition runs, so the two operands resolve to the
 * same value and the comparison is vacuous.
 *
 * The rejection must be SYMMETRIC — degenerate regardless of which side the persisted
 * VAR sits on:
 *   (a) VAR-left  self-reference: VAR(id) <op> FIELD(id)   — the bug this fix closes;
 *       formerly NOT rejected (the guard returned early unless left.source == FIELD),
 *       letting an author ship a passing-but-meaningless guard.
 *   (b) VAR-left  self-reference: VAR(id) <op> VAR(id)     — the same persisted var on
 *       both sides, trivially satisfied post-persist.
 *   (c) FIELD-left self-reference: FIELD(id) <op> VAR(id)  — the original case (regression).
 *
 * And it must NOT over-reject a legitimate condition that references a persisted var
 * against a DIFFERENT field/value, or references a field that is not persisted.
 *
 * No mocks: a real AgreementEngine clone is created via the real AgreementFactory, and
 * the assertion is on whether `createAgreement` reverts at init.
 */

import { expect } from "chai";
import { ethers } from "hardhat";
import {
  FieldType,
  CmpOp,
  fieldRef,
  varRef,
  constRef,
  cond,
  coder,
  type Condition,
} from "../helpers/value-lib";

const S0 = ethers.id("S0");
const S1 = ethers.id("S1");

// abi.encode shape of AgreementTypes.Condition[] (the engine's encodedConditions bytes).
const CONDITION_ARRAY_ABI = [
  "tuple(tuple(uint8 source,uint8 vType,bytes data) left,uint8 op,bool skipIfAbsent,tuple(uint8 source,uint8 vType,bytes data)[] right)[]",
];

function encodeConditions(conds: Condition[]): string {
  return coder.encode(CONDITION_ARRAY_ABI, [
    conds.map((c) => [
      [c.left.source, c.left.vType, c.left.data],
      c.op,
      c.skipIfAbsent,
      c.right.map((r) => [r.source, r.vType, r.data]),
    ]),
  ]);
}

async function deployFactory() {
  const actionLib = await ethers.deployContract("ActionLib");
  await actionLib.waitForDeployment();
  const Engine = await ethers.getContractFactory("AgreementEngine", {
    libraries: { ActionLib: await actionLib.getAddress() },
  });
  const impl = await Engine.deploy();
  await impl.waitForDeployment();
  const factory = await ethers.deployContract("AgreementFactory", [await impl.getAddress()]);
  await factory.waitForDeployment();
  // `impl` is used solely as the error-source contract for revertedWithCustomError:
  // SelfReferentialVar is an AgreementTypes (library) error and is present in the engine
  // ABI but NOT the factory ABI, so the matcher must resolve the selector via the engine.
  return { factory, impl };
}

/**
 * Create an agreement with a single input that declares `amount` (UINT256), optionally
 * persisted, plus the given canonical conditions for that input. Returns the factory tx
 * promise (the caller asserts revert / success).
 */
function createWithConditions(
  factory: any,
  owner: any,
  opts: { inputId: string; fieldId: string; persist: boolean; conds: Condition[]; extraFields?: any[] }
) {
  const docUri = "ipfs://self-ref";
  const docHash = ethers.id("self-ref");

  const fields = [
    [opts.fieldId, FieldType.UINT256, /*required*/ true, /*persist*/ opts.persist],
    ...(opts.extraFields ?? []),
  ];
  const inputDefInits = [[opts.inputId, fields, /*verifierKeys*/ []]];
  const transitions = [[S0, S1, opts.inputId]];
  const canonicalConds = [[opts.inputId, encodeConditions(opts.conds)]];

  return factory
    .connect(owner)
    .createAgreement(docUri, docHash, S0, inputDefInits, transitions, [], [], canonicalConds, []);
}

describe("AgreementEngine — self-referential persisted-VAR rejection symmetry", () => {
  const inputId = ethers.id("setAmount");
  const amount = ethers.id("amount");
  const other = ethers.id("ceiling");

  it("(a) rejects a VAR-left self-reference: VAR(amount) EQ FIELD(amount), amount persisted", async () => {
    const { factory, impl } = await deployFactory();
    const [owner] = await ethers.getSigners();

    // VAR(amount) == FIELD(amount): after persist-before-validate, vars[amount] holds the
    // submitted field, so both sides are the same value — a vacuous always-true guard.
    const c = cond(
      varRef(FieldType.UINT256, amount),
      CmpOp.EQ,
      fieldRef(FieldType.UINT256, amount)
    );

    await expect(
      createWithConditions(factory, owner, { inputId, fieldId: amount, persist: true, conds: [c] })
    ).to.be.revertedWithCustomError(impl, "SelfReferentialVar");
  });

  it("(a') rejects a VAR-left self-reference inside an IN set: VAR(amount) IN [FIELD(amount)]", async () => {
    const { factory, impl } = await deployFactory();
    const [owner] = await ethers.getSigners();

    // The self-referential operand may sit anywhere among N right operands; here it is the
    // sole IN-set member, still degenerate post-persist.
    const c = cond(
      varRef(FieldType.UINT256, amount),
      CmpOp.IN,
      [fieldRef(FieldType.UINT256, amount)]
    );

    await expect(
      createWithConditions(factory, owner, { inputId, fieldId: amount, persist: true, conds: [c] })
    ).to.be.revertedWithCustomError(impl, "SelfReferentialVar");
  });

  it("(b) rejects the same persisted VAR on both sides: VAR(amount) EQ VAR(amount)", async () => {
    const { factory, impl } = await deployFactory();
    const [owner] = await ethers.getSigners();

    const c = cond(
      varRef(FieldType.UINT256, amount),
      CmpOp.EQ,
      varRef(FieldType.UINT256, amount)
    );

    await expect(
      createWithConditions(factory, owner, { inputId, fieldId: amount, persist: true, conds: [c] })
    ).to.be.revertedWithCustomError(impl, "SelfReferentialVar");
  });

  it("(c) still rejects the FIELD-left self-reference: FIELD(amount) EQ VAR(amount) (regression)", async () => {
    const { factory, impl } = await deployFactory();
    const [owner] = await ethers.getSigners();

    const c = cond(
      fieldRef(FieldType.UINT256, amount),
      CmpOp.EQ,
      varRef(FieldType.UINT256, amount)
    );

    await expect(
      createWithConditions(factory, owner, { inputId, fieldId: amount, persist: true, conds: [c] })
    ).to.be.revertedWithCustomError(impl, "SelfReferentialVar");
  });

  it("(d) accepts a VAR-left condition against a DIFFERENT var: VAR(amount) LTE VAR(ceiling)", async () => {
    const { factory } = await deployFactory();
    const [owner] = await ethers.getSigners();

    // Legitimate: comparing the persisted amount var against a different var is meaningful.
    const c = cond(
      varRef(FieldType.UINT256, amount),
      CmpOp.LTE,
      varRef(FieldType.UINT256, other)
    );

    await expect(
      createWithConditions(factory, owner, { inputId, fieldId: amount, persist: true, conds: [c] })
    ).to.not.be.reverted;
  });

  it("(e) accepts a VAR-left condition against a CONST: VAR(amount) GTE 100", async () => {
    const { factory } = await deployFactory();
    const [owner] = await ethers.getSigners();

    const c = cond(varRef(FieldType.UINT256, amount), CmpOp.GTE, constRef(FieldType.UINT256, 100n));

    await expect(
      createWithConditions(factory, owner, { inputId, fieldId: amount, persist: true, conds: [c] })
    ).to.not.be.reverted;
  });

  it("(f) accepts a self-shaped condition when the field is NOT persisted (no degenerate write)", async () => {
    const { factory } = await deployFactory();
    const [owner] = await ethers.getSigners();

    // VAR(amount) EQ FIELD(amount), but `amount` is NOT auto-persisted, so vars[amount] is
    // whatever a prior init/effect set it to — the comparison is not vacuous.
    const c = cond(
      varRef(FieldType.UINT256, amount),
      CmpOp.EQ,
      fieldRef(FieldType.UINT256, amount)
    );

    await expect(
      createWithConditions(factory, owner, { inputId, fieldId: amount, persist: false, conds: [c] })
    ).to.not.be.reverted;
  });
});
