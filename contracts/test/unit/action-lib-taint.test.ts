/**
 * R7 — ActionLib taint analysis, unit-level.
 *
 * Two surfaces:
 *   - computeTaintedVars: the option-B propagation fixpoint over var writes (seeds +
 *     transitive var<-var write chains). This is where the "effect chain" propagation is
 *     proven: a var written from a tainted var is itself tainted, transitively.
 *   - validateActionsTaint: the init-time reject/accept gate the engine calls, exercised
 *     directly against encoded actions + persisted-field seeds.
 */

import { expect } from "chai";
import { ethers } from "hardhat";
import { freshActionLibHarness, call, dynSlot, output, encodeCalls } from "../helpers/action-lib";
import {
  FieldType,
  ValueSource,
  CmpOp,
  type CmpOpVal,
  type ValueRef,
  constRef,
  varRef,
  fieldRef,
  fieldLengthRef,
  synthRef,
  cond,
  id,
} from "../helpers/value-lib";

// Build a single-arg uint transferFrom-style call where `arg` is the (tainted) value,
// with the given constraint list. `arg` defaults to FIELD(amount).
const F_AMOUNT = id("amount");
function amountCall(constraints: any[], arg = fieldRef(FieldType.UINT256, F_AMOUNT)) {
  return call(constRef(FieldType.ADDRESS, ADDR), SEL, [dynSlot(arg)], constraints);
}
function le(left: ValueRef, op: CmpOpVal, rhs: ValueRef | ValueRef[]) {
  return cond(left, op, rhs);
}

const SEL = "0xaabbccdd";
const ADDR = ethers.getAddress("0x000000000000000000000000000000000000abcd");

describe("ActionLib.computeTaintedVars — option-B propagation fixpoint", () => {
  it("seeds alone are tainted; an untouched var is not", async () => {
    const h = await freshActionLibHarness();
    const out = await h.computeTaintedVars([id("a")], [], []);
    expect(out).to.deep.equal([id("a")]);
  });

  it("a var written from a FIELD source becomes tainted (direct write taint)", async () => {
    const h = await freshActionLibHarness();
    // write: vars[b] <- FIELD(x). No seeds.
    const out = await h.computeTaintedVars(
      [],
      [id("b")],
      [fieldRef(FieldType.UINT256, id("x"))]
    );
    expect(out).to.deep.equal([id("b")]);
  });

  it("a var written from a CONST source is NOT tainted", async () => {
    const h = await freshActionLibHarness();
    const out = await h.computeTaintedVars([], [id("b")], [constRef(FieldType.UINT256, 7n)]);
    expect(out.length).to.equal(0);
  });

  it("effect chain: c <- b, b <- FIELD taints both b and c transitively", async () => {
    const h = await freshActionLibHarness();
    // writes (in an order that requires a fixpoint, not a single forward pass):
    //   vars[c] <- VAR(b)   (b not yet known tainted at first scan)
    //   vars[b] <- FIELD(x) (taints b)
    // The fixpoint must then re-admit c on a second pass.
    const out: string[] = await h.computeTaintedVars(
      [],
      [id("c"), id("b")],
      [varRef(FieldType.UINT256, id("b")), fieldRef(FieldType.UINT256, id("x"))]
    );
    expect([...out].sort()).to.deep.equal([id("b"), id("c")].sort());
  });

  it("a var written only from a non-tainted var stays non-tainted", async () => {
    const h = await freshActionLibHarness();
    // vars[c] <- VAR(d); d is never tainted -> c not tainted.
    const out = await h.computeTaintedVars([], [id("c")], [varRef(FieldType.UINT256, id("d"))]);
    expect(out.length).to.equal(0);
  });
});

// Encode a single-call action's Call[] for validateActionsTaint.
function action(calls: any[]): string {
  return encodeCalls(calls);
}

