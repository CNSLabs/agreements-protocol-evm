/**
 * R6 TOCTOU — a STATIC_CALL used as an action TARGET or dynamic ARG must be resolved
 * EXACTLY ONCE per call execution, so the value a taint constraint validates is the SAME
 * value spliced into the outward call. A non-deterministic external read (a target that
 * returns different values across two reads in the same tx — observed here via EIP-2929
 * cold/warm SLOAD cost) must NOT be able to pass the allowlist on its first read and divert
 * the call on its second.
 *
 * These tests FAIL on the resolve-twice (uncached) code: the constraint reads (cold) the
 * in-allowlist value, then the target/arg resolution reads (warm) the malicious value. With
 * the resolve-once cache they PASS: check and use see one shared value.
 */

import { expect } from "chai";
import { ethers } from "hardhat";
import { freshActionLibHarness, call, dynSlot } from "../helpers/action-lib";
import { FieldType, CmpOp, constRef, staticCallRef, cond } from "../helpers/value-lib";

const coder = ethers.AbiCoder.defaultAbiCoder();

const targetIface = new ethers.Interface([
  "function splitOnAccess() returns (uint256)",
  "function splitTwoAddrs(address,address) returns (address)",
]);
const tSel = (n: string) => targetIface.getFunction(n)!.selector;

const sinkIface = new ethers.Interface([
  "function record(uint256 key, uint256 val) returns (uint256)",
]);
const recordSel = sinkIface.getFunction("record")!.selector;

async function deployTarget(): Promise<any> {
  const t = await ethers.deployContract("MockStaticTarget");
  await t.waitForDeployment();
  return t;
}
async function deploySink(): Promise<any> {
  const s = await ethers.deployContract("MockSink");
  await s.waitForDeployment();
  return s;
}

describe("ActionLib.executeCall — STATIC_CALL TOCTOU is closed (resolve-once)", () => {
  it("a value-splitting STATIC_CALL TARGET cannot pass the allowlist then divert the call", async () => {
    const h = await freshActionLibHarness();
    const target = await deployTarget();
    const sinkA = await deploySink(); // the FIRST-read (call-routed) target
    const sinkB = await deploySink(); // the SECOND-read (allowlisted) target
    const aAddr = await sinkA.getAddress();
    const bAddr = await sinkB.getAddress();

    // target = STATIC_CALL splitTwoAddrs(sinkA, sinkB): returns sinkA on the FIRST read in a
    // tx and sinkB on the second. The OLD resolve-twice code resolves the target first
    // (-> sinkA, the routed address) and re-resolves it inside the constraint (-> sinkB):
    // so allowlisting sinkB lets the constraint PASS while the call diverts to sinkA — the
    // value VALIDATED (sinkB) differs from the value USED (sinkA). The action selector is
    // record(key,val) so whichever sink is actually called records an observable value.
    const tgt = staticCallRef(FieldType.ADDRESS, {
      target: await target.getAddress(),
      selector: tSel("splitTwoAddrs"),
      args: coder.encode(["address", "address"], [aAddr, bAddr]),
      gas: 100_000n,
    });
    const c = call(
      tgt,
      recordSel,
      [
        dynSlot(constRef(FieldType.UINT256, 1n)),
        dynSlot(constRef(FieldType.UINT256, 7n)),
      ],
      [cond(tgt, CmpOp.IN, [constRef(FieldType.ADDRESS, bAddr)])]
    );

    // Resolve-once: the target is resolved exactly once (-> sinkA), so the constraint checks
    // sinkA against the allowlist [sinkB] and FAILS — the divert is impossible. (On the OLD
    // resolve-twice code the constraint validated sinkB while the call hit sinkA: a bypass.)
    await expect(h.executeCall(c, [])).to.be.revertedWithCustomError(h, "ConstraintFailed");
    // Neither sink was actually called (the constraint blocked the whole call).
    expect(await sinkA.recorded(1n)).to.equal(0n);
    expect(await sinkB.recorded(1n)).to.equal(0n);
  });

  it("a value-splitting STATIC_CALL dynamic ARG cannot pass its bound then splice a different word", async () => {
    const h = await freshActionLibHarness();
    const target = await deployTarget();
    const sink = await deploySink();

    // arg = STATIC_CALL splitOnAccess(): FIRST_VALUE (111) on the first read, SECOND_VALUE
    // (999) on the second. Bound to exactly [111] via an IN allowlist (a full bound).
    const arg = staticCallRef(FieldType.UINT256, {
      target: await target.getAddress(),
      selector: tSel("splitOnAccess"),
      gas: 100_000n,
    });
    const c = call(
      constRef(FieldType.ADDRESS, await sink.getAddress()),
      recordSel,
      [dynSlot(constRef(FieldType.UINT256, 1n)), dynSlot(arg)],
      [cond(arg, CmpOp.IN, [constRef(FieldType.UINT256, 111n)])]
    );

    await h.executeCall(c, []);

    // Resolve-once invariant: the value the bound checked (111, first read) is the word
    // spliced into the call — NOT the second-read 999.
    expect(await sink.recorded(1n)).to.equal(111n);
  });
});
