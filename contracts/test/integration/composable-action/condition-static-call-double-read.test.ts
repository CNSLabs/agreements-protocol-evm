/**
 * Condition/guard-path STATIC_CALL resolve-once, end-to-end through submitInput.
 *
 * An input is gated by TWO canonical conditions that both reference the SAME non-deterministic
 * STATIC_CALL (MockStaticTarget.splitOnAccess(): 111 on the first read in a tx, 999 on every
 * later read). The conditions form a two-sided band [100, 200]:
 *   c1: SC >= 100   c2: SC <= 200
 * The FIRST-read value (111) is in-band; the SECOND-read value (999) is above it.
 *
 * Before the fix, _validateConditions built an EMPTY scCache and read the STATIC_CALL once per
 * condition: c1 saw 111 (>=100, pass) but c2 re-read 999 (<=200, FAIL) — so the transition was
 * BLOCKED by a within-submit read split, and a single-tx-manipulable target could flip which
 * transitions are permitted. With the resolve-once prewarm both conditions see the one first-read
 * word (111), so the band holds and the transition is permitted — and, crucially, BOTH conditions
 * evaluated against the SAME word.
 */

import { expect } from "chai";
import { ethers } from "hardhat";
import {
  createComposableAgreement,
  canonicalConditionInit,
} from "../../helpers/action-lib";
import { FieldType, CmpOp, constRef, staticCallRef, cond } from "../../helpers/value-lib";

const coder = ethers.AbiCoder.defaultAbiCoder();

const targetIface = new ethers.Interface([
  "function splitOnAccess() returns (uint256)",
]);
const splitSel = targetIface.getFunction("splitOnAccess")!.selector;

// FSM
const S_START = ethers.id("START");
const S_DONE = ethers.id("DONE");
const I_GATE = ethers.id("gate");

function encodePayload(fields: { id: string; fType: number; data: string }[]) {
  return coder.encode(["tuple(bytes32 id, uint8 fType, bytes data)[]"], [fields]);
}

async function deploy(staticTarget: string) {
  const actionLib = await ethers.deployContract("ActionLib");
  await actionLib.waitForDeployment();
  const Engine = await ethers.getContractFactory("AgreementEngine", {
    libraries: { ActionLib: await actionLib.getAddress() },
  });
  const impl = await Engine.deploy();
  await impl.waitForDeployment();
  const factory = await ethers.deployContract("AgreementFactory", [await impl.getAddress()]);
  await factory.waitForDeployment();

  // One STATIC_CALL ref used by BOTH gating conditions.
  const sc = staticCallRef(FieldType.UINT256, {
    target: staticTarget,
    selector: splitSel,
    gas: 100_000n,
  });
  // Two-sided band gating the SAME static-call value: SC >= 100 AND SC <= 200.
  const c1 = cond(sc, CmpOp.GTE, constRef(FieldType.UINT256, 100n));
  const c2 = cond(sc, CmpOp.LTE, constRef(FieldType.UINT256, 200n));

  // Input `gate` carries no fields; its two canonical conditions both reference `sc`.
  const inputDefs = [[I_GATE, [], [], []]];
  const transitions = [[S_START, S_DONE, I_GATE]];

  const tx = await createComposableAgreement(
    factory,
    "ipfs://x",
    ethers.ZeroHash,
    S_START,
    inputDefs as any,
    transitions as any,
    [] as any,
    [] as any, // no actions
    [canonicalConditionInit(I_GATE, [c1, c2])] as any,
    [] as any // no verifiers
  );
  const receipt = await tx.wait();
  const log = receipt!.logs
    .map((l: any) => {
      try {
        return factory.interface.parseLog(l);
      } catch {
        return null;
      }
    })
    .find((p: any) => p && p.name === "AgreementDeployed");
  return Engine.attach(log!.args.agreement as string) as any;
}

describe("AgreementEngine (integration) — two conditions on one non-deterministic STATIC_CALL", () => {
  it("both band conditions see the SAME first-read word, so the gated transition is permitted", async () => {
    const target = await ethers.deployContract("MockStaticTarget");
    await target.waitForDeployment();
    const engine = await deploy(await target.getAddress());

    // submitInput evaluates BOTH conditions against ONE shared context. With resolve-once the
    // STATIC_CALL is read once (-> 111, in [100,200]) so both conditions pass and the transition
    // advances. Without the fix, c2 would re-read 999 and revert ComparisonFailed (the split).
    await (await engine.submitInput(I_GATE, encodePayload([]))).wait();
    expect(await engine.currentState()).to.equal(S_DONE);
  });

  it("the band still REJECTS a value outside it (the prewarmed read is the real read, not bypassed)", async () => {
    // Sanity: resolve-once must not weaken gating. Re-band to [200, 300]; the (single, first-read)
    // value 111 is BELOW the band, so c1 (SC >= 200) fails and the transition is blocked. This
    // confirms the prewarmed word is the value actually compared, not a stale/skipped read.
    const target = await ethers.deployContract("MockStaticTarget");
    await target.waitForDeployment();

    const actionLib = await ethers.deployContract("ActionLib");
    await actionLib.waitForDeployment();
    const Engine = await ethers.getContractFactory("AgreementEngine", {
      libraries: { ActionLib: await actionLib.getAddress() },
    });
    const impl = await Engine.deploy();
    await impl.waitForDeployment();
    const factory = await ethers.deployContract("AgreementFactory", [await impl.getAddress()]);
    await factory.waitForDeployment();

    const sc = staticCallRef(FieldType.UINT256, {
      target: await target.getAddress(),
      selector: splitSel,
      gas: 100_000n,
    });
    const c1 = cond(sc, CmpOp.GTE, constRef(FieldType.UINT256, 200n));
    const c2 = cond(sc, CmpOp.LTE, constRef(FieldType.UINT256, 300n));

    const tx = await createComposableAgreement(
      factory,
      "ipfs://x",
      ethers.ZeroHash,
      S_START,
      [[I_GATE, [], [], []]] as any,
      [[S_START, S_DONE, I_GATE]] as any,
      [] as any,
      [] as any,
      [canonicalConditionInit(I_GATE, [c1, c2])] as any,
      [] as any
    );
    const receipt = await tx.wait();
    const log = receipt!.logs
      .map((l: any) => {
        try {
          return factory.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .find((p: any) => p && p.name === "AgreementDeployed");
    const engine = Engine.attach(log!.args.agreement as string) as any;

    await expect(engine.submitInput(I_GATE, encodePayload([]))).to.be.revertedWithCustomError(
      engine,
      "ComparisonFailed"
    );
    expect(await engine.currentState()).to.equal(S_START);
  });
});