describe("ActionLib.validateActionsTaint — init gate (direct)", () => {
  // validateActionsTaint is a PUBLIC (external linked) ActionLib entry point, so its
  // UnconstrainedTainted* errors live in ActionLib's ABI, not the harness's. Attach a
  // zero-address ActionLib handle purely so the matcher can decode those errors.
  let actionLib: any;
  before(async () => {
    actionLib = (await ethers.getContractFactory("ActionLib")).attach(ethers.ZeroAddress);
  });

  it("accepts a non-tainted CONST target with no constraints", async () => {
    const h = await freshActionLibHarness();
    await h.validateActionsTaint([action([call(constRef(FieldType.ADDRESS, ADDR), SEL, [])])], []);
  });

  it("rejects a FIELD target with no allowlist (UnconstrainedTaintedTarget)", async () => {
    const h = await freshActionLibHarness();
    await expect(
      h.validateActionsTaint(
        [action([call(fieldRef(FieldType.ADDRESS, id("t")), SEL, [])])],
        []
      )
    ).to.be.revertedWithCustomError(actionLib, "UnconstrainedTaintedTarget");
  });

  it("output of action 0 taints a var used as a target in action 1 (cross-action)", async () => {
    const h = await freshActionLibHarness();
    const V = id("captured");
    const a0 = action([
      call(constRef(FieldType.ADDRESS, ADDR), SEL, [], [], [output(0, FieldType.ADDRESS, V)]),
    ]);
    const a1 = action([call(varRef(FieldType.ADDRESS, V), SEL, [])]);
    await expect(h.validateActionsTaint([a0, a1], [])).to.be.revertedWithCustomError(
      actionLib,
      "UnconstrainedTaintedTarget"
    );
  });

  it("a persisted-field seed taints a VAR arg used unbounded (UnconstrainedTaintedArg)", async () => {
    const h = await freshActionLibHarness();
    const V = id("amt");
    const c = call(constRef(FieldType.ADDRESS, ADDR), SEL, [dynSlot(varRef(FieldType.UINT256, V))]);
    await expect(h.validateActionsTaint([action([c])], [V])).to.be.revertedWithCustomError(
      actionLib,
      "UnconstrainedTaintedArg"
    );
  });

  it("the same VAR arg is accepted when bounded by a two-sided range against the seed", async () => {
    const h = await freshActionLibHarness();
    const V = id("amt");
    const c = call(
      constRef(FieldType.ADDRESS, ADDR),
      SEL,
      [dynSlot(varRef(FieldType.UINT256, V))],
      [
        {
          left: varRef(FieldType.UINT256, V),
          op: CmpOp.LTE,
          skipIfAbsent: false,
          right: [constRef(FieldType.UINT256, 100n)],
        },
        {
          left: varRef(FieldType.UINT256, V),
          op: CmpOp.GTE,
          skipIfAbsent: false,
          right: [constRef(FieldType.UINT256, 1n)],
        },
      ]
    );
    await h.validateActionsTaint([action([c])], [V]);
  });

  it("weak bound: a FIELD arg bounded only against AUTH_SIGNER is rejected", async () => {
    const h = await freshActionLibHarness();
    const c = call(
      constRef(FieldType.ADDRESS, ADDR),
      SEL,
      [dynSlot(fieldRef(FieldType.ADDRESS, id("to")))],
      [
        {
          left: fieldRef(FieldType.ADDRESS, id("to")),
          op: CmpOp.EQ,
          skipIfAbsent: false,
          right: [synthRef(ValueSource.AUTH_SIGNER, FieldType.ADDRESS)],
        },
      ]
    );
    await expect(h.validateActionsTaint([action([c])], [])).to.be.revertedWithCustomError(
      actionLib,
      "UnconstrainedTaintedArg"
    );
  });

  it("NEQ does not bound a tainted arg (excludes a point, not a range)", async () => {
    const h = await freshActionLibHarness();
    const c = call(
      constRef(FieldType.ADDRESS, ADDR),
      SEL,
      [dynSlot(fieldRef(FieldType.UINT256, id("amount")))],
      [
        {
          left: fieldRef(FieldType.UINT256, id("amount")),
          op: CmpOp.NEQ,
          skipIfAbsent: false,
          right: [constRef(FieldType.UINT256, 0n)],
        },
      ]
    );
    await expect(h.validateActionsTaint([action([c])], [])).to.be.revertedWithCustomError(
      actionLib,
      "UnconstrainedTaintedArg"
    );
  });

  it("a scalar EQ against CONST bounds a tainted target only when op is IN (target needs allowlist)", async () => {
    const h = await freshActionLibHarness();
    // A tainted target with an EQ-CONST constraint (not IN) is still rejected — a target
    // requires a membership allowlist (IN), per the spec.
    const c = call(
      fieldRef(FieldType.ADDRESS, id("t")),
      SEL,
      [],
      [
        {
          left: fieldRef(FieldType.ADDRESS, id("t")),
          op: CmpOp.EQ,
          skipIfAbsent: false,
          right: [constRef(FieldType.ADDRESS, ADDR)],
        },
      ]
    );
    await expect(h.validateActionsTaint([action([c])], [])).to.be.revertedWithCustomError(
      actionLib,
      "UnconstrainedTaintedTarget"
    );
  });

  it("a tainted target IS accepted with an IN allowlist over CONST operands", async () => {
    const h = await freshActionLibHarness();
    const c = call(
      fieldRef(FieldType.ADDRESS, id("t")),
      SEL,
      [],
      [
        {
          left: fieldRef(FieldType.ADDRESS, id("t")),
          op: CmpOp.IN,
          skipIfAbsent: false,
          right: [constRef(FieldType.ADDRESS, ADDR)],
        },
      ]
    );
    await h.validateActionsTaint([action([c])], []);
  });
});

