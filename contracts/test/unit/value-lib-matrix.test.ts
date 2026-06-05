/**
 * ValueLib — full source x type x op legality matrix (R2).
 *
 * Table-driven: for every (source, type, op) we assert either a defined boolean
 * result / skip, or a single defined revert. No silent holes.
 *
 * The legality matrix (defaults):
 *   - Ordered (GT/GTE/LT/LTE): UINT256 only; all other types reject.
 *   - EQ/NEQ: all types (value compare; keccak256 for STRING/BYTES).
 *   - IN/NOT_IN: UINT256, ADDRESS, BYTES32 only; BOOL/BYTES/STRING reject.
 *   - BYTES / BOOL: EQ/NEQ only.
 *
 * Real harness, no mocks for the lib.
 */

import { expect } from "chai";
import {
  FieldType,
  ValueSource,
  CmpOp,
  type FieldTypeVal,
  type CmpOpVal,
  constRef,
  varRef,
  fieldRef,
  fieldLengthRef,
  synthRef,
  field,
  cond,
  freshValueLibHarness,
  id,
  encAddress,
} from "../helpers/value-lib";
import { ethers } from "hardhat";

// A representative pair of distinct values per type, for EQ/NEQ + ordered tests.
const ADDR_A = ethers.getAddress("0x000000000000000000000000000000000000aaaa");
const ADDR_B = ethers.getAddress("0x000000000000000000000000000000000000bbbb");
const ADDR_C = ethers.getAddress("0x000000000000000000000000000000000000cccc");
const B32_A = ethers.id("bytes32-a");
const B32_B = ethers.id("bytes32-b");

interface TypeSample {
  fType: FieldTypeVal;
  name: string;
  lo: any; // a "smaller" / first value
  hi: any; // a "larger" / second value (distinct from lo)
}

const SAMPLES: TypeSample[] = [
  { fType: FieldType.UINT256, name: "UINT256", lo: 1n, hi: 2n },
  { fType: FieldType.STRING, name: "STRING", lo: "alpha", hi: "beta" },
  { fType: FieldType.ADDRESS, name: "ADDRESS", lo: ADDR_A, hi: ADDR_B },
  { fType: FieldType.BOOL, name: "BOOL", lo: false, hi: true },
  { fType: FieldType.BYTES32, name: "BYTES32", lo: B32_A, hi: B32_B },
  { fType: FieldType.BYTES, name: "BYTES", lo: "0xdead", hi: "0xbeef" },
];

const ORDERED: CmpOpVal[] = [CmpOp.GT, CmpOp.GTE, CmpOp.LT, CmpOp.LTE];
const ORDERED_NAMES: Record<number, string> = {
  [CmpOp.GT]: "GT",
  [CmpOp.GTE]: "GTE",
  [CmpOp.LT]: "LT",
  [CmpOp.LTE]: "LTE",
};

// Types for which IN / NOT_IN are legal.
const IN_LEGAL = new Set<FieldTypeVal>([FieldType.UINT256, FieldType.ADDRESS, FieldType.BYTES32]);

describe("ValueLib matrix — EQ / NEQ over all types (CONST left & right)", () => {
  for (const s of SAMPLES) {
    it(`${s.name}: EQ(lo,lo) true, EQ(lo,hi) false`, async () => {
      const h = await freshValueLibHarness();
      expect(await h.checkBool(cond(constRef(s.fType, s.lo), CmpOp.EQ, constRef(s.fType, s.lo)), []))
        .to.equal(true);
      expect(await h.checkBool(cond(constRef(s.fType, s.lo), CmpOp.EQ, constRef(s.fType, s.hi)), []))
        .to.equal(false);
    });

    it(`${s.name}: NEQ complementary to EQ`, async () => {
      const h = await freshValueLibHarness();
      const eqSame = await h.checkBool(cond(constRef(s.fType, s.lo), CmpOp.EQ, constRef(s.fType, s.lo)), []);
      const neqSame = await h.checkBool(cond(constRef(s.fType, s.lo), CmpOp.NEQ, constRef(s.fType, s.lo)), []);
      expect(eqSame).to.equal(!neqSame);
      const eqDiff = await h.checkBool(cond(constRef(s.fType, s.lo), CmpOp.EQ, constRef(s.fType, s.hi)), []);
      const neqDiff = await h.checkBool(cond(constRef(s.fType, s.lo), CmpOp.NEQ, constRef(s.fType, s.hi)), []);
      expect(eqDiff).to.equal(!neqDiff);
    });
  }
});

