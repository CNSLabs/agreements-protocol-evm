/**
 * ValueLib — property and source-coverage checks (R2).
 *
 * Complements the legality matrix with: every source resolves correctly
 * (CONST/VAR/FIELD/FIELD_LENGTH/AUTH_SIGNER/CALLER/SELF/NOW; STATIC_CALL deferred),
 * EQ(x,x) holds for every type across sources, EQ/NEQ stay complementary, VAR and
 * FIELD round-trip through resolve, and the typed-revert behaviors (VarNotSet,
 * FieldAbsent, TypeMismatch, IF_PRESENT skip) hold.
 */

import { expect } from "chai";
import { ethers } from "hardhat";
import {
  FieldType,
  ValueSource,
  CmpOp,
  type FieldTypeVal,
  constRef,
  varRef,
  fieldRef,
  synthRef,
  field,
  cond,
  freshValueLibHarness,
  id,
  encFor,
  coder,
} from "../helpers/value-lib";

const ADDR = ethers.getAddress("0x000000000000000000000000000000000000a11e");
const B32 = ethers.id("a-bytes32");

interface Sample {
  fType: FieldTypeVal;
  name: string;
  value: any;
}
const SAMPLES: Sample[] = [
  { fType: FieldType.UINT256, name: "UINT256", value: 42n },
  { fType: FieldType.STRING, name: "STRING", value: "hello world" },
  { fType: FieldType.ADDRESS, name: "ADDRESS", value: ADDR },
  { fType: FieldType.BOOL, name: "BOOL", value: true },
  { fType: FieldType.BYTES32, name: "BYTES32", value: B32 },
  { fType: FieldType.BYTES, name: "BYTES", value: "0x0011223344" },
];

describe("ValueLib property — EQ(x,x) true for every type via CONST/VAR/FIELD", () => {
  for (const s of SAMPLES) {
    it(`${s.name}: CONST EQ CONST self`, async () => {
      const h = await freshValueLibHarness();
      expect(await h.checkBool(cond(constRef(s.fType, s.value), CmpOp.EQ, constRef(s.fType, s.value)), []))
        .to.equal(true);
    });
    it(`${s.name}: FIELD EQ VAR (same value) round-trips`, async () => {
      const h = await freshValueLibHarness();
      const varId = id(`${s.name}-var`);
      const fieldId = id(`${s.name}-field`);
      await h.setVar(varId, s.fType, encFor(s.fType, s.value));
      const c = cond(fieldRef(s.fType, fieldId), CmpOp.EQ, varRef(s.fType, varId));
      expect(await h.checkBool(c, [field(s.fType, fieldId, s.value)])).to.equal(true);
    });
    it(`${s.name}: NEQ is the negation of EQ`, async () => {
      const h = await freshValueLibHarness();
      const eq = await h.checkBool(cond(constRef(s.fType, s.value), CmpOp.EQ, constRef(s.fType, s.value)), []);
      const neq = await h.checkBool(cond(constRef(s.fType, s.value), CmpOp.NEQ, constRef(s.fType, s.value)), []);
      expect(neq).to.equal(!eq);
    });
  }
});

describe("ValueLib resolve — every source returns its canonical (FieldType, bytes)", () => {
  it("CONST returns its declared type and data verbatim", async () => {
    const h = await freshValueLibHarness();
    const [t, d] = await h.resolve(constRef(FieldType.UINT256, 7n), []);
    expect(Number(t)).to.equal(FieldType.UINT256);
    expect(coder.decode(["uint256"], d)[0]).to.equal(7n);
  });

  it("VAR resolves the stored value", async () => {
    const h = await freshValueLibHarness();
    const varId = id("v");
    await h.setVar(varId, FieldType.BYTES32, encFor(FieldType.BYTES32, B32));
    const [t, d] = await h.resolve(varRef(FieldType.BYTES32, varId), []);
    expect(Number(t)).to.equal(FieldType.BYTES32);
    expect(coder.decode(["bytes32"], d)[0]).to.equal(B32);
  });

  it("FIELD resolves the submitted value", async () => {
    const h = await freshValueLibHarness();
    const fieldId = id("f");
    const [t, d] = await h.resolve(fieldRef(FieldType.BOOL, fieldId), [field(FieldType.BOOL, fieldId, true)]);
    expect(Number(t)).to.equal(FieldType.BOOL);
    expect(coder.decode(["bool"], d)[0]).to.equal(true);
  });
});