describe("ActionLib.validateActionsTaint — a lone one-sided ordered op does NOT bound an arg", () => {
  let actionLib: any;
  before(async () => {
    actionLib = (await ethers.getContractFactory("ActionLib")).attach(ethers.ZeroAddress);
  });

  // A single one-sided ordered bound leaves the other side submitter-controlled. The
  // engine can't know which side is security-critical, so a lone GTE/GT/LTE/LT is unsound.
  for (const [name, op] of [
    ["GTE", CmpOp.GTE],
    ["GT", CmpOp.GT],
    ["LTE", CmpOp.LTE],
    ["LT", CmpOp.LT],
  ] as const) {
    it(`rejects a lone ${name} on a tainted arg (UnconstrainedTaintedArg)`, async () => {
      const h = await freshActionLibHarness();
      const c = amountCall([le(fieldRef(FieldType.UINT256, F_AMOUNT), op, constRef(FieldType.UINT256, 1n))]);
      await expect(h.validateActionsTaint([action([c])], [])).to.be.revertedWithCustomError(
        actionLib,
        "UnconstrainedTaintedArg"
      );
    });
  }

  it("accepts a two-sided range: LTE cap AND GTE floor (both CONST)", async () => {
    const h = await freshActionLibHarness();
    const c = amountCall([
      le(fieldRef(FieldType.UINT256, F_AMOUNT), CmpOp.LTE, constRef(FieldType.UINT256, 100n)),
      le(fieldRef(FieldType.UINT256, F_AMOUNT), CmpOp.GTE, constRef(FieldType.UINT256, 1n)),
    ]);
    await h.validateActionsTaint([action([c])], []);
  });

  it("accepts a two-sided range built from LT and GT (strict bounds)", async () => {
    const h = await freshActionLibHarness();
    const c = amountCall([
      le(fieldRef(FieldType.UINT256, F_AMOUNT), CmpOp.LT, constRef(FieldType.UINT256, 100n)),
      le(fieldRef(FieldType.UINT256, F_AMOUNT), CmpOp.GT, constRef(FieldType.UINT256, 0n)),
    ]);
    await h.validateActionsTaint([action([c])], []);
  });

  it("accepts a lone EQ against a non-tainted operand", async () => {
    const h = await freshActionLibHarness();
    const c = amountCall([le(fieldRef(FieldType.UINT256, F_AMOUNT), CmpOp.EQ, constRef(FieldType.UINT256, 7n))]);
    await h.validateActionsTaint([action([c])], []);
  });

  it("accepts a lone IN against an all-non-tainted set", async () => {
    const h = await freshActionLibHarness();
    const c = amountCall([
      le(fieldRef(FieldType.UINT256, F_AMOUNT), CmpOp.IN, [
        constRef(FieldType.UINT256, 1n),
        constRef(FieldType.UINT256, 2n),
      ]),
    ]);
    await h.validateActionsTaint([action([c])], []);
  });

  it("rejects an upper bound paired with a TAINTED lower bound (the lower side is not real)", async () => {
    const h = await freshActionLibHarness();
    const F_FLOOR = id("floor");
    // LTE cap (real) AND GTE FIELD(floor) (tainted RHS) -> the lower side isn't a real
    // bound, so the range is still one-sided -> reject.
    const c = call(
      constRef(FieldType.ADDRESS, ADDR),
      SEL,
      [dynSlot(fieldRef(FieldType.UINT256, F_AMOUNT))],
      [
        le(fieldRef(FieldType.UINT256, F_AMOUNT), CmpOp.LTE, constRef(FieldType.UINT256, 100n)),
        le(fieldRef(FieldType.UINT256, F_AMOUNT), CmpOp.GTE, fieldRef(FieldType.UINT256, F_FLOOR)),
      ]
    );
    await expect(h.validateActionsTaint([action([c])], [])).to.be.revertedWithCustomError(
      actionLib,
      "UnconstrainedTaintedArg"
    );
  });

  it("FIELD_LENGTH arg: a lone GTE is rejected; a two-sided range is accepted", async () => {
    const h = await freshActionLibHarness();
    const F_BLOB = id("blob");
    const lenRef = fieldLengthRef(F_BLOB); // resolves UINT256; FIELD_LENGTH is a direct taint source
    const lone = amountCall([le(lenRef, CmpOp.GTE, constRef(FieldType.UINT256, 1n))], lenRef);
    await expect(h.validateActionsTaint([action([lone])], [])).to.be.revertedWithCustomError(
      actionLib,
      "UnconstrainedTaintedArg"
    );
    const ranged = amountCall(
      [
        le(lenRef, CmpOp.GTE, constRef(FieldType.UINT256, 1n)),
        le(lenRef, CmpOp.LTE, constRef(FieldType.UINT256, 32n)),
      ],
      lenRef
    );
    await h.validateActionsTaint([action([ranged])], []);
  });
});

