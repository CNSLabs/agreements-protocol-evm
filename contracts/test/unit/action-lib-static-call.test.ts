/**
 * R6 — STATIC_CALL as an action component (ActionLib), unit-level.
 *
 *   - executeCall: a dynamic ARG sourced from a STATIC_CALL composes into the calldata
 *     (the bounded read's first canonical word is spliced into the call).
 *   - ABSENT fail mode is meaningful only for a condition's LEFT operand; an ARG must
 *     resolve to a concrete word, so a failing ABSENT-mode STATIC_CALL arg still reverts.
 *   - Taint: a STATIC_CALL result is a DIRECT taint source — an unbounded STATIC_CALL arg
 *     or target is rejected at init; a bounded one (EQ/IN/range or IN allowlist) accepted.
 */

import { expect } from "chai";
import { ethers } from "hardhat";
import { freshActionLibHarness, call, dynSlot, encodeCalls } from "../helpers/action-lib";
import {
  FieldType,
  type FieldTypeVal,
  CmpOp,
  FailMode,
  constRef,
  staticCallRef,
  cond,
} from "../helpers/value-lib";

const sinkIface = new ethers.Interface([
  "function record(uint256 key, uint256 val) returns (uint256)",
]);
const recordSel = sinkIface.getFunction("record")!.selector;

const targetIface = new ethers.Interface([
  "function getUint() returns (uint256)",
  "function boom() returns (uint256)",
]);
const tSel = (n: string) => targetIface.getFunction(n)!.selector;

const coder = ethers.AbiCoder.defaultAbiCoder();

async function deploySink(): Promise<any> {
  const s = await ethers.deployContract("MockSink");
  await s.waitForDeployment();
  return s;
}
async function deployTarget(): Promise<any> {
  const t = await ethers.deployContract("MockStaticTarget");
  await t.waitForDeployment();
  return t;
}

describe("ActionLib.executeCall — STATIC_CALL as a dynamic arg", () => {
  it("splices a STATIC_CALL's first word into the composed calldata", async () => {
    const h = await freshActionLibHarness();
    const sink = await deploySink();
    const target = await deployTarget();
    // record(key=5, val=STATIC_CALL(getUint)==42). The captured 42 must reach the sink.
    const c = call(
      constRef(FieldType.ADDRESS, await sink.getAddress()),
      recordSel,
      [
        dynSlot(constRef(FieldType.UINT256, 5n)),
        dynSlot(
          staticCallRef(FieldType.UINT256, {
            target: await target.getAddress(),
            selector: tSel("getUint"),
          })
        ),
      ]
    );
    await h.executeCall(c, []);
    expect(await sink.recorded(5n)).to.equal(42n);
  });

  it("ABSENT mode does NOT rescue a failing STATIC_CALL arg — it still reverts", async () => {
    const h = await freshActionLibHarness();
    const sink = await deploySink();
    const target = await deployTarget();
    // A reverting ABSENT-mode STATIC_CALL as an ARG: an arg must resolve to a concrete
    // word, so the failed read reverts (StaticCallFailed) regardless of fail mode.
    const c = call(
      constRef(FieldType.ADDRESS, await sink.getAddress()),
      recordSel,
      [
        dynSlot(constRef(FieldType.UINT256, 5n)),
        dynSlot(
          staticCallRef(FieldType.UINT256, {
            target: await target.getAddress(),
            selector: tSel("boom"),
            failMode: FailMode.ABSENT,
          })
        ),
      ]
    );
    await expect(h.executeCall(c, [])).to.be.revertedWithCustomError(h, "StaticCallFailed");
  });
});

// Encode a single-call action's Call[] for validateActionsTaint.
function action(calls: any[]): string {
  return encodeCalls(calls);
}

const ADDR = ethers.getAddress("0x000000000000000000000000000000000000abcd");
const SC_TARGET = ethers.getAddress("0x000000000000000000000000000000000000cafe");
const SEL = "0xaabbccdd";

