/**
 * ValueLib — IN/NOT_IN membership edges + FIELD_LENGTH / IF_PRESENT variants
 * (R2 hardening, gaps 6 & 8). Eval-time semantics over heterogeneous sets and
 * presence handling, across all IN-legal types (not just ADDRESS).
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
  fieldLengthRef,
  synthRef,
  field,
  cond,
  freshValueLibHarness,
  id,
  encFor,
} from "../helpers/value-lib";

const ADDR_A = ethers.getAddress("0x000000000000000000000000000000000000aaaa");
const ADDR_B = ethers.getAddress("0x000000000000000000000000000000000000bbbb");
const ADDR_C = ethers.getAddress("0x000000000000000000000000000000000000cccc");
const B32_A = ethers.id("b32-a");
const B32_B = ethers.id("b32-b");
const B32_C = ethers.id("b32-c");

interface InSample {
  fType: FieldTypeVal;
  name: string;
  hit: any; // value present in the set
  miss: any; // value absent from the set (distinct from hit and other)
  other: any; // a second distinct set element (distinct from hit and miss)
}
const IN_SAMPLES: InSample[] = [
  { fType: FieldType.UINT256, name: "UINT256", hit: 7n, miss: 99n, other: 8n },
  { fType: FieldType.ADDRESS, name: "ADDRESS", hit: ADDR_A, miss: ADDR_C, other: ADDR_B },
  { fType: FieldType.BYTES32, name: "BYTES32", hit: B32_A, miss: B32_C, other: B32_B },
];

describe("ValueLib membership — empty IN / NOT_IN", () => {
  for (const s of IN_SAMPLES) {
    it(`${s.name}: IN over empty set is false; NOT_IN over empty set is true`, async () => {
      const h = await freshValueLibHarness();
      expect(await h.checkBool(cond(constRef(s.fType, s.hit), CmpOp.IN, []), [])).to.equal(false);
      expect(await h.checkBool(cond(constRef(s.fType, s.hit), CmpOp.NOT_IN, []), [])).to.equal(true);
    });
  }
});

describe("ValueLib membership — short-circuit: early match before a would-revert element", () => {
  for (const s of IN_SAMPLES) {
    it(`${s.name}: matches first CONST element before an unset VAR element (no revert)`, async () => {
      const h = await freshValueLibHarness();
      const set = [constRef(s.fType, s.hit), varRef(s.fType, id("never-set"))];
      // left == first element → match found and loop breaks before resolving the unset VAR.
      expect(await h.checkBool(cond(constRef(s.fType, s.hit), CmpOp.IN, set), [])).to.equal(true);
    });
  }
});

describe("ValueLib membership — unset element BEFORE a later match reverts (no skip)", () => {
  for (const s of IN_SAMPLES) {
    it(`${s.name}: an unset VAR element ahead of the matching element reverts VarNotSet`, async () => {
      const h = await freshValueLibHarness();
      const set = [varRef(s.fType, id("unset-first")), constRef(s.fType, s.hit)];
      await expect(
        h.checkBool(cond(constRef(s.fType, s.hit), CmpOp.IN, set), [])
      ).to.be.revertedWithCustomError(h, "VarNotSet");
    });
  }
});

describe("ValueLib membership — wrong-element-type reverts TypeMismatch at eval", () => {
  it("UINT256 IN a set containing an ADDRESS element reverts TypeMismatch", async () => {
    const h = await freshValueLibHarness();
    // The element type differs from the left type; _equals reverts TypeMismatch when reached.
    const set = [constRef(FieldType.UINT256, 7n), constRef(FieldType.ADDRESS, ADDR_A)];
    // left != first element, so the loop reaches the mistyped element.
    await expect(
      h.checkBool(cond(constRef(FieldType.UINT256, 8n), CmpOp.IN, set), [])
    ).to.be.revertedWithCustomError(h, "TypeMismatch");
  });
});

describe("ValueLib membership — VAR/FIELD elements resolve correctly per type", () => {
  for (const s of IN_SAMPLES) {
    it(`${s.name}: left matches a VAR element resolved from storage`, async () => {
      const h = await freshValueLibHarness();
      const varId = id(`${s.name}-allowed`);
      await h.setVar(varId, s.fType, encFor(s.fType, s.hit));
      const set = [constRef(s.fType, s.other), varRef(s.fType, varId)];
      expect(await h.checkBool(cond(constRef(s.fType, s.hit), CmpOp.IN, set), [])).to.equal(true);
      expect(await h.checkBool(cond(constRef(s.fType, s.miss), CmpOp.IN, set), [])).to.equal(false);
    });
  }
});

describe("ValueLib FIELD_LENGTH — absent / wrong-type / empty", () => {
  it("absent field reverts FieldAbsent", async () => {
    const h = await freshValueLibHarness();
    await expect(h.resolve(fieldLengthRef(id("nope")), [])).to.be.revertedWithCustomError(h, "FieldAbsent");
  });

  it("wrong-type field (UINT256) reverts TypeMismatch", async () => {
    const h = await freshValueLibHarness();
    const fid = id("amount");
    await expect(
      h.resolve(fieldLengthRef(fid), [field(FieldType.UINT256, fid, 5n)])
    ).to.be.revertedWithCustomError(h, "TypeMismatch");
  });

  it("empty string has length 0", async () => {
    const h = await freshValueLibHarness();
    const fid = id("s");
    const [, d] = await h.resolve(fieldLengthRef(fid), [field(FieldType.STRING, fid, "")]);
    expect(ethers.AbiCoder.defaultAbiCoder().decode(["uint256"], d)[0]).to.equal(0n);
  });

  it("empty bytes has length 0", async () => {
    const h = await freshValueLibHarness();
    const fid = id("b");
    const [, d] = await h.resolve(fieldLengthRef(fid), [field(FieldType.BYTES, fid, "0x")]);
    expect(ethers.AbiCoder.defaultAbiCoder().decode(["uint256"], d)[0]).to.equal(0n);
  });
});

describe("ValueLib IF_PRESENT — skip happens BEFORE resolving the RHS", () => {
  it("skips even when the RHS VAR is unset (no VarNotSet) for an absent FIELD left", async () => {
    const h = await freshValueLibHarness();
    const fieldId = id("opt");
    const c = cond(fieldRef(FieldType.UINT256, fieldId), CmpOp.EQ, varRef(FieldType.UINT256, id("unset-rhs")), true);
    // Field absent → skip → true, without ever resolving the unset VAR rhs.
    expect(await h.checkBool(c, [])).to.equal(true);
  });

  it("skips even when the RHS VAR would type-mismatch, for an absent FIELD left", async () => {
    const h = await freshValueLibHarness();
    const fieldId = id("opt");
    const rhsVar = id("wrong-type-rhs");
    await h.setVar(rhsVar, FieldType.ADDRESS, encFor(FieldType.ADDRESS, ADDR_A));
    // left FIELD declared UINT256 vs rhs VAR declared UINT256 but stored ADDRESS — would
    // TypeMismatch at resolve, but the absent left short-circuits to skip first.
    const c = cond(fieldRef(FieldType.UINT256, fieldId), CmpOp.EQ, varRef(FieldType.UINT256, rhsVar), true);
    expect(await h.checkBool(c, [])).to.equal(true);
  });

  it("skips for a FIELD_LENGTH left when the field is absent", async () => {
    const h = await freshValueLibHarness();
    const fieldId = id("optstr");
    const c = cond(fieldLengthRef(fieldId), CmpOp.GTE, constRef(FieldType.UINT256, 3n), true);
    expect(await h.checkBool(c, [])).to.equal(true);
    // present + too short → evaluates to false.
    expect(await h.checkBool(c, [field(FieldType.STRING, fieldId, "ab")])).to.equal(false);
  });
});

describe("ValueLib — NOW/SELF/CALLER/AUTH_SIGNER never 'absent' under IF_PRESENT", () => {
  it("a synthesized-source left is evaluated even with skipIfAbsent=true", async () => {
    const h = await freshValueLibHarness();
    await h.setContext(ethers.ZeroAddress, ethers.ZeroAddress, await h.getAddress(), 100n);
    const c = cond(synthRef(ValueSource.NOW, FieldType.UINT256), CmpOp.GTE, constRef(FieldType.UINT256, 50n), true);
    expect(await h.checkBool(c, [])).to.equal(true);
  });
});