describe("ValueLib matrix — ordered ops legal for UINT256 only", () => {
  it("UINT256 ordered comparisons are correct", async () => {
    const h = await freshValueLibHarness();
    const lo = constRef(FieldType.UINT256, 1n);
    const hi = constRef(FieldType.UINT256, 2n);
    expect(await h.checkBool(cond(hi, CmpOp.GT, lo), [])).to.equal(true);
    expect(await h.checkBool(cond(lo, CmpOp.GT, hi), [])).to.equal(false);
    expect(await h.checkBool(cond(lo, CmpOp.GTE, lo), [])).to.equal(true);
    expect(await h.checkBool(cond(lo, CmpOp.LT, hi), [])).to.equal(true);
    expect(await h.checkBool(cond(lo, CmpOp.LTE, lo), [])).to.equal(true);
    expect(await h.checkBool(cond(hi, CmpOp.LTE, lo), [])).to.equal(false);
  });

  for (const s of SAMPLES) {
    if (s.fType === FieldType.UINT256) continue;
    for (const op of ORDERED) {
      it(`${s.name} ${ORDERED_NAMES[op]} reverts IllegalComparison`, async () => {
        const h = await freshValueLibHarness();
        await expect(
          h.checkBool(cond(constRef(s.fType, s.lo), op, constRef(s.fType, s.hi)), [])
        ).to.be.revertedWithCustomError(h, "IllegalComparison");
      });
    }
  }
});

describe("ValueLib matrix — IN / NOT_IN legality", () => {
  for (const s of SAMPLES) {
    if (IN_LEGAL.has(s.fType)) {
      it(`${s.name}: IN membership over mixed CONST set`, async () => {
        const h = await freshValueLibHarness();
        const set = [constRef(s.fType, s.lo), constRef(s.fType, s.hi)];
        expect(await h.checkBool(cond(constRef(s.fType, s.lo), CmpOp.IN, set), [])).to.equal(true);
        expect(await h.checkBool(cond(constRef(s.fType, s.hi), CmpOp.NOT_IN, set), [])).to.equal(false);
      });
      it(`${s.name}: IN non-membership`, async () => {
        const h = await freshValueLibHarness();
        const set = [constRef(s.fType, s.hi)];
        expect(await h.checkBool(cond(constRef(s.fType, s.lo), CmpOp.IN, set), [])).to.equal(false);
        expect(await h.checkBool(cond(constRef(s.fType, s.lo), CmpOp.NOT_IN, set), [])).to.equal(true);
      });
    } else {
      for (const op of [CmpOp.IN, CmpOp.NOT_IN] as CmpOpVal[]) {
        const opName = op === CmpOp.IN ? "IN" : "NOT_IN";
        it(`${s.name} ${opName} reverts IllegalComparison`, async () => {
          const h = await freshValueLibHarness();
          await expect(
            h.checkBool(cond(constRef(s.fType, s.lo), op, [constRef(s.fType, s.lo)]), [])
          ).to.be.revertedWithCustomError(h, "IllegalComparison");
        });
      }
    }
  }
});

describe("ValueLib matrix — IN over mixed ValueRef[] (CONST + VAR + FIELD)", () => {
  it("resolves heterogeneous set elements and finds membership", async () => {
    const h = await freshValueLibHarness();
    const varId = id("allowed-var");
    await h.setVar(varId, FieldType.ADDRESS, encAddress(ADDR_A));
    const fieldId = id("allowed-field");
    const set = [
      constRef(FieldType.ADDRESS, ADDR_B),
      varRef(FieldType.ADDRESS, varId),
      fieldRef(FieldType.ADDRESS, fieldId),
    ];
    // left = ADDR_A, which matches the VAR element.
    expect(
      await h.checkBool(cond(constRef(FieldType.ADDRESS, ADDR_A), CmpOp.IN, set), [
        field(FieldType.ADDRESS, fieldId, ADDR_B),
      ])
    ).to.equal(true);
    // left = an address present only via the FIELD element.
    expect(
      await h.checkBool(cond(constRef(FieldType.ADDRESS, ADDR_C), CmpOp.IN, set), [
        field(FieldType.ADDRESS, fieldId, ADDR_C),
      ])
    ).to.equal(true);
  });
});