// A STATIC_CALL ref (UINT256 by default) used as a tainted component in taint tests.
function scRef(vType: FieldTypeVal = FieldType.UINT256) {
  return staticCallRef(vType, { target: SC_TARGET, selector: SEL });
}

describe("ActionLib taint — STATIC_CALL is a direct taint source", () => {
  let actionLib: any;
  before(async () => {
    actionLib = (await ethers.getContractFactory("ActionLib")).attach(ethers.ZeroAddress);
  });

  it("an UNBOUNDED STATIC_CALL dynamic arg is rejected (UnconstrainedTaintedArg)", async () => {
    const h = await freshActionLibHarness();
    const c = call(constRef(FieldType.ADDRESS, ADDR), SEL, [dynSlot(scRef())]);
    await expect(h.validateActionsTaint([action([c])], [])).to.be.revertedWithCustomError(
      actionLib,
      "UnconstrainedTaintedArg"
    );
  });

  it("a STATIC_CALL arg BOUNDED by a two-sided range (on its exact ref) is accepted", async () => {
    const h = await freshActionLibHarness();
    const arg = scRef();
    const c = call(
      constRef(FieldType.ADDRESS, ADDR),
      SEL,
      [dynSlot(arg)],
      [
        cond(arg, CmpOp.LTE, constRef(FieldType.UINT256, 100n)),
        cond(arg, CmpOp.GTE, constRef(FieldType.UINT256, 1n)),
      ]
    );
    await h.validateActionsTaint([action([c])], []);
  });

  it("a STATIC_CALL arg bounded only by a lone GTE is still rejected (one-sided)", async () => {
    const h = await freshActionLibHarness();
    const arg = scRef();
    const c = call(
      constRef(FieldType.ADDRESS, ADDR),
      SEL,
      [dynSlot(arg)],
      [cond(arg, CmpOp.GTE, constRef(FieldType.UINT256, 1n))]
    );
    await expect(h.validateActionsTaint([action([c])], [])).to.be.revertedWithCustomError(
      actionLib,
      "UnconstrainedTaintedArg"
    );
  });

  it("an UNBOUNDED STATIC_CALL target is rejected (UnconstrainedTaintedTarget)", async () => {
    const h = await freshActionLibHarness();
    const c = call(scRef(FieldType.ADDRESS), SEL, []);
    await expect(h.validateActionsTaint([action([c])], [])).to.be.revertedWithCustomError(
      actionLib,
      "UnconstrainedTaintedTarget"
    );
  });

  it("a STATIC_CALL target pinned by an IN allowlist over CONST is accepted", async () => {
    const h = await freshActionLibHarness();
    const tgt = scRef(FieldType.ADDRESS);
    const c = call(tgt, SEL, [], [cond(tgt, CmpOp.IN, [constRef(FieldType.ADDRESS, ADDR)])]);
    await h.validateActionsTaint([action([c])], []);
  });

  it("a constraint bounded AGAINST a STATIC_CALL operand is not a real bound (STATIC_CALL is tainted)", async () => {
    const h = await freshActionLibHarness();
    // arg (a STATIC_CALL) bounded by LTE another STATIC_CALL and GTE CONST: the upper
    // operand is itself tainted, so the upper side is not real -> still one-sided -> reject.
    const arg = scRef();
    const otherSC = staticCallRef(FieldType.UINT256, {
      target: ethers.getAddress("0x000000000000000000000000000000000000d00d"),
      selector: SEL,
    });
    const c = call(
      constRef(FieldType.ADDRESS, ADDR),
      SEL,
      [dynSlot(arg)],
      [
        cond(arg, CmpOp.LTE, otherSC),
        cond(arg, CmpOp.GTE, constRef(FieldType.UINT256, 1n)),
      ]
    );
    await expect(h.validateActionsTaint([action([c])], [])).to.be.revertedWithCustomError(
      actionLib,
      "UnconstrainedTaintedArg"
    );
  });
});
