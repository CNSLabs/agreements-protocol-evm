/**
 * Result-var pattern, end-to-end (R4 follow-up, §3/§4).
 *
 * The headline "branch on an action's result" mechanism:
 *   1. submitInput "evaluate" -> a composable action calls a (mock) evaluator whose
 *      uint256 return is PERSISTed (captured) into a variable `score`.
 *   2. From the post-capture state, a FOLLOW-UP transition branches on `score` through an
 *      ordinary canonical input condition (VAR(score) compared to a CONST threshold):
 *        - score >= threshold -> "accept" advances to HIGH
 *        - score <  threshold -> "reject" advances to LOW
 *      Each follow-up input is gated on the captured var, so only the correct branch is
 *      reachable — the agreement progresses as a function of the action's result, across
 *      two real submitInput calls.
 *
 * This proves capture (commit-after-call) feeds a later transition's gating through the
 * real submitInput path, end to end.
 */

import { expect } from "chai";
import { ethers } from "hardhat";
import {
  createComposableAgreement,
  composableActionInit,
  canonicalConditionInit,
  call,
  dynSlot,
  output,
} from "../../helpers/action-lib";
import { FieldType, CmpOp, constRef, varRef, fieldRef, cond, id } from "../../helpers/value-lib";

const sinkIface = new ethers.Interface([
  "function quoteUint(uint256 x) returns (uint256)",
]);
const quoteUintSel = sinkIface.getFunction("quoteUint")!.selector;

const coder = ethers.AbiCoder.defaultAbiCoder();

// FSM
const S_START = ethers.id("START");
const S_CAPTURED = ethers.id("CAPTURED");
const S_HIGH = ethers.id("HIGH");
const S_LOW = ethers.id("LOW");
const I_EVAL = ethers.id("evaluate");
const I_ACCEPT = ethers.id("accept");
const I_REJECT = ethers.id("reject");

// vars / fields
const V_SCORE = id("score");
const F_X = id("x"); // evaluator input
const THRESHOLD = 50n;

function encodePayload(fields: { id: string; fType: number; data: string }[]) {
  return coder.encode(["tuple(bytes32 id, uint8 fType, bytes data)[]"], [fields]);
}
function df(fieldId: string, fType: number, data: string) {
  return { id: fieldId, fType, data };
}

async function deploy(sink: string) {
  const actionLib = await ethers.deployContract("ActionLib");
  await actionLib.waitForDeployment();
  const Engine = await ethers.getContractFactory("AgreementEngine", {
    libraries: { ActionLib: await actionLib.getAddress() },
  });
  const impl = await Engine.deploy();
  await impl.waitForDeployment();
  const factory = await ethers.deployContract("AgreementFactory", [await impl.getAddress()]);
  await factory.waitForDeployment();

  // Inputs:
  //  - evaluate: carries x (uint), no conditions
  //  - accept:   no fields; canonical condition VAR(score) GTE CONST(threshold)
  //  - reject:   no fields; canonical condition VAR(score) LT  CONST(threshold)
  const inputDefs = [
    [I_EVAL, [[F_X, FieldType.UINT256, true, false]], [], []],
    [I_ACCEPT, [], [], []],
    [I_REJECT, [], [], []],
  ];
  const transitions = [
    [S_START, S_CAPTURED, I_EVAL],
    [S_CAPTURED, S_HIGH, I_ACCEPT],
    [S_CAPTURED, S_LOW, I_REJECT],
  ];

  // Action on evaluate: quoteUint(x) -> capture return word 0 (uint256) into score.
  // x is FIELD-sourced (tainted), so R7 requires it FULLY bounded; a wide two-sided range
  // [0, 1_000_000] is a real (non-tainted) bound and admits every value this test submits.
  // A lone one-sided bound would be rejected at init.
  const xRef = fieldRef(FieldType.UINT256, F_X);
  const evalAction = call(
    constRef(FieldType.ADDRESS, sink),
    quoteUintSel,
    [dynSlot(xRef)],
    [
      cond(xRef, CmpOp.GTE, constRef(FieldType.UINT256, 0n)),
      cond(xRef, CmpOp.LTE, constRef(FieldType.UINT256, 1_000_000n)),
    ],
    [output(0, FieldType.UINT256, V_SCORE)]
  );

  // Canonical follow-up conditions branching on the captured var.
  const acceptCond = {
    left: varRef(FieldType.UINT256, V_SCORE),
    op: CmpOp.GTE,
    skipIfAbsent: false,
    right: [constRef(FieldType.UINT256, THRESHOLD)],
  };
  const rejectCond = {
    left: varRef(FieldType.UINT256, V_SCORE),
    op: CmpOp.LT,
    skipIfAbsent: false,
    right: [constRef(FieldType.UINT256, THRESHOLD)],
  };

  const tx = await createComposableAgreement(factory, 
    "ipfs://x",
    ethers.ZeroHash,
    S_START,
    inputDefs as any,
    transitions as any,
    [] as any,
    [composableActionInit(S_START, I_EVAL, [evalAction])] as any,
    [
      canonicalConditionInit(I_ACCEPT, [acceptCond]),
      canonicalConditionInit(I_REJECT, [rejectCond]),
    ] as any,
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

describe("AgreementEngine (integration/composable-action) — result-var branch", () => {
  async function withSink() {
    const sink = await ethers.deployContract("MockSink");
    await sink.waitForDeployment();
    const engine = await deploy(await sink.getAddress());
    return { engine, sink };
  }

  it("high path: captured score >= threshold -> accept advances to HIGH (reject blocked)", async () => {
    const { engine } = await withSink();
    // quoteUint(x) returns x+1; pick x so score = 60 (>= 50).
    await (await engine.submitInput(I_EVAL, encodePayload([df(F_X, FieldType.UINT256, coder.encode(["uint256"], [59n]))]))).wait();
    expect(await engine.currentState()).to.equal(S_CAPTURED);

    // The captured score must be readable as a var (60).
    const [set, , data] = await engine.getVar(V_SCORE);
    expect(set).to.equal(true);
    expect(coder.decode(["uint256"], data)[0]).to.equal(60n);

    // reject is blocked (its condition VAR(score) < 50 is false).
    await expect(engine.submitInput(I_REJECT, encodePayload([]))).to.be.revertedWithCustomError(
      engine,
      "ComparisonFailed"
    );
    expect(await engine.currentState()).to.equal(S_CAPTURED);

    // accept advances to HIGH.
    await (await engine.submitInput(I_ACCEPT, encodePayload([]))).wait();
    expect(await engine.currentState()).to.equal(S_HIGH);
  });

  it("low path: captured score < threshold -> reject advances to LOW (accept blocked)", async () => {
    const { engine } = await withSink();
    // score = 10 (< 50).
    await (await engine.submitInput(I_EVAL, encodePayload([df(F_X, FieldType.UINT256, coder.encode(["uint256"], [9n]))]))).wait();
    expect(await engine.currentState()).to.equal(S_CAPTURED);

    await expect(engine.submitInput(I_ACCEPT, encodePayload([]))).to.be.revertedWithCustomError(
      engine,
      "ComparisonFailed"
    );
    expect(await engine.currentState()).to.equal(S_CAPTURED);

    await (await engine.submitInput(I_REJECT, encodePayload([]))).wait();
    expect(await engine.currentState()).to.equal(S_LOW);
  });
});