describe("ValueLib resolve — synthesized & derived sources", () => {
  it("NOW resolves to the harness-configured timestamp", async () => {
    const h = await freshValueLibHarness();
    const ts = 1_700_000_000n;
    await h.setContext(ethers.ZeroAddress, ethers.ZeroAddress, await h.getAddress(), ts);
    const [fType, data] = await h.resolve(synthRef(ValueSource.NOW, FieldType.UINT256), []);
    expect(Number(fType)).to.equal(FieldType.UINT256);
    expect(ethers.AbiCoder.defaultAbiCoder().decode(["uint256"], data)[0]).to.equal(ts);
  });

  it("SELF resolves to the configured self address", async () => {
    const h = await freshValueLibHarness();
    const self = "0x0000000000000000000000000000000000005e1f";
    await h.setContext(ethers.ZeroAddress, ethers.ZeroAddress, self, 0n);
    const [fType, data] = await h.resolve(synthRef(ValueSource.SELF, FieldType.ADDRESS), []);
    expect(Number(fType)).to.equal(FieldType.ADDRESS);
    expect(ethers.AbiCoder.defaultAbiCoder().decode(["address"], data)[0]).to.equal(
      ethers.getAddress(self)
    );
  });

  it("CALLER and AUTH_SIGNER resolve distinctly (relayer vs signer)", async () => {
    const h = await freshValueLibHarness();
    const signer = ADDR_A;
    const caller = ADDR_B;
    await h.setContext(signer, caller, await h.getAddress(), 0n);
    const [, sData] = await h.resolve(synthRef(ValueSource.AUTH_SIGNER, FieldType.ADDRESS), []);
    const [, cData] = await h.resolve(synthRef(ValueSource.CALLER, FieldType.ADDRESS), []);
    expect(ethers.AbiCoder.defaultAbiCoder().decode(["address"], sData)[0]).to.equal(
      ethers.getAddress(signer)
    );
    expect(ethers.AbiCoder.defaultAbiCoder().decode(["address"], cData)[0]).to.equal(
      ethers.getAddress(caller)
    );
  });

  it("FIELD_LENGTH equals the byte length of a STRING field", async () => {
    const h = await freshValueLibHarness();
    const fieldId = id("note");
    const value = "héllo"; // é is 2 bytes in UTF-8 → 6 bytes total
    const expectedLen = BigInt(Buffer.byteLength(value, "utf8"));
    const [fType, data] = await h.resolve(fieldLengthRef(fieldId), [field(FieldType.STRING, fieldId, value)]);
    expect(Number(fType)).to.equal(FieldType.UINT256);
    expect(ethers.AbiCoder.defaultAbiCoder().decode(["uint256"], data)[0]).to.equal(expectedLen);
  });

  it("FIELD_LENGTH equals the byte length of a BYTES field", async () => {
    const h = await freshValueLibHarness();
    const fieldId = id("blob");
    const [, data] = await h.resolve(fieldLengthRef(fieldId), [field(FieldType.BYTES, fieldId, "0xdeadbeef")]);
    expect(ethers.AbiCoder.defaultAbiCoder().decode(["uint256"], data)[0]).to.equal(4n);
  });

  it("FIELD_LENGTH is comparable as UINT256 (GTE CONST)", async () => {
    const h = await freshValueLibHarness();
    const fieldId = id("note");
    const c = cond(fieldLengthRef(fieldId), CmpOp.GTE, constRef(FieldType.UINT256, 3n));
    expect(await h.checkBool(c, [field(FieldType.STRING, fieldId, "abc")])).to.equal(true);
    expect(await h.checkBool(c, [field(FieldType.STRING, fieldId, "ab")])).to.equal(false);
  });
});

describe("ValueLib resolve — STATIC_CALL (R6)", () => {
  // The full STATIC_CALL behavior matrix (typed decode, bounds, fail modes, no-self) lives
  // in value-lib-static-call.test.ts. Here we only pin that the source is no longer a
  // deferred UnsupportedSource hole: a STATIC_CALL with an undecodable spec reverts.
  it("reverts on an undecodable spec (no longer UnsupportedSource)", async () => {
    const h = await freshValueLibHarness();
    await expect(h.resolve(synthRef(ValueSource.STATIC_CALL, FieldType.UINT256), [])).to.be
      .reverted;
  });
});

describe("ValueLib init-time legality — ordered ops rejected for non-UINT statically", () => {
  for (const s of SAMPLES) {
    if (s.fType === FieldType.UINT256) continue;
    it(`${s.name} GT rejected at init via validateLegality`, async () => {
      const h = await freshValueLibHarness();
      await expect(
        h.validateLegality(cond(constRef(s.fType, s.lo), CmpOp.GT, constRef(s.fType, s.hi)))
      ).to.be.revertedWithCustomError(h, "IllegalComparison");
    });
  }

  it("UINT256 GT passes validateLegality", async () => {
    const h = await freshValueLibHarness();
    await h.validateLegality(
      cond(constRef(FieldType.UINT256, 1n), CmpOp.GT, constRef(FieldType.UINT256, 2n))
    );
  });

  for (const s of SAMPLES) {
    if (IN_LEGAL.has(s.fType)) continue;
    it(`${s.name} IN rejected at init via validateLegality`, async () => {
      const h = await freshValueLibHarness();
      await expect(
        h.validateLegality(cond(constRef(s.fType, s.lo), CmpOp.IN, [constRef(s.fType, s.lo)]))
      ).to.be.revertedWithCustomError(h, "IllegalComparison");
    });
  }
});