describe("ActionLib.validateActionsTaint — target allowlist operands must be non-tainted", () => {
  let actionLib: any;
  before(async () => {
    actionLib = (await ethers.getContractFactory("ActionLib")).attach(ethers.ZeroAddress);
  });

  const T = id("t");
  function targetCall(right: any[]) {
    return call(fieldRef(FieldType.ADDRESS, T), SEL, [], [le(fieldRef(FieldType.ADDRESS, T), CmpOp.IN, right)]);
  }

  it("rejects IN [CALLER] (tainted allowlist operand)", async () => {
    const h = await freshActionLibHarness();
    await expect(
      h.validateActionsTaint([action([targetCall([synthRef(ValueSource.CALLER, FieldType.ADDRESS)])])], [])
    ).to.be.revertedWithCustomError(actionLib, "UnconstrainedTaintedTarget");
  });

  it("rejects IN [AUTH_SIGNER] (tainted allowlist operand)", async () => {
    const h = await freshActionLibHarness();
    await expect(
      h.validateActionsTaint([action([targetCall([synthRef(ValueSource.AUTH_SIGNER, FieldType.ADDRESS)])])], [])
    ).to.be.revertedWithCustomError(actionLib, "UnconstrainedTaintedTarget");
  });

  it("rejects IN [tainted VAR] (a persisted-field var in the allowlist)", async () => {
    const h = await freshActionLibHarness();
    const V = id("payerVar");
    await expect(
      h.validateActionsTaint([action([targetCall([varRef(FieldType.ADDRESS, V)])])], [V])
    ).to.be.revertedWithCustomError(actionLib, "UnconstrainedTaintedTarget");
  });

  it("accepts IN [CONST addrs] (all non-tainted)", async () => {
    const h = await freshActionLibHarness();
    await h.validateActionsTaint(
      [action([targetCall([constRef(FieldType.ADDRESS, ADDR)])])],
      []
    );
  });
});

