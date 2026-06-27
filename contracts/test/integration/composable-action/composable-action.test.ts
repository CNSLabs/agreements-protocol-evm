/**
 * Composable action engine — live end-to-end (R4 headline).
 *
 * Authors an agreement (via initialize, the new canonical authoring path)
 * with a composable transferFrom action whose `amount` and `to` are FIELD-sourced and
 * `from`/target are CONST/VAR-sourced, bounded by constraints. Drives it with a real
 * submitInput and asserts:
 *   - the ERC-20 balance delta equals the resolved amount, and state advanced;
 *   - an out-of-bounds amount (over an LTE cap) reverts pre-call with no transfer;
 *   - an out-of-bounds recipient (not in an IN allow-set) reverts pre-call;
 *   - the constraint-bounded value is the same value spliced into the calldata
 *     (boundary amount transfers exactly).
 *
 * This extends the purchase-order auto-pay idiom to the composable model: instead of a
 * static (target,value,data) tuple, the amount/recipient are runtime-substituted.
 */

import { expect } from "chai";
import { ethers } from "hardhat";
import type { TestERC20 } from "../../../typechain-types";
import {
  createComposableAgreement,
  composableActionInit,
  verifierReg,
  call,
  dynSlot,
} from "../../helpers/action-lib";
import {
  FieldType,
  CmpOp,
  constRef,
  varRef,
  fieldRef,
  encAddress,
  encUint,
  id,
} from "../../helpers/value-lib";

const erc20 = new ethers.Interface([
  "function transferFrom(address from, address to, uint256 amount) returns (bool)",
]);
const transferFromSel = erc20.getFunction("transferFrom")!.selector;

const coder = ethers.AbiCoder.defaultAbiCoder();

// FSM
const S_START = ethers.id("START");
const S_PAID = ethers.id("PAID");
const INPUT = ethers.id("pay");

// Field / var ids
const F_TO = id("recipient");
const F_AMOUNT = id("amount");
const V_PAYER = id("payerVar"); // the from address (an init var)

// DataField tuple helpers (engine's DataField {id, fType, data}).
function dataField(fieldId: string, fType: number, data: string) {
  return { id: fieldId, fType, data };
}
function encodePayload(fields: { id: string; fType: number; data: string }[]) {
  return coder.encode(
    ["tuple(bytes32 id, uint8 fType, bytes data)[]"],
    [fields]
  );
}

async function deployEngineWithAction(opts: {
  token: string;
  payer: string;
  cap: bigint;
  allowed: string;
}) {
  const actionLib = await ethers.deployContract("ActionLib");
  await actionLib.waitForDeployment();
  const Engine = await ethers.getContractFactory("AgreementEngine", {
    libraries: { ActionLib: await actionLib.getAddress() },
  });
  const impl = await Engine.deploy();
  await impl.waitForDeployment();
  const factory = await ethers.deployContract("AgreementFactory", [await impl.getAddress()]);
  await factory.waitForDeployment();

  // One input `pay` with two FIELD args (recipient, amount), no legacy conditions.
  const inputDefs = [
    [
      INPUT,
      [
        [F_TO, FieldType.ADDRESS, true, false],
        [F_AMOUNT, FieldType.UINT256, true, false],
      ],
      [], // no legacy conditions
      [], // no verifiers
    ],
  ];
  const transitions = [[S_START, S_PAID, INPUT]];
  const initVars = [[V_PAYER, FieldType.ADDRESS, encAddress(opts.payer)]];

  // Composable transferFrom(from=VAR(payer), to=FIELD(recipient), amount=FIELD(amount)),
  // constrained: amount in a two-sided range [0, cap] AND recipient IN {allowed}. R7
  // requires a tainted arg to be fully bounded, so amount carries both a lower (GTE 0)
  // and an upper (LTE cap) bound; a lone one-sided bound would be rejected at init.
  const c = call(
    constRef(FieldType.ADDRESS, opts.token), // target = CONST(token)
    transferFromSel,
    [
      dynSlot(varRef(FieldType.ADDRESS, V_PAYER)),
      dynSlot(fieldRef(FieldType.ADDRESS, F_TO)),
      dynSlot(fieldRef(FieldType.UINT256, F_AMOUNT)),
    ],
    [
      { left: fieldRef(FieldType.UINT256, F_AMOUNT), op: CmpOp.GTE, skipIfAbsent: false, right: [constRef(FieldType.UINT256, 0n)] },
      { left: fieldRef(FieldType.UINT256, F_AMOUNT), op: CmpOp.LTE, skipIfAbsent: false, right: [constRef(FieldType.UINT256, opts.cap)] },
      { left: fieldRef(FieldType.ADDRESS, F_TO), op: CmpOp.IN, skipIfAbsent: false, right: [constRef(FieldType.ADDRESS, opts.allowed)] },
    ]
  );
  const actions = [composableActionInit(S_START, INPUT, [c])];

  // Create a composable-init clone through the factory (the clone is the agreement; the
  // payer approves it, and it is the action's caller). This exercises the new
  // createAgreement -> initialize entry point end to end.
  const tx = await createComposableAgreement(factory, 
    "ipfs://x",
    ethers.ZeroHash,
    S_START,
    inputDefs as any,
    transitions as any,
    initVars as any,
    actions as any,
    [] as any,
    [] as any // no verifiers
  );
  const receipt = await tx.wait();
  const deployedLog = receipt!.logs
    .map((l: any) => {
      try {
        return factory.interface.parseLog(l);
      } catch {
        return null;
      }
    })
    .find((p: any) => p && p.name === "AgreementDeployed");
  const agreementAddress = deployedLog!.args.agreement as string;
  return Engine.attach(agreementAddress) as any;
}

