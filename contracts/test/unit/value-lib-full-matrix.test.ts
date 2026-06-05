/**
 * ValueLib — generated full matrix + init/eval legality agreement (R2 hardening, gaps 4 & 5).
 *
 * For every (resolvable left-source x resolved-type x op) triple this asserts:
 *   - validateLegality (init) and evaluate (eval) AGREE on legality: a cell illegal at
 *     init must revert at eval, and a legal cell must not revert at eval for legality
 *     reasons (it may still return a boolean).
 *   - For legal cells, the boolean result matches the expected truth value.
 *   - Arity / RHS-type rejection is exercised at init.
 *
 * Left-sources iterated: CONST, VAR, FIELD, plus the synthesized AUTH_SIGNER/CALLER/SELF
 * (ADDRESS) and NOW/FIELD_LENGTH (UINT256). STATIC_CALL is deferred (not iterated as a
 * resolvable source; its deferral is asserted in the matrix suite).
 */

import { expect } from "chai";
import { ethers } from "hardhat";
import {
  FieldType,
  ValueSource,
  CmpOp,
  type FieldTypeVal,
  type ValueSourceVal,
  type CmpOpVal,
  type ValueRef,
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
const B32_A = ethers.id("fm-b32-a");
const B32_B = ethers.id("fm-b32-b");

const ALL_OPS: CmpOpVal[] = [
  CmpOp.EQ, CmpOp.NEQ, CmpOp.GT, CmpOp.GTE, CmpOp.LT, CmpOp.LTE, CmpOp.IN, CmpOp.NOT_IN,
];
const OP_NAME: Record<number, string> = {
  [CmpOp.EQ]: "EQ", [CmpOp.NEQ]: "NEQ", [CmpOp.GT]: "GT", [CmpOp.GTE]: "GTE",
  [CmpOp.LT]: "LT", [CmpOp.LTE]: "LTE", [CmpOp.IN]: "IN", [CmpOp.NOT_IN]: "NOT_IN",
};

const ORDERED = new Set<CmpOpVal>([CmpOp.GT, CmpOp.GTE, CmpOp.LT, CmpOp.LTE]);
const MEMBERSHIP = new Set<CmpOpVal>([CmpOp.IN, CmpOp.NOT_IN]);
const IN_LEGAL = new Set<FieldTypeVal>([FieldType.UINT256, FieldType.ADDRESS, FieldType.BYTES32]);

/** Whether (type, op) is a legal cell per the documented matrix. */
function legal(fType: FieldTypeVal, op: CmpOpVal): boolean {
  if (op === CmpOp.EQ || op === CmpOp.NEQ) return true;
  if (ORDERED.has(op)) return fType === FieldType.UINT256;
  return IN_LEGAL.has(fType); // IN / NOT_IN
}

interface SourceCase {
  source: ValueSourceVal;
  name: string;
  fType: FieldTypeVal; // resolved type
  // Build a left ValueRef for this source resolving to `lo`, and the fields needed.
  leftRef: ValueRef;
  fields: ReturnType<typeof field>[];
  setup?: (h: any) => Promise<void>;
  lo: any;
  hi: any; // distinct value for NEQ / ordered / membership-miss
}

const LO = {
  [FieldType.UINT256]: 5n,
  [FieldType.STRING]: "lo",
  [FieldType.ADDRESS]: ADDR_A,
  [FieldType.BOOL]: false,
  [FieldType.BYTES32]: B32_A,
  [FieldType.BYTES]: "0x1122",
} as const;
const HI = {
  [FieldType.UINT256]: 9n,
  [FieldType.STRING]: "hi",
  [FieldType.ADDRESS]: ADDR_B,
  [FieldType.BOOL]: true,
  [FieldType.BYTES32]: B32_B,
  [FieldType.BYTES]: "0x3344",
} as const;

const ALL_TYPES: FieldTypeVal[] = [
  FieldType.UINT256, FieldType.STRING, FieldType.ADDRESS, FieldType.BOOL, FieldType.BYTES32, FieldType.BYTES,
];

// Build the per-source left cases. CONST/VAR/FIELD cover every type; the synthesized
// sources cover their single fixed type (ADDRESS or UINT256).
function buildCases(): SourceCase[] {
  const cases: SourceCase[] = [];

  for (const fType of ALL_TYPES) {
    cases.push({
      source: ValueSource.CONST, name: `CONST/${fType}`, fType,
      leftRef: constRef(fType, (LO as any)[fType]), fields: [],
      lo: (LO as any)[fType], hi: (HI as any)[fType],
    });
    const vId = id(`fm-var-${fType}`);
    cases.push({
      source: ValueSource.VAR, name: `VAR/${fType}`, fType,
      leftRef: varRef(fType, vId), fields: [],
      setup: async (h) => { await h.setVar(vId, fType, encFor(fType, (LO as any)[fType])); },
      lo: (LO as any)[fType], hi: (HI as any)[fType],
    });
    const fId = id(`fm-field-${fType}`);
    cases.push({
      source: ValueSource.FIELD, name: `FIELD/${fType}`, fType,
      leftRef: fieldRef(fType, fId), fields: [field(fType, fId, (LO as any)[fType])],
      lo: (LO as any)[fType], hi: (HI as any)[fType],
    });
  }

  // Synthesized ADDRESS sources.
  for (const [source, sname] of [
    [ValueSource.AUTH_SIGNER, "AUTH_SIGNER"], [ValueSource.CALLER, "CALLER"], [ValueSource.SELF, "SELF"],
  ] as Array<[ValueSourceVal, string]>) {
    cases.push({
      source, name: sname, fType: FieldType.ADDRESS,
      leftRef: synthRef(source, FieldType.ADDRESS), fields: [],
      setup: async (h) => { await h.setContext(ADDR_A, ADDR_A, ADDR_A, 5n); },
      lo: ADDR_A, hi: ADDR_B,
    });
  }
  // NOW (UINT256).
  cases.push({
    source: ValueSource.NOW, name: "NOW", fType: FieldType.UINT256,
    leftRef: synthRef(ValueSource.NOW, FieldType.UINT256), fields: [],
    setup: async (h) => { await h.setContext(ADDR_A, ADDR_A, ADDR_A, 5n); },
    lo: 5n, hi: 9n,
  });
  // FIELD_LENGTH (UINT256) — left resolves to the byte length (use a 5-byte string).
  const flId = id("fm-fl");
  cases.push({
    source: ValueSource.FIELD_LENGTH, name: "FIELD_LENGTH", fType: FieldType.UINT256,
    leftRef: fieldLengthRef(flId), fields: [field(FieldType.STRING, flId, "abcde")],
    lo: 5n, hi: 9n,
  });

  return cases;
}

describe("ValueLib — full generated matrix: init/eval legality agree + correct results", () => {
  const cases = buildCases();

  for (const sc of cases) {
    for (const op of ALL_OPS) {
      const isLegal = legal(sc.fType, op);

      it(`${sc.name} ${OP_NAME[op]}: ${isLegal ? "legal" : "illegal (both reject)"}`, async () => {
        const h = await freshValueLibHarness();
        if (sc.setup) await sc.setup(h);

        // RHS shaped per op: a single matching-type CONST(lo) for scalar; a 1-element
        // set for membership. (FIELD_LENGTH/NOW compare against UINT256 CONSTs.)
        const rhsLo = constRef(sc.fType, sc.lo);
        const rhsHi = constRef(sc.fType, sc.hi);

        if (!isLegal) {
          // init legality rejects.
          const c = MEMBERSHIP.has(op)
            ? cond(sc.leftRef, op, [rhsLo])
            : cond(sc.leftRef, op, rhsLo);
          await expect(h.validateLegality(c)).to.be.revertedWithCustomError(h, "IllegalComparison");
          // eval legality rejects too (same cell).
          await expect(h.checkBool(c, sc.fields)).to.be.revertedWithCustomError(h, "IllegalComparison");
          return;
        }

        // Legal: init must not revert.
        const cEq = MEMBERSHIP.has(op) ? cond(sc.leftRef, op, [rhsLo]) : cond(sc.leftRef, op, rhsLo);
        await h.validateLegality(cEq);

        // Eval correctness.
        if (op === CmpOp.EQ) {
          expect(await h.checkBool(cond(sc.leftRef, op, rhsLo), sc.fields)).to.equal(true);
          expect(await h.checkBool(cond(sc.leftRef, op, rhsHi), sc.fields)).to.equal(false);
        } else if (op === CmpOp.NEQ) {
          expect(await h.checkBool(cond(sc.leftRef, op, rhsLo), sc.fields)).to.equal(false);
          expect(await h.checkBool(cond(sc.leftRef, op, rhsHi), sc.fields)).to.equal(true);
        } else if (op === CmpOp.GT) {
          expect(await h.checkBool(cond(sc.leftRef, op, rhsHi), sc.fields)).to.equal(false); // lo > hi false
          expect(await h.checkBool(cond(sc.leftRef, op, rhsLo), sc.fields)).to.equal(false); // lo > lo false
        } else if (op === CmpOp.GTE) {
          expect(await h.checkBool(cond(sc.leftRef, op, rhsLo), sc.fields)).to.equal(true); // lo >= lo
          expect(await h.checkBool(cond(sc.leftRef, op, rhsHi), sc.fields)).to.equal(false); // lo >= hi false
        } else if (op === CmpOp.LT) {
          expect(await h.checkBool(cond(sc.leftRef, op, rhsHi), sc.fields)).to.equal(true); // lo < hi
          expect(await h.checkBool(cond(sc.leftRef, op, rhsLo), sc.fields)).to.equal(false); // lo < lo false
        } else if (op === CmpOp.LTE) {
          expect(await h.checkBool(cond(sc.leftRef, op, rhsLo), sc.fields)).to.equal(true); // lo <= lo
          expect(await h.checkBool(cond(sc.leftRef, op, rhsHi), sc.fields)).to.equal(true); // lo <= hi
        } else if (op === CmpOp.IN) {
          expect(await h.checkBool(cond(sc.leftRef, op, [rhsHi, rhsLo]), sc.fields)).to.equal(true);
          expect(await h.checkBool(cond(sc.leftRef, op, [rhsHi]), sc.fields)).to.equal(false);
        } else if (op === CmpOp.NOT_IN) {
          expect(await h.checkBool(cond(sc.leftRef, op, [rhsHi]), sc.fields)).to.equal(true);
          expect(await h.checkBool(cond(sc.leftRef, op, [rhsHi, rhsLo]), sc.fields)).to.equal(false);
        }
      });
    }
  }
});

describe("ValueLib — init structural rejection (arity / RHS type)", () => {
  it("scalar EQ with two RHS operands reverts ArityMismatch", async () => {
    const h = await freshValueLibHarness();
    const c = cond(constRef(FieldType.UINT256, 1n), CmpOp.EQ, [constRef(FieldType.UINT256, 1n), constRef(FieldType.UINT256, 2n)]);
    await expect(h.validateLegality(c)).to.be.revertedWithCustomError(h, "ArityMismatch");
  });

  it("scalar EQ with zero RHS operands reverts ArityMismatch", async () => {
    const h = await freshValueLibHarness();
    const c = cond(constRef(FieldType.UINT256, 1n), CmpOp.EQ, []);
    await expect(h.validateLegality(c)).to.be.revertedWithCustomError(h, "ArityMismatch");
  });

  it("EQ with mismatched RHS type reverts TypeMismatch at init", async () => {
    const h = await freshValueLibHarness();
    const c = cond(constRef(FieldType.UINT256, 1n), CmpOp.EQ, constRef(FieldType.ADDRESS, ADDR_A));
    await expect(h.validateLegality(c)).to.be.revertedWithCustomError(h, "TypeMismatch");
  });

  it("IN with a mismatched-type element reverts TypeMismatch at init", async () => {
    const h = await freshValueLibHarness();
    const c = cond(constRef(FieldType.ADDRESS, ADDR_A), CmpOp.IN, [constRef(FieldType.ADDRESS, ADDR_A), constRef(FieldType.BYTES32, B32_A)]);
    await expect(h.validateLegality(c)).to.be.revertedWithCustomError(h, "TypeMismatch");
  });

  it("IN with an empty set passes init legality (membership always-false is well-formed)", async () => {
    const h = await freshValueLibHarness();
    const c = cond(constRef(FieldType.ADDRESS, ADDR_A), CmpOp.IN, []);
    await h.validateLegality(c);
  });
});
