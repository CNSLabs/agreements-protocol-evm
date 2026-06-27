/**
 * Condition/guard-path STATIC_CALL resolve-once — a STATIC_CALL referenced by TWO conditions
 * evaluated on the SAME submission must be read EXACTLY ONCE, so both conditions compare against
 * the SAME (first-read) word.
 *
 * On the ACTION path ActionLib pre-warms ctx.scCache per call (resolve-once), closing the TOCTOU
 * between the value a constraint CHECKS and the value spliced into the call. On the CONDITION /
 * GUARD path the engine's _validateConditions evaluates every condition for an input against ONE
 * shared EvalContext; before the fix that context's scCache was empty, so a STATIC_CALL used to
 * gate two conditions (e.g. `SC GTE min` AND `SC LTE max`) was read TWICE — and a non-deterministic
 * / single-tx-manipulable target can return DIFFERENT words across the two reads, a within-submit
 * read-inconsistency that can flip which transitions are permitted.
 *
 * The non-determinism primitive is MockStaticTarget.splitOnAccess(): it returns FIRST_VALUE (111)
 * on the FIRST read in a tx and SECOND_VALUE (999) on every later read (observed via EIP-2929
 * cold/warm access cost — no state write, callable under staticcall). With the resolve-once prewarm
 * over the whole condition set, both conditions see 111; without it, the first sees 111 and the
 * second sees 999.
 */

import { expect } from "chai";
import { ethers } from "hardhat";
import {
  FieldType,
  CmpOp,
  constRef,
  staticCallRef,
  cond,
  freshValueLibHarness,
} from "../helpers/value-lib";

const iface = new ethers.Interface([
  "function splitOnAccess() returns (uint256)",
]);
const SEL = (n: string) => iface.getFunction(n)!.selector;

const FIRST_VALUE = 111n; // returned on the FIRST read in a tx
const SECOND_VALUE = 999n; // returned on every later read in the same tx

async function deployTarget(): Promise<any> {
  const t = await ethers.deployContract("MockStaticTarget");
  await t.waitForDeployment();
  return t;
}

describe("ValueLib condition path — a STATIC_CALL shared by two conditions is read once", () => {
  it("both conditions evaluate against the SAME first-read word (resolve-once prewarm)", async () => {
    const h = await freshValueLibHarness();
    const target = await deployTarget();

    // One STATIC_CALL ref used by BOTH conditions. splitOnAccess() returns 111 on the first read
    // and 999 on the second — so the two conditions only agree if the read is shared.
    const sc = staticCallRef(FieldType.UINT256, {
      target: await target.getAddress(),
      selector: SEL("splitOnAccess"),
      gas: 100_000n,
    });

    // A two-sided band [100, 200] gating the SAME static-call value:
    //   c1: SC >= 100   c2: SC <= 200
    // FIRST_VALUE (111) is inside the band; SECOND_VALUE (999) is above it.
    const lo = constRef(FieldType.UINT256, 100n);
    const hi = constRef(FieldType.UINT256, 200n);
    const c1 = cond(sc, CmpOp.GTE, lo);
    const c2 = cond(sc, CmpOp.LTE, hi);

    const [r1, r2] = await h.checkConditionsConsistent([c1, c2], []);

    // With resolve-once both conditions see 111 (in-band): c1 (>=100) true AND c2 (<=200) true.
    // If the second condition had instead re-read 999, c2 (<=200) would be false — divergence.
    expect(r1).to.equal(true);
    expect(r2).to.equal(true);
  });

  it("a strict EQ on the shared STATIC_CALL holds for BOTH conditions (same word, no split)", async () => {
    const h = await freshValueLibHarness();
    const target = await deployTarget();

    const sc = staticCallRef(FieldType.UINT256, {
      target: await target.getAddress(),
      selector: SEL("splitOnAccess"),
      gas: 100_000n,
    });

    // Two independent conditions both asserting SC == FIRST_VALUE. They can only BOTH hold if the
    // read is shared (the second read would yield SECOND_VALUE and break the equality).
    const eqFirst = constRef(FieldType.UINT256, FIRST_VALUE);
    const c1 = cond(sc, CmpOp.EQ, eqFirst);
    const c2 = cond(sc, CmpOp.EQ, eqFirst);

    const [r1, r2] = await h.checkConditionsConsistent([c1, c2], []);
    expect(r1).to.equal(true);
    expect(r2).to.equal(true);
  });

  it("CONTRAST: without the prewarm the SAME two conditions diverge within one submission", async () => {
    // This is the pre-fix behavior — kept as an explicit contrast so the test discriminates on the
    // resolve-once fix and not on something incidental. An EMPTY-cache shared context reads the
    // static call once per condition: c1 sees the first-read 111, c2 sees the second-read 999.
    const h = await freshValueLibHarness();
    const target = await deployTarget();

    const sc = staticCallRef(FieldType.UINT256, {
      target: await target.getAddress(),
      selector: SEL("splitOnAccess"),
      gas: 100_000n,
    });
    // c1: SC == 111 (true on the FIRST read);  c2: SC == 999 (true only on the SECOND read).
    const c1 = cond(sc, CmpOp.EQ, constRef(FieldType.UINT256, FIRST_VALUE));
    const c2 = cond(sc, CmpOp.EQ, constRef(FieldType.UINT256, SECOND_VALUE));

    const [r1, r2] = await h.checkConditionsNoPrewarm([c1, c2], []);

    // The split: without resolve-once, the two conditions saw DIFFERENT words (111 then 999).
    // This is exactly the within-submit read-inconsistency the prewarm closes.
    expect(r1).to.equal(true); // c1 matched the first read (111)
    expect(r2).to.equal(true); // c2 matched the second read (999) — a divergent word
  });
});
