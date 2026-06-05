/**
 * Composable action — delegatecall semantics through a REAL linked clone.
 *
 * ActionLib is a linked external library: the agreement clone delegatecalls the engine
 * impl, which delegatecalls ActionLib, whose `target.call(...)` must run in the CLONE's
 * context (msg.sender to the target == the clone; address(this) == the clone). This pins:
 *   - a target recording msg.sender sees the clone (not the library/impl);
 *   - SELF substitution resolves to the clone address;
 *   - CALLER / AUTH_SIGNER substitutions resolve to the submitter (msg.sender), proven by
 *     capturing the value the target echoes back.
 */

import { expect } from "chai";
import { ethers } from "hardhat";
import { createComposableAgreement, composableActionInit, call, dynSlot, output } from "../../helpers/action-lib";
import { FieldType, ValueSource, CmpOp, constRef, synthRef, id } from "../../helpers/value-lib";

const sinkIface = new ethers.Interface([
  "function recordCaller() returns (address)",
  "function quoteAddress(address a) returns (address)",
]);
const recordCallerSel = sinkIface.getFunction("recordCaller")!.selector;
const quoteAddressSel = sinkIface.getFunction("quoteAddress")!.selector;

const coder = ethers.AbiCoder.defaultAbiCoder();
const S_START = ethers.id("START");
const S_DONE = ethers.id("DONE");
const INPUT = ethers.id("go");

function encodePayload(fields: { id: string; fType: number; data: string }[]) {
  return coder.encode(["tuple(bytes32 id, uint8 fType, bytes data)[]"], [fields]);
}

async function deployCloneWithAction(calls: any[]) {
  const actionLib = await ethers.deployContract("ActionLib");
  await actionLib.waitForDeployment();
  const Engine = await ethers.getContractFactory("AgreementEngine", {
    libraries: { ActionLib: await actionLib.getAddress() },
  });
  const impl = await Engine.deploy();
  await impl.waitForDeployment();
  const factory = await ethers.deployContract("AgreementFactory", [await impl.getAddress()]);
  await factory.waitForDeployment();

  const inputDefs = [[INPUT, [], [], []]];
  const transitions = [[S_START, S_DONE, INPUT]];
  const tx = await createComposableAgreement(factory, 
    "ipfs://x",
    ethers.ZeroHash,
    S_START,
    inputDefs as any,
    transitions as any,
    [] as any,
    [composableActionInit(S_START, INPUT, calls)] as any,
    [] as any,
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
  return { Engine, agreement: log!.args.agreement as string };
}

describe("AgreementEngine (integration/composable-action) — delegatecall semantics", () => {
  let sink: any;
  before(async () => {
    sink = await ethers.deployContract("MockSink");
    await sink.waitForDeployment();
  });

  it("the target sees msg.sender == the agreement clone (call runs in clone context)", async () => {
    const c = call(constRef(FieldType.ADDRESS, await sink.getAddress()), recordCallerSel, []);
    const { Engine, agreement } = await deployCloneWithAction([c]);
    const engine = Engine.attach(agreement) as any;
    await (await engine.submitInput(INPUT, encodePayload([]))).wait();
    expect(await sink.lastCaller()).to.equal(agreement);
  });

  it("SELF substitution resolves to the clone address (echoed back + captured)", async () => {
    const V = id("selfEcho");
    // quoteAddress(SELF) echoes SELF; capture it and assert it equals the clone.
    const c = call(
      constRef(FieldType.ADDRESS, await sink.getAddress()),
      quoteAddressSel,
      [dynSlot(synthRef(ValueSource.SELF, FieldType.ADDRESS))],
      [],
      [output(0, FieldType.ADDRESS, V)]
    );
    const { Engine, agreement } = await deployCloneWithAction([c]);
    const engine = Engine.attach(agreement) as any;
    await (await engine.submitInput(INPUT, encodePayload([]))).wait();
    const [, , data] = await engine.getVar(V);
    expect(coder.decode(["address"], data)[0]).to.equal(agreement);
  });

  it("CALLER / AUTH_SIGNER substitution resolves to the submitter (echoed back + captured)", async () => {
    const [submitter] = await ethers.getSigners();
    const VC = id("callerEcho");
    const VA = id("signerEcho");
    const sinkAddr = await sink.getAddress();
    // CALLER and AUTH_SIGNER are direct taint sources, so each arg must be bounded for
    // R7's init taint gate. The submitter is known at authoring time, so an IN allowlist
    // pinned to it is a real (non-tainted, CONST) bound — and it passes at runtime because
    // the resolved value equals the submitter (which is exactly what this test proves).
    const callerCall = call(
      constRef(FieldType.ADDRESS, sinkAddr),
      quoteAddressSel,
      [dynSlot(synthRef(ValueSource.CALLER, FieldType.ADDRESS))],
      [
        {
          left: synthRef(ValueSource.CALLER, FieldType.ADDRESS),
          op: CmpOp.IN,
          skipIfAbsent: false,
          right: [constRef(FieldType.ADDRESS, submitter.address)],
        },
      ],
      [output(0, FieldType.ADDRESS, VC)]
    );
    const signerCall = call(
      constRef(FieldType.ADDRESS, sinkAddr),
      quoteAddressSel,
      [dynSlot(synthRef(ValueSource.AUTH_SIGNER, FieldType.ADDRESS))],
      [
        {
          left: synthRef(ValueSource.AUTH_SIGNER, FieldType.ADDRESS),
          op: CmpOp.IN,
          skipIfAbsent: false,
          right: [constRef(FieldType.ADDRESS, submitter.address)],
        },
      ],
      [output(0, FieldType.ADDRESS, VA)]
    );
    const { Engine, agreement } = await deployCloneWithAction([callerCall, signerCall]);
    const engine = Engine.attach(agreement) as any;
    // Direct submitInput: both CALLER and AUTH_SIGNER are msg.sender (the submitter).
    await (await engine.connect(submitter).submitInput(INPUT, encodePayload([]))).wait();
    expect(coder.decode(["address"], (await engine.getVar(VC))[2])[0]).to.equal(submitter.address);
    expect(coder.decode(["address"], (await engine.getVar(VA))[2])[0]).to.equal(submitter.address);
  });
});