describe("ActionLib.validateActionsTaint — all calls/args scanned", () => {
  let actionLib: any;
  before(async () => {
    actionLib = (await ethers.getContractFactory("ActionLib")).attach(ethers.ZeroAddress);
  });

  it("a later call (index > 0) with an unbounded tainted arg is rejected", async () => {
    const h = await freshActionLibHarness();
    const safe = call(constRef(FieldType.ADDRESS, ADDR), SEL, []); // call 0: nothing tainted
    const bad = amountCall([]); // call 1: unbounded FIELD(amount)
    await expect(h.validateActionsTaint([action([safe, bad])], [])).to.be.revertedWithCustomError(
      actionLib,
      "UnconstrainedTaintedArg"
    );
  });
});

describe("ActionLib.validateActionsTaint — an empty IN/NOT_IN set never bounds a tainted component", () => {
  // An empty membership set constrains nothing: `IN []` is vacuously false (reverts every
  // runtime submission) and `NOT_IN []` is vacuously true (no constraint at all). Neither may
  // be credited as a satisfying bound for a tainted, fully attacker-controlled target/arg —
  // otherwise a tainted value passes the init guardrail behind an allowlist that allows nothing
  // (or excludes nothing). The empty set simply does not count, so the existing
  // UnconstrainedTainted* error fires.
  let actionLib: any;
  before(async () => {
    actionLib = (await ethers.getContractFactory("ActionLib")).attach(ethers.ZeroAddress);
  });

  const T = id("t");

  it("rejects a tainted TARGET 'bounded' only by an empty IN [] set", async () => {
    const h = await freshActionLibHarness();
    const c = call(
      fieldRef(FieldType.ADDRESS, T),
      SEL,
      [],
      [le(fieldRef(FieldType.ADDRESS, T), CmpOp.IN, [])]
    );
    await expect(h.validateActionsTaint([action([c])], [])).to.be.revertedWithCustomError(
      actionLib,
      "UnconstrainedTaintedTarget"
    );
  });

  it("rejects a tainted ARG 'bounded' only by an empty IN [] set", async () => {
    const h = await freshActionLibHarness();
    const c = amountCall([le(fieldRef(FieldType.UINT256, F_AMOUNT), CmpOp.IN, [])]);
    await expect(h.validateActionsTaint([action([c])], [])).to.be.revertedWithCustomError(
      actionLib,
      "UnconstrainedTaintedArg"
    );
  });

  it("rejects a tainted ARG 'bounded' only by an empty NOT_IN [] set", async () => {
    const h = await freshActionLibHarness();
    const c = amountCall([le(fieldRef(FieldType.UINT256, F_AMOUNT), CmpOp.NOT_IN, [])]);
    await expect(h.validateActionsTaint([action([c])], [])).to.be.revertedWithCustomError(
      actionLib,
      "UnconstrainedTaintedArg"
    );
  });

  it("regression: a tainted TARGET with a NON-empty IN allowlist over CONST still passes", async () => {
    const h = await freshActionLibHarness();
    const c = call(
      fieldRef(FieldType.ADDRESS, T),
      SEL,
      [],
      [le(fieldRef(FieldType.ADDRESS, T), CmpOp.IN, [constRef(FieldType.ADDRESS, ADDR)])]
    );
    await h.validateActionsTaint([action([c])], []);
  });

  it("regression: a tainted ARG with a NON-empty IN allowlist over CONST still passes", async () => {
    const h = await freshActionLibHarness();
    const c = amountCall([
      le(fieldRef(FieldType.UINT256, F_AMOUNT), CmpOp.IN, [
        constRef(FieldType.UINT256, 1n),
        constRef(FieldType.UINT256, 2n),
      ]),
    ]);
    await h.validateActionsTaint([action([c])], []);
  });
});