describe("AgreementEngine (integration/composable-action) — live transferFrom", () => {
  // ActionLib's errors (e.g. ConstraintFailed) live in the linked library's ABI, not
  // the engine's. The revertedWithCustomError matcher only needs an interface that
  // DECLARES the error to decode the revert, so we attach a (zero-address) ActionLib
  // handle purely for its ABI.
  let actionLib: any;
  before(async () => {
    const ActionLib = await ethers.getContractFactory("ActionLib");
    actionLib = ActionLib.attach(ethers.ZeroAddress);
  });

  async function fixture(cap: bigint, allowed?: string) {
    const [deployer, payer, payee] = await ethers.getSigners();
    const token = (await ethers.deployContract("TestERC20", ["WorkToken", "WORK"])) as unknown as TestERC20;
    await token.waitForDeployment();
    await (await token.mint(payer.address, 10_000n)).wait();

    const engine = await deployEngineWithAction({
      token: await token.getAddress(),
      payer: payer.address,
      cap,
      allowed: allowed ?? payee.address,
    });

    // payer approves the agreement (the clone) to pull tokens.
    await (await token.connect(payer).approve(await engine.getAddress(), 10_000n)).wait();
    return { engine, token, payer, payee };
  }

  it("happy path: composes transferFrom, balance delta == resolved amount, state advances", async () => {
    const cap = 1_000n;
    const amount = 250n;
    const { engine, token, payee } = await fixture(cap);

    const before = await token.balanceOf(payee.address);
    await (
      await engine.submitInput(
        INPUT,
        encodePayload([
          dataField(F_TO, FieldType.ADDRESS, encAddress(payee.address)),
          dataField(F_AMOUNT, FieldType.UINT256, encUint(amount)),
        ])
      )
    ).wait();

    expect(await engine.currentState()).to.equal(S_PAID);
    expect((await token.balanceOf(payee.address)) - before).to.equal(amount);
  });

  it("boundary amount (== cap) transfers exactly: constrained value == spliced value", async () => {
    const cap = 500n;
    const { engine, token, payee } = await fixture(cap);
    const before = await token.balanceOf(payee.address);
    await (
      await engine.submitInput(
        INPUT,
        encodePayload([
          dataField(F_TO, FieldType.ADDRESS, encAddress(payee.address)),
          dataField(F_AMOUNT, FieldType.UINT256, encUint(cap)),
        ])
      )
    ).wait();
    expect((await token.balanceOf(payee.address)) - before).to.equal(cap);
    expect(await engine.currentState()).to.equal(S_PAID);
  });

  it("amount over cap: reverts pre-call (ConstraintFailed), no transfer, no state advance", async () => {
    const cap = 100n;
    const { engine, token, payee } = await fixture(cap);
    const before = await token.balanceOf(payee.address);
    await expect(
      engine.submitInput(
        INPUT,
        encodePayload([
          dataField(F_TO, FieldType.ADDRESS, encAddress(payee.address)),
          dataField(F_AMOUNT, FieldType.UINT256, encUint(cap + 1n)),
        ])
      )
    ).to.be.revertedWithCustomError(actionLib, "ConstraintFailed");
    expect(await token.balanceOf(payee.address)).to.equal(before);
    expect(await engine.currentState()).to.equal(S_START);
  });

  it("recipient not in allow-set: reverts pre-call (ConstraintFailed), no transfer", async () => {
    const cap = 1_000n;
    const [, , payee] = await ethers.getSigners();
    // allow-set restricted to payee; submit to an attacker recipient.
    const { engine, token } = await fixture(cap, payee.address);
    const attacker = ethers.getAddress("0x000000000000000000000000000000000000dead");
    const before = await token.balanceOf(attacker);
    await expect(
      engine.submitInput(
        INPUT,
        encodePayload([
          dataField(F_TO, FieldType.ADDRESS, encAddress(attacker)),
          dataField(F_AMOUNT, FieldType.UINT256, encUint(10n)),
        ])
      )
    ).to.be.revertedWithCustomError(actionLib, "ConstraintFailed");
    expect(await token.balanceOf(attacker)).to.equal(before);
    expect(await engine.currentState()).to.equal(S_START);
  });
});