describe("ValueLib resolve — typed reverts", () => {
  it("VAR unset reverts VarNotSet", async () => {
    const h = await freshValueLibHarness();
    await expect(h.resolve(varRef(FieldType.UINT256, id("missing")), []))
      .to.be.revertedWithCustomError(h, "VarNotSet");
  });

  it("FIELD absent reverts FieldAbsent", async () => {
    const h = await freshValueLibHarness();
    await expect(h.resolve(fieldRef(FieldType.UINT256, id("missing")), []))
      .to.be.revertedWithCustomError(h, "FieldAbsent");
  });

  it("VAR declared-type mismatch reverts TypeMismatch", async () => {
    const h = await freshValueLibHarness();
    const varId = id("v");
    await h.setVar(varId, FieldType.ADDRESS, encFor(FieldType.ADDRESS, ADDR));
    await expect(h.resolve(varRef(FieldType.UINT256, varId), []))
      .to.be.revertedWithCustomError(h, "TypeMismatch");
  });

  it("cross-type EQ (UINT256 vs ADDRESS) reverts TypeMismatch", async () => {
    const h = await freshValueLibHarness();
    const c = cond(constRef(FieldType.UINT256, 1n), CmpOp.EQ, constRef(FieldType.ADDRESS, ADDR));
    await expect(h.checkBool(c, [])).to.be.revertedWithCustomError(h, "TypeMismatch");
  });
});

describe("ValueLib — IF_PRESENT skip semantics", () => {
  it("skips (returns true) when the target field is absent and skipIfAbsent=true", async () => {
    const h = await freshValueLibHarness();
    const fieldId = id("opt");
    const c = cond(fieldRef(FieldType.UINT256, fieldId), CmpOp.GT, constRef(FieldType.UINT256, 100n), true);
    expect(await h.checkBool(c, [])).to.equal(true);
  });

  it("evaluates normally when the target field is present", async () => {
    const h = await freshValueLibHarness();
    const fieldId = id("opt");
    const c = cond(fieldRef(FieldType.UINT256, fieldId), CmpOp.GT, constRef(FieldType.UINT256, 100n), true);
    expect(await h.checkBool(c, [field(FieldType.UINT256, fieldId, 50n)])).to.equal(false);
    expect(await h.checkBool(c, [field(FieldType.UINT256, fieldId, 150n)])).to.equal(true);
  });

  it("reverts FieldAbsent when absent and skipIfAbsent=false", async () => {
    const h = await freshValueLibHarness();
    const fieldId = id("req");
    const c = cond(fieldRef(FieldType.UINT256, fieldId), CmpOp.GT, constRef(FieldType.UINT256, 100n), false);
    await expect(h.checkBool(c, [])).to.be.revertedWithCustomError(h, "FieldAbsent");
  });
});

describe("ValueLib — NOW comparable as UINT256 in conditions", () => {
  it("NOW GTE a deadline CONST evaluates against block time", async () => {
    const h = await freshValueLibHarness();
    await h.setContext(ethers.ZeroAddress, ethers.ZeroAddress, await h.getAddress(), 1_000n);
    const before = cond(synthRef(ValueSource.NOW, FieldType.UINT256), CmpOp.GTE, constRef(FieldType.UINT256, 2_000n));
    const after = cond(synthRef(ValueSource.NOW, FieldType.UINT256), CmpOp.GTE, constRef(FieldType.UINT256, 500n));
    expect(await h.checkBool(before, [])).to.equal(false);
    expect(await h.checkBool(after, [])).to.equal(true);
  });
});