describe("AgreementEngine (integration/composable-action) — init validation & safety", () => {
  let actionLib: any;
  let factory: any;
  let Engine: any;

  before(async () => {
    const ActionLibF = await ethers.getContractFactory("ActionLib");
    const lib = await ActionLibF.deploy();
    await lib.waitForDeployment();
    actionLib = ActionLibF.attach(ethers.ZeroAddress); // ABI-only handle for matchers
    Engine = await ethers.getContractFactory("AgreementEngine", {
      libraries: { ActionLib: await lib.getAddress() },
    });
    const impl = await Engine.deploy();
    await impl.waitForDeployment();
    factory = await ethers.deployContract("AgreementFactory", [await impl.getAddress()]);
    await factory.waitForDeployment();
  });

  const inputDefs = [[INPUT, [[F_TO, FieldType.ADDRESS, true, false]], [], []]];
  const transitions = [[S_START, S_PAID, INPUT]];

  function create(calls: any[]) {
    return createComposableAgreement(factory, 
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
  }

  it("rejects a dynamic-type (STRING) substitution slot at init (NonWordArg)", async () => {
    // A dynamic ArgSlot declaring a STRING value is a dynamic-type substitution, which
    // is never legal — rejected at init by ActionLib.validateCall via validateAndAnalyzeActions.
    const bad = call(constRef(FieldType.ADDRESS, ethers.ZeroAddress), transferFromSel, [
      dynSlot(fieldRef(FieldType.STRING, id("note"))),
    ]);
    await expect(create([bad])).to.be.revertedWithCustomError(actionLib, "NonWordArg");
  });

  it("rejects an illegal constraint (ordered op on ADDRESS) at init (IllegalComparison)", async () => {
    const bad = call(
      constRef(FieldType.ADDRESS, ethers.ZeroAddress),
      transferFromSel,
      [dynSlot(fieldRef(FieldType.ADDRESS, F_TO))],
      [
        {
          left: constRef(FieldType.ADDRESS, ethers.ZeroAddress),
          op: CmpOp.GT,
          skipIfAbsent: false,
          right: [constRef(FieldType.ADDRESS, ethers.ZeroAddress)],
        },
      ]
    );
    await expect(create([bad])).to.be.revertedWithCustomError(actionLib, "IllegalComparison");
  });

  it("rejects a resolved self-target at execution (SelfCallRejected)", async () => {
    // Target = SELF resolves to the agreement's own address; the no-self guard rejects it
    // at execution (a transferFrom selector against itself). The FIELD recipient arg is
    // bounded by an IN allowlist so it passes R7's init taint gate — the no-self guard is
    // what we want to exercise at execution, which fires before constraints are asserted.
    const selfAction = call(
      { source: 6 /* SELF */, vType: FieldType.ADDRESS, data: "0x" },
      transferFromSel,
      [dynSlot(fieldRef(FieldType.ADDRESS, F_TO))],
      [
        {
          left: fieldRef(FieldType.ADDRESS, F_TO),
          op: CmpOp.IN,
          skipIfAbsent: false,
          right: [constRef(FieldType.ADDRESS, ethers.ZeroAddress)],
        },
      ]
    );
    const tx = await create([selfAction]);
    const receipt = await tx.wait();
    const deployedLog = receipt!.logs
      .map((l: any) => {
        try {
          return factory.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .find((p: any) => p && p.name === "AgreementDeployed");
    const engine = Engine.attach(deployedLog!.args.agreement as string);

    await expect(
      engine.submitInput(
        INPUT,
        encodePayload([dataField(F_TO, FieldType.ADDRESS, encAddress(ethers.ZeroAddress))])
      )
    ).to.be.revertedWithCustomError(actionLib, "SelfCallRejected");
    expect(await engine.currentState()).to.equal(S_START);
  });
});

// The legacy static-action desugar (and its native-value guard) moved OFF-CHAIN into the SDK:
// the engine has no legacy `ActionInit` init path. The native-value rejection is now covered by
// the SDK desugar test (`sdk/tests/desugar.test.ts` — "rejects a non-zero native value"), where
// `legacyActionToCall` throws when value != 0. The on-chain LegacyActionValueUnsupported guard
// no longer exists, so the former on-chain test for it is retired here (coverage relocated).

// ---------------------------------------------------------------------------
// R8 — owner-less governance: configuration fixed at initialization.
//
//   - Verifiers are registered AT INIT via initialize's `verifiers_` param
//     (the only writer of verifierRegistry); the submitInput hot path runs them.
//   - The init sentinel is OZ's Initializable state (_getInitializedVersion), not
//     `owner`: a never-initialized clone reverts NotInitialized; an initialized one
//     proceeds. `owner` is a powerless identity and is no longer the gate.
//   - There is no post-init configuration surface: the engine exposes no
//     registerVerifier / registerAction owner-mutators.
// ---------------------------------------------------------------------------

describe("AgreementEngine (integration/composable-action) — R8 owner-less governance", () => {
  const V_KEY = ethers.id("VC_TEST");

  async function deployStack() {
    const actionLib = await ethers.deployContract("ActionLib");
    await actionLib.waitForDeployment();
    const Engine = await ethers.getContractFactory("AgreementEngine", {
      libraries: { ActionLib: await actionLib.getAddress() },
    });
    const impl = await Engine.deploy();
    await impl.waitForDeployment();
    const factory = await ethers.deployContract("AgreementFactory", [await impl.getAddress()]);
    await factory.waitForDeployment();
    return { Engine, impl, factory };
  }

  // An input `gate` with one verifier key and a simple START->PAID transition.
  const inputDefs = [[INPUT, [], [], [V_KEY]]];
  const transitions = [[S_START, S_PAID, INPUT]];

  async function createWithVerifiers(factory: any, Engine: any, verifiers: any[]) {
    const tx = await createComposableAgreement(factory, 
      "ipfs://x",
      ethers.ZeroHash,
      S_START,
      inputDefs as any,
      transitions as any,
      [] as any,
      [] as any, // no actions
      [] as any, // no canonical conditions
      verifiers as any
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

  it("init-time verifier (registered via initialize's verifiers_ param) runs on submitInput; a passing verifier proceeds", async () => {
    const { Engine, factory } = await deployStack();
    const v = await ethers.deployContract("MockPassThroughVerifier");
    await v.waitForDeployment();

    const engine = await createWithVerifiers(factory, Engine, [
      verifierReg(V_KEY, await v.getAddress()),
    ]);

    // The verifier was stored AT INIT (no post-init registration).
    expect(await engine.verifierRegistry(V_KEY)).to.equal(await v.getAddress());

    await (await engine.submitInput(INPUT, encodePayload([]))).wait();
    expect(await engine.currentState()).to.equal(S_PAID);
  });

  it("init-time REJECTING verifier reverts the submission (proves the init-registered verifier is actually run on the hot path)", async () => {
    const { Engine, factory } = await deployStack();
    const v = await ethers.deployContract("MockRejectingVerifier");
    await v.waitForDeployment();

    const engine = await createWithVerifiers(factory, Engine, [
      verifierReg(V_KEY, await v.getAddress()),
    ]);

    await expect(engine.submitInput(INPUT, encodePayload([]))).to.be.revertedWithCustomError(
      v,
      "VerifierRejected"
    );
    expect(await engine.currentState()).to.equal(S_START);
  });

  it("rejects a zero verifier address at init", async () => {
    const { Engine, factory } = await deployStack();
    await expect(
      createWithVerifiers(factory, Engine, [verifierReg(V_KEY, ethers.ZeroAddress)])
    ).to.be.revertedWith("zero verifier");
  });

  it("a never-initialized clone reverts NotInitialized on submitInput (OZ init sentinel, not owner)", async () => {
    const { Engine, impl, factory } = await deployStack();
    // Deploy a raw clone of the implementation WITHOUT initializing it (predict + clone via
    // the factory's deterministic path is overkill; clone directly through OZ Clones by
    // calling the factory's clone is internal, so we mirror it: deploy a bare clone using a
    // minimal-proxy of the impl). Simplest reliable route: use the factory to predict and
    // deploy is not available un-initialized, so we deploy a fresh clone via ethers from the
    // EIP-1167 bytecode pointing at impl.
    const implAddr = await impl.getAddress();
    // EIP-1167 minimal-proxy creation code for `implAddr`.
    const cloneInitCode =
      "0x3d602d80600a3d3981f3363d3d373d3d3d363d73" +
      implAddr.slice(2).toLowerCase() +
      "5af43d82803e903d91602b57fd5bf3";
    const [deployer] = await ethers.getSigners();
    const deployTx = await deployer.sendTransaction({ data: cloneInitCode });
    const rcpt = await deployTx.wait();
    const cloneAddr = rcpt!.contractAddress!;
    const clone = Engine.attach(cloneAddr) as any;

    // Owner is still zero (never initialized) AND, more to the point, the OZ init version is 0.
    expect(await clone.owner()).to.equal(ethers.ZeroAddress);
    await expect(clone.submitInput(INPUT, encodePayload([]))).to.be.revertedWithCustomError(
      clone,
      "NotInitialized"
    );

    // Contrast: an initialized clone proceeds PAST the sentinel — it does NOT revert with
    // NotInitialized; here it reverts later on the unknown-input check, proving the sentinel
    // let it through.
    const initialized = await createWithVerifiers(factory, Engine, []);
    await expect(
      initialized.submitInput(ethers.id("nope"), encodePayload([]))
    ).to.be.revertedWith("Unknown inputId");
  });

  it("a never-initialized clone reverts NotInitialized on submitInputWithPermit (permit path has its own sentinel)", async () => {
    const { Engine, impl } = await deployStack();
    const implAddr = await impl.getAddress();
    // Bare EIP-1167 clone of the impl, never initialized (mirrors the submitInput case).
    const cloneInitCode =
      "0x3d602d80600a3d3981f3363d3d373d3d3d363d73" +
      implAddr.slice(2).toLowerCase() +
      "5af43d82803e903d91602b57fd5bf3";
    const [deployer, signer] = await ethers.getSigners();
    const rcpt = await (await deployer.sendTransaction({ data: cloneInitCode })).wait();
    const clone = Engine.attach(rcpt!.contractAddress!) as any;

    // The permit path's sentinel runs FIRST (before the deadline/signature checks), so even
    // garbage permit args revert NotInitialized — proving submitInputWithPermit's duplicated
    // sentinel is wired, guarding against drift from submitInput.
    await expect(
      clone.submitInputWithPermit(
        signer.address,
        INPUT,
        encodePayload([]),
        ethers.MaxUint256,
        27,
        ethers.ZeroHash,
        ethers.ZeroHash
      )
    ).to.be.revertedWithCustomError(clone, "NotInitialized");
  });

  it("exposes no post-init configuration surface (registerVerifier / registerAction are gone)", async () => {
    const { Engine, factory } = await deployStack();
    const engine = await createWithVerifiers(factory, Engine, []);
    // The owner-mutators were removed; the contract interface no longer declares them.
    expect(engine.interface.hasFunction("registerVerifier")).to.equal(false);
    expect(engine.interface.hasFunction("registerAction")).to.equal(false);
  });
});
