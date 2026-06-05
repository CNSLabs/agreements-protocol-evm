/**
 * R5 — actions-last CEI + reentrancy safety (adversarial PROVE-AND-HARDEN spike).
 *
 * The pipeline orders: structural checks -> persist vars -> condition checks -> verifiers ->
 * transition selection -> currentState = to -> action execution -> emit. Action execution
 * runs the outward calls LAST (after effects commit) and commits captured outputs only after
 * every call succeeds, under the caller's nonReentrant guard.
 *
 * These tests try to BREAK that, with real mocks (no mocks-for-the-engine):
 *   1. CEI ordering: an action target reads the engine back mid-call and must observe the
 *      COMMITTED post-transition state (currentState == toState; persisted field written).
 *   2. Reentrancy blocked: an action target re-entering submitInput / submitInputWithPermit
 *      reverts (OZ ReentrancyGuardReentrantCall); a verifier re-entering reverts too.
 *   3. Atomic action + post-call output commit: a multi-call action whose LATER call reverts
 *      rolls the WHOLE transition back (state unchanged, persisted writes rolled back, no
 *      output committed); on full success the captured output is committed (the single
 *      post-interaction write).
 *   4. Verifier interaction safety: verifiers are invoked through `IInputVerifier.verify`,
 *      which is `view`, so the compiler lowers the call to STATICCALL. A verifier attempting
 *      to mutate engine state reverts; we isolate the cause with two distinct probes on ONE
 *      non-view mock verify():
 *        - SELF_WRITE (a direct sstore): blocked by the STATICCALL CONTEXT (dataless revert);
 *          proven by a control that calls the SAME contract+selector via a non-view interface
 *          (a plain CALL) where the identical sstore SUCCEEDS.
 *        - RE-ENTER submitInput: blocked by the OZ REENTRANCY GUARD, because verifiers run
 *          inside the outer (nonReentrant) submitInput, so the nested call's `_status==ENTERED`
 *          check fires (and REVERTs with data) BEFORE any sstore — the staticcall context never
 *          has to reject a state write. (Note: this corrects an earlier assumption that the
 *          staticcall context was the blocker for the re-entry case.)
 *   5. No unguarded mutating reentry during an action: submitInput / submitInputWithPermit
 *      are nonReentrant (proven in 2). Under owner-less governance (R8) there are NO other
 *      mutating entrypoints — the post-init registerVerifier / registerAction owner-mutators
 *      were removed, so there is no owner-mutator-reentry surface left to harden against.
 */

import { expect } from "chai";
import { ethers } from "hardhat";
import {
  createComposableAgreement,
  composableActionInit,
  canonicalConditionInit,
  verifierReg,
  call,
  dynSlot,
  output,
} from "../../helpers/action-lib";
import { FieldType, CmpOp, constRef, fieldRef, cond, id } from "../../helpers/value-lib";

const coder = ethers.AbiCoder.defaultAbiCoder();

// observeState(uint256) / reenterSubmitInput(uint256) / reenterSubmitInputWithPermit(uint256)
const targetIface = new ethers.Interface([
  "function observeState(uint256 unused) returns (uint256)",
  "function reenterSubmitInput(uint256 unused) returns (uint256)",
  "function reenterSubmitInputWithPermit(uint256 unused) returns (uint256)",
]);
const observeSel = targetIface.getFunction("observeState")!.selector;
const reenterSubmitSel = targetIface.getFunction("reenterSubmitInput")!.selector;
const reenterPermitSel = targetIface.getFunction("reenterSubmitInputWithPermit")!.selector;

const sinkIface = new ethers.Interface([
  "function quoteUint(uint256 x) returns (uint256)",
  "function record(uint256 key, uint256 val) returns (uint256)",
  "function boom()",
]);
const quoteUintSel = sinkIface.getFunction("quoteUint")!.selector;
const recordSel = sinkIface.getFunction("record")!.selector;
const boomSel = sinkIface.getFunction("boom")!.selector;

// FSM
const S_START = ethers.id("START");
const S_DONE = ethers.id("DONE");
const I_GO = ethers.id("go");

// fields / vars
const F_AMOUNT = id("amount");
const V_CAPTURED = id("captured");
const V_OBSERVED_VIA_OUTPUT = id("observedOut");
const CAP = 1_000_000n;

function encodePayload(fields: { id: string; fType: number; data: string }[]) {
  return coder.encode(["tuple(bytes32 id, uint8 fType, bytes data)[]"], [fields]);
}
function df(fieldId: string, fType: number, data: string) {
  return { id: fieldId, fType, data };
}
function uintWord(v: bigint) {
  return coder.encode(["uint256"], [v]);
}

// A two-sided bound on a tainted FIELD arg (R7 requires it).
function boundedAmount() {
  const ref = fieldRef(FieldType.UINT256, F_AMOUNT);
  return [
    cond(ref, CmpOp.GTE, constRef(FieldType.UINT256, 0n)),
    cond(ref, CmpOp.LTE, constRef(FieldType.UINT256, CAP)),
  ];
}

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
  // ABI-only handle for ActionLib custom-error matchers.
  const actionLibAbi = (await ethers.getContractFactory("ActionLib")).attach(ethers.ZeroAddress);
  return { Engine, factory, actionLibAbi };
}

// OZ ReentrancyGuard error selector — the engine wraps the inner re-entry revert in
// ActionLib.CallReverted(target, revertData), so the reentrancy error is the EMBEDDED data.
const reentrancyIface = new ethers.Interface(["error ReentrancyGuardReentrantCall()"]);
const REENTRANCY_SELECTOR = reentrancyIface.getError("ReentrancyGuardReentrantCall")!.selector;

/**
 * Assert `promise` reverts with ActionLib.CallReverted whose embedded revertData is the OZ
 * ReentrancyGuardReentrantCall selector. The action call wraps the target's revert, so the
 * reentrancy guard's revert is nested one level deep.
 */
async function expectReentrancyWrapped(promise: Promise<any>, actionLibAbi: any) {
  const raw = await expectRevertData(promise);
  const parsed = actionLibAbi.interface.parseError(raw);
  expect(parsed?.name, "top-level error must be ActionLib.CallReverted").to.equal("CallReverted");
  const inner: string = parsed!.args.revertData;
  expect(inner.toLowerCase().startsWith(REENTRANCY_SELECTOR.toLowerCase()), "inner revert must be ReentrancyGuardReentrantCall").to.equal(true);
}

/** Coerce an ethers revert-data field (which may be a hex string or a nested error object) to a
 *  hex string, or undefined. */
function asHex(v: any): string | undefined {
  if (typeof v === "string" && v.startsWith("0x")) return v;
  // ethers v6 sometimes nests the revert under e.data = { data, reason, ... }.
  if (v && typeof v === "object") {
    if (typeof v.data === "string" && v.data.startsWith("0x")) return v.data;
    if (v.reason && typeof v.reason.Revert === "string") return v.reason.Revert;
  }
  return undefined;
}

/** Run `promise`, expect it to revert, and return the raw revert data hex (best-effort). */
async function expectRevertData(promise: Promise<any>): Promise<string> {
  let raw: string | undefined;
  try {
    await promise;
    throw new Error("expected revert, got success");
  } catch (e: any) {
    raw = asHex(e?.data) ?? asHex(e?.error?.data) ?? asHex(e?.info?.error?.data);
    if (!raw && typeof e?.message === "string") {
      const m = e.message.match(/0x[0-9a-fA-F]+/);
      if (m) raw = m[0];
    }
  }
  if (!raw) throw new Error("could not extract revert data");
  return raw;
}

async function agreementFrom(factory: any, Engine: any, tx: any) {
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

/**
 * Produce a valid EIP-712 permit signature over PermitInput(inputId, payload, nonce, deadline)
 * for submitInputWithPermit. Mirrors the engine's EIP712("AgreementEngine", "1") domain and the
 * PERMIT_TYPEHASH struct; same pattern as the parity harness's signPermit.
 */
async function signPermit(
  engine: any,
  engineAddress: string,
  signer: any,
  inputId: string,
  payload: string,
  deadline: bigint
): Promise<{ v: number; r: string; s: string }> {
  const nonce = await engine.nonces(signer.address);
  const { chainId } = await ethers.provider.getNetwork();
  const domain = {
    name: "AgreementEngine",
    version: "1",
    chainId,
    verifyingContract: engineAddress,
  };
  const types = {
    PermitInput: [
      { name: "inputId", type: "bytes32" },
      { name: "payload", type: "bytes" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  };
  const sig = await signer.signTypedData(domain, types, { inputId, payload, nonce, deadline });
  const split = ethers.Signature.from(sig);
  return { v: split.v, r: split.r, s: split.s };
}

// ---------------------------------------------------------------------------
// Invariant 1 — CEI ordering: effects before interactions.
// ---------------------------------------------------------------------------

describe("R5 CEI — effects committed before the action interaction", () => {
  it("action target observes the COMMITTED post-transition state (currentState == toState, persisted field written)", async () => {
    const { Engine, factory } = await deployStack();
    const target = await ethers.deployContract("MockReentrantTarget");
    await target.waitForDeployment();
    // The target reads back vars[amount] (the persisted field) during the action.
    await (await target.setProbeVar(F_AMOUNT)).wait();

    // Input `go` with a persisted `amount`; action calls observeState(amount), bounded.
    const inputDefs = [[I_GO, [[F_AMOUNT, FieldType.UINT256, true, true /* persist */]], [], []]];
    const transitions = [[S_START, S_DONE, I_GO]];
    const c = call(
      constRef(FieldType.ADDRESS, await target.getAddress()),
      observeSel,
      [dynSlot(fieldRef(FieldType.UINT256, F_AMOUNT))],
      boundedAmount()
    );
    const engine = await agreementFrom(
      factory,
      Engine,
      await createComposableAgreement(factory, 
        "ipfs://x",
        ethers.ZeroHash,
        S_START,
        inputDefs as any,
        transitions as any,
        [] as any,
        [composableActionInit(S_START, I_GO, [c])] as any,
        [] as any,
        [] as any // no verifiers
      )
    );

    const amount = 4242n;
    await (await engine.submitInput(I_GO, encodePayload([df(F_AMOUNT, FieldType.UINT256, uintWord(amount))]))).wait();

    // Engine ended in the post-transition state.
    expect(await engine.currentState()).to.equal(S_DONE);

    // What the target observed MID-ACTION: the committed post-transition state, not the pre.
    expect(await target.observed()).to.equal(true);
    expect(await target.observedState()).to.equal(S_DONE); // effects-before-interactions
    expect(await target.observedVarSet()).to.equal(true);
    expect(coder.decode(["uint256"], await target.observedVarData())[0]).to.equal(amount);
  });
});

// ---------------------------------------------------------------------------
// Invariant 2 / 5 — reentrancy blocked from an action target.
// ---------------------------------------------------------------------------

describe("R5 reentrancy — an action target re-entering a mutator reverts", () => {
  async function buildReenterAgreement(selector: string) {
    const { Engine, factory, actionLibAbi } = await deployStack();
    const target = await ethers.deployContract("MockReentrantTarget");
    await target.waitForDeployment();
    const inputDefs = [[I_GO, [[F_AMOUNT, FieldType.UINT256, true, true]], [], []]];
    const transitions = [[S_START, S_DONE, I_GO]];
    const c = call(
      constRef(FieldType.ADDRESS, await target.getAddress()),
      selector,
      [dynSlot(fieldRef(FieldType.UINT256, F_AMOUNT))],
      boundedAmount()
    );
    const engine = await agreementFrom(
      factory,
      Engine,
      await createComposableAgreement(factory, 
        "ipfs://x",
        ethers.ZeroHash,
        S_START,
        inputDefs as any,
        transitions as any,
        [] as any,
        [composableActionInit(S_START, I_GO, [c])] as any,
        [] as any,
        [] as any // no verifiers
      )
    );
    return { engine, target, actionLibAbi };
  }

  it("re-entry into submitInput reverts (OZ ReentrancyGuardReentrantCall, wrapped); state unchanged", async () => {
    const { engine, target, actionLibAbi } = await buildReenterAgreement(reenterSubmitSel);
    // The target, when called, re-enters submitInput(go, payload).
    const payload = encodePayload([df(F_AMOUNT, FieldType.UINT256, uintWord(1n))]);
    await (await target.setReenterSubmit(I_GO, payload)).wait();

    // The re-entry is fatal to the action -> wrapped in ActionLib.CallReverted; the embedded
    // revert is the reentrancy guard's ReentrancyGuardReentrantCall.
    await expectReentrancyWrapped(
      engine.submitInput.staticCall(I_GO, encodePayload([df(F_AMOUNT, FieldType.UINT256, uintWord(10n))])),
      actionLibAbi
    );
    // And the real (non-static) submission also reverts (state never advances).
    await expect(
      engine.submitInput(I_GO, encodePayload([df(F_AMOUNT, FieldType.UINT256, uintWord(10n))]))
    ).to.be.reverted;
    expect(await engine.currentState()).to.equal(S_START);
  });

  it("re-entry into submitInputWithPermit reverts (OZ ReentrancyGuardReentrantCall, wrapped); state unchanged", async () => {
    const { engine, target, actionLibAbi } = await buildReenterAgreement(reenterPermitSel);
    const [signer] = await ethers.getSigners();
    const payload = encodePayload([df(F_AMOUNT, FieldType.UINT256, uintWord(1n))]);
    // The signature does not need to be valid: the nonReentrant guard fires BEFORE signature
    // recovery (it is the modifier, the outermost gate), so the re-entry reverts with the
    // reentrancy error regardless of the (here-garbage) v/r/s.
    await (
      await target.setReenterPermit(
        I_GO,
        payload,
        signer.address,
        ethers.MaxUint256, // far-future deadline (so we test the guard, not the deadline)
        27,
        ethers.ZeroHash,
        ethers.ZeroHash
      )
    ).wait();

    await expectReentrancyWrapped(
      engine.submitInput.staticCall(I_GO, encodePayload([df(F_AMOUNT, FieldType.UINT256, uintWord(10n))])),
      actionLibAbi
    );
    await expect(
      engine.submitInput(I_GO, encodePayload([df(F_AMOUNT, FieldType.UINT256, uintWord(10n))]))
    ).to.be.reverted;
    expect(await engine.currentState()).to.equal(S_START);
  });
});

// ---------------------------------------------------------------------------
// Invariant 3 — atomic multi-call action + post-call (commit-after-all) output capture.
// ---------------------------------------------------------------------------

describe("R5 atomicity — multi-call action rollback + post-call output commit", () => {
  // An action of two calls: call 0 records a value (observable effect + a UINT return that
  // would be captured into V_CAPTURED), call 1 either succeeds (quoteUint, captured into
  // V_OBSERVED_VIA_OUTPUT) or reverts (boom). On a later-call revert the WHOLE transition
  // must roll back: state unchanged, no captured output committed, no recorded effect.
  async function buildMultiCall(sink: string, secondCallReverts: boolean) {
    const { Engine, factory, actionLibAbi } = await deployStack();
    const inputDefs = [[I_GO, [[F_AMOUNT, FieldType.UINT256, true, true]], [], []]];
    const transitions = [[S_START, S_DONE, I_GO]];

    const amtRef = fieldRef(FieldType.UINT256, F_AMOUNT);
    // call 0: record(amount, amount) -> capture return word 0 (uint) into V_CAPTURED.
    const call0 = call(
      constRef(FieldType.ADDRESS, sink),
      recordSel,
      [dynSlot(amtRef), dynSlot(amtRef)],
      boundedAmount(),
      [output(0, FieldType.UINT256, V_CAPTURED)]
    );
    // call 1: either quoteUint(amount) -> capture into V_OBSERVED_VIA_OUTPUT, or boom() (reverts).
    const call1 = secondCallReverts
      ? call(constRef(FieldType.ADDRESS, sink), boomSel, [])
      : call(
          constRef(FieldType.ADDRESS, sink),
          quoteUintSel,
          [dynSlot(amtRef)],
          boundedAmount(),
          [output(0, FieldType.UINT256, V_OBSERVED_VIA_OUTPUT)]
        );

    const engine = await agreementFrom(
      factory,
      Engine,
      await createComposableAgreement(factory, 
        "ipfs://x",
        ethers.ZeroHash,
        S_START,
        inputDefs as any,
        transitions as any,
        [] as any,
        [composableActionInit(S_START, I_GO, [call0, call1])] as any,
        [] as any,
        [] as any // no verifiers
      )
    );
    return { engine, actionLibAbi };
  }

  it("LATER call reverts -> whole transition rolls back (state unchanged, no output committed, no effect)", async () => {
    const sink = await ethers.deployContract("MockSink");
    await sink.waitForDeployment();
    const { engine, actionLibAbi } = await buildMultiCall(await sink.getAddress(), true);

    const amount = 77n;
    await expect(
      engine.submitInput(I_GO, encodePayload([df(F_AMOUNT, FieldType.UINT256, uintWord(amount))]))
    ).to.be.revertedWithCustomError(actionLibAbi, "CallReverted");

    // State unchanged.
    expect(await engine.currentState()).to.equal(S_START);
    // The first call's captured output was staged in an in-memory overlay; since the tx
    // reverted, nothing was committed.
    expect((await engine.getVar(V_CAPTURED))[0]).to.equal(false);
    expect((await engine.getVar(V_OBSERVED_VIA_OUTPUT))[0]).to.equal(false);
    // The persisted field write also rolled back.
    expect((await engine.getVar(F_AMOUNT))[0]).to.equal(false);
    // The first call's external effect (record) rolled back via tx revert.
    expect(await sink.recorded(amount)).to.equal(0n);
  });

  it("all calls succeed -> outputs committed (the single post-interaction write) + effect lands", async () => {
    const sink = await ethers.deployContract("MockSink");
    await sink.waitForDeployment();
    const { engine } = await buildMultiCall(await sink.getAddress(), false);

    const amount = 88n;
    await (
      await engine.submitInput(I_GO, encodePayload([df(F_AMOUNT, FieldType.UINT256, uintWord(amount))]))
    ).wait();

    expect(await engine.currentState()).to.equal(S_DONE);
    // call 0's record return (== amount) captured into V_CAPTURED.
    const cap = await engine.getVar(V_CAPTURED);
    expect(cap[0]).to.equal(true);
    expect(coder.decode(["uint256"], cap[2])[0]).to.equal(amount);
    // call 1's quoteUint(amount) == amount + 1 captured into V_OBSERVED_VIA_OUTPUT.
    const out = await engine.getVar(V_OBSERVED_VIA_OUTPUT);
    expect(out[0]).to.equal(true);
    expect(coder.decode(["uint256"], out[2])[0]).to.equal(amount + 1n);
    // The external effect landed.
    expect(await sink.recorded(amount)).to.equal(amount);
  });

  // ---------------------------------------------------------------------------
  // Deferred output-commit TIMING: call-0's captured output must NOT be in storage
  // while call-1 runs — it sits in the in-memory overlay until AFTER every call.
  //
  // The prior "all calls succeed" test only checks the END state, so it would pass even
  // if call-0 committed V_CAPTURED to storage immediately. To prove the deferral, call-1's
  // target reads engine.getVar(V_CAPTURED) DURING the action (via the engine's view getter,
  // a staticcall) and records whether it was set. If the commit were eager, call-1 would
  // observe V_CAPTURED already set; with the overlay, it must observe it STILL UNSET.
  // ---------------------------------------------------------------------------
  it("call-0's captured output is NOT yet in storage during call-1 (overlay, not eager commit); it IS set after the whole action", async () => {
    const { Engine, factory } = await deployStack();
    const sink = await ethers.deployContract("MockSink");
    await sink.waitForDeployment();
    // call-1's target: it reads back getVar(V_CAPTURED) mid-action and records the result.
    const probe = await ethers.deployContract("MockReentrantTarget");
    await probe.waitForDeployment();
    await (await probe.setProbeVar(V_CAPTURED)).wait();

    const inputDefs = [[I_GO, [[F_AMOUNT, FieldType.UINT256, true, true]], [], []]];
    const transitions = [[S_START, S_DONE, I_GO]];
    const amtRef = fieldRef(FieldType.UINT256, F_AMOUNT);
    // call 0: record(amount, amount) -> capture return word 0 into V_CAPTURED.
    const call0 = call(
      constRef(FieldType.ADDRESS, await sink.getAddress()),
      recordSel,
      [dynSlot(amtRef), dynSlot(amtRef)],
      boundedAmount(),
      [output(0, FieldType.UINT256, V_CAPTURED)]
    );
    // call 1: observeState(amount) on the probe — reads getVar(V_CAPTURED) mid-action.
    const call1 = call(
      constRef(FieldType.ADDRESS, await probe.getAddress()),
      observeSel,
      [dynSlot(amtRef)],
      boundedAmount()
    );
    const engine = await agreementFrom(
      factory,
      Engine,
      await createComposableAgreement(factory, 
        "ipfs://x",
        ethers.ZeroHash,
        S_START,
        inputDefs as any,
        transitions as any,
        [] as any,
        [composableActionInit(S_START, I_GO, [call0, call1])] as any,
        [] as any,
        [] as any // no verifiers
      )
    );

    const amount = 99n;
    // Pre-state: V_CAPTURED is unset.
    expect((await engine.getVar(V_CAPTURED))[0]).to.equal(false);

    await (
      await engine.submitInput(I_GO, encodePayload([df(F_AMOUNT, FieldType.UINT256, uintWord(amount))]))
    ).wait();

    // MID-ACTION (during call-1): the probe observed V_CAPTURED STILL UNSET — proving call-0's
    // output sat in the in-memory overlay, not storage, while later calls executed. If the
    // engine had committed eagerly (per-call), this would have been `true`.
    expect(await probe.observed()).to.equal(true);
    expect(await probe.observedVarSet(), "call-0's output must NOT be in storage during call-1").to.equal(false);

    // AFTER the whole action: the overlay committed -> V_CAPTURED is now set to call-0's return.
    const cap = await engine.getVar(V_CAPTURED);
    expect(cap[0], "call-0's output IS committed after all calls succeed").to.equal(true);
    expect(coder.decode(["uint256"], cap[2])[0]).to.equal(amount);
    expect(await engine.currentState()).to.equal(S_DONE);
  });
});

// ---------------------------------------------------------------------------
// Invariant 4 — verifier interaction safety (view => staticcall).
// ---------------------------------------------------------------------------

describe("R5 verifier safety — a state-mutating verifier is blocked by the staticcall", () => {
  const V_KEY = ethers.id("VC_TEST");

  async function buildWithVerifier(verifierAddr: string) {
    const { Engine, factory } = await deployStack();
    // Input `go` with no persisted field (no action), one verifier key.
    // Owner-less governance (R8): the verifier is registered AT INIT via the verifiers_ param,
    // not post-init.
    const inputDefs = [[I_GO, [], [], [V_KEY]]];
    const transitions = [[S_START, S_DONE, I_GO]];
    const engine = await agreementFrom(
      factory,
      Engine,
      await createComposableAgreement(factory, 
        "ipfs://x",
        ethers.ZeroHash,
        S_START,
        inputDefs as any,
        transitions as any,
        [] as any,
        [] as any,
        [] as any,
        [verifierReg(V_KEY, verifierAddr)] as any
      )
    );
    return { engine };
  }

  it("benign (pass-through) verifier: submission succeeds (proves the verifier path runs)", async () => {
    const v = await ethers.deployContract("MockPassThroughVerifier");
    await v.waitForDeployment();
    const { engine } = await buildWithVerifier(await v.getAddress());
    await (await engine.submitInput(I_GO, encodePayload([]))).wait();
    expect(await engine.currentState()).to.equal(S_DONE);
  });

  // Non-view interface over the SAME verify(...) selector. The CONTROL path calls the deployed
  // verifier through this (so the call site compiles to a plain CALL); the engine holds it as
  // IInputVerifier (view) and reaches the same function via STATICCALL. Same contract, same
  // selector, two call opcodes — the only variable is view→staticcall vs non-view→call.
  const mutatingVerifierIface = new ethers.Interface([
    "function verify(address agreement, bytes32 inputId, bytes payload, address sender)",
  ]);

  it("verifier attempting a SELF-WRITE: the engine's view->STATICCALL reverts it; the SAME contract+selector via a non-view->CALL succeeds (isolates the staticcall)", async () => {
    const v = await ethers.deployContract("MockMutatingVerifier");
    await v.waitForDeployment();
    await (await v.setMode(0 /* SELF_WRITE */)).wait();

    // CONTROL: invoke the SAME deployed verifier's verify() through a NON-view interface (a
    // plain CALL). verify() does a DIRECT sstore (counter += 1) inside itself — no inner
    // view-lying helper — so under a plain CALL the SSTORE lands. This proves the mutation is
    // genuinely possible and that the only thing standing between attempt and success is the
    // caller's call opcode.
    expect(await v.counter()).to.equal(0n);
    const verifierAsMutating = new ethers.Contract(
      await v.getAddress(),
      mutatingVerifierIface,
      (await ethers.getSigners())[0]
    );
    await (
      await verifierAsMutating.verify(ethers.ZeroAddress, ethers.ZeroHash, "0x", ethers.ZeroAddress)
    ).wait();
    expect(await v.counter()).to.equal(1n); // plain CALL -> the verifier's own sstore committed

    // ENGINE PATH: the engine calls the verifier through IInputVerifier (verify is `view`), so
    // the compiler lowers the call site to a STATICCALL. The SAME verify() now reverts when it
    // hits its direct sstore -> the submission reverts and the state never advances. Because the
    // verifier emits no staticcall itself, this revert can ONLY come from the engine's call site
    // being a staticcall; were the engine to use a plain CALL, the sstore would land and this
    // submission would succeed.
    const { engine } = await buildWithVerifier(await v.getAddress());
    await expect(engine.submitInput(I_GO, encodePayload([]))).to.be.reverted;
    expect(await engine.currentState()).to.equal(S_START);
    // The engine-path attempt left no write: counter still reflects only the control's plain
    // CALL bump (the staticcalled sstore reverted).
    expect(await v.counter()).to.equal(1n);
  });

  // CONTRAST with the SELF_WRITE case above. Verifiers run INSIDE the outer submitInput, which
  // is `nonReentrant`, so the OZ guard's `_status` is already ENTERED. When the staticcalled
  // verifier re-enters submitInput, the FIRST thing the nested call does is the nonReentrant
  // check `if (_status == ENTERED) revert ReentrancyGuardReentrantCall()` — which precedes any
  // sstore and reverts with DATA (a REVERT, legal under staticcall). So this re-entry is caught
  // by the OZ REENTRANCY GUARD (selector 0x3ee5aeb5), NOT by the staticcall context: the guard
  // fires before the staticcall context would ever have to reject a state write. (Distinct from
  // SELF_WRITE, which has no guard in the path and reverts dataless purely on the static frame.)
  it("verifier attempting to RE-ENTER submitInput is caught by the OZ REENTRANCY GUARD (its _status==ENTERED check precedes any sstore), distinct from the SELF_WRITE staticcall-context revert", async () => {
    const v = await ethers.deployContract("MockMutatingVerifier");
    await v.waitForDeployment();
    await (await v.setMode(1 /* REENTER_SUBMIT */)).wait();
    await (await v.setReenter(I_GO, encodePayload([]))).wait();
    const { engine } = await buildWithVerifier(await v.getAddress());

    // The inner re-entry's revert is the OZ guard's ReentrancyGuardReentrantCall, surfaced as
    // the verifier bubbles it back up through the engine's staticcall of verify().
    const raw = await expectRevertData(engine.submitInput.staticCall(I_GO, encodePayload([])));
    expect(
      raw.toLowerCase().startsWith(REENTRANCY_SELECTOR.toLowerCase()),
      "re-entry must surface ReentrancyGuardReentrantCall (the guard check precedes any sstore)"
    ).to.equal(true);

    await expect(engine.submitInput(I_GO, encodePayload([]))).to.be.reverted;
    expect(await engine.currentState()).to.equal(S_START);
  });
});

// ---------------------------------------------------------------------------
// Invariant 1 + 3 over the PERMIT pipeline — submitInputWithPermit is a SEPARATE,
// duplicated execution pipeline (own decode/validate/persist/conditions/verifiers/transition/
// action sequence, ~AgreementEngine.sol:494). Elsewhere it is only exercised as a BLOCKED
// nested call; here we drive it as the OUTER, SUCCESSFUL path so a CEI-ordering or
// atomic-rollback regression in the permit pipeline (independent of submitInput's) is caught.
// ---------------------------------------------------------------------------

describe("R5 permit pipeline — CEI ordering + atomic multi-call rollback via submitInputWithPermit", () => {
  it("CEI: with submitInputWithPermit as the outer path, the action target observes the COMMITTED post-transition state (currentState == toState, persisted field written)", async () => {
    const { Engine, factory } = await deployStack();
    const [, signer] = await ethers.getSigners(); // a distinct signer (not the deployer/owner)
    const target = await ethers.deployContract("MockReentrantTarget");
    await target.waitForDeployment();
    await (await target.setProbeVar(F_AMOUNT)).wait();

    const inputDefs = [[I_GO, [[F_AMOUNT, FieldType.UINT256, true, true]], [], []]];
    const transitions = [[S_START, S_DONE, I_GO]];
    const c = call(
      constRef(FieldType.ADDRESS, await target.getAddress()),
      observeSel,
      [dynSlot(fieldRef(FieldType.UINT256, F_AMOUNT))],
      boundedAmount()
    );
    const engine = await agreementFrom(
      factory,
      Engine,
      await createComposableAgreement(factory, 
        "ipfs://x",
        ethers.ZeroHash,
        S_START,
        inputDefs as any,
        transitions as any,
        [] as any,
        [composableActionInit(S_START, I_GO, [c])] as any,
        [] as any,
        [] as any // no verifiers
      )
    );

    const amount = 4242n;
    const payload = encodePayload([df(F_AMOUNT, FieldType.UINT256, uintWord(amount))]);
    const deadline = ethers.MaxUint256;
    const { v, r, s } = await signPermit(engine, await engine.getAddress(), signer, I_GO, payload, deadline);

    await (
      await engine.submitInputWithPermit(signer.address, I_GO, payload, deadline, v, r, s)
    ).wait();

    expect(await engine.currentState()).to.equal(S_DONE);
    // The action target observed the COMMITTED post-transition state mid-action (effects before
    // interactions) — proving the permit pipeline orders effects-then-action just like submitInput.
    expect(await target.observed()).to.equal(true);
    expect(await target.observedState()).to.equal(S_DONE);
    expect(await target.observedVarSet()).to.equal(true);
    expect(coder.decode(["uint256"], await target.observedVarData())[0]).to.equal(amount);
  });

  // A multi-call action driven by the permit path: call-0 records (effect + captured output),
  // call-1 either succeeds (quoteUint) or reverts (boom). On the later-call revert the WHOLE
  // permit transition rolls back; on success the outputs commit. Mirrors the submitInput
  // atomicity test, but exercises the permit pipeline.
  async function buildPermitMultiCall(sink: string, secondCallReverts: boolean) {
    const { Engine, factory, actionLibAbi } = await deployStack();
    const inputDefs = [[I_GO, [[F_AMOUNT, FieldType.UINT256, true, true]], [], []]];
    const transitions = [[S_START, S_DONE, I_GO]];
    const amtRef = fieldRef(FieldType.UINT256, F_AMOUNT);
    const call0 = call(
      constRef(FieldType.ADDRESS, sink),
      recordSel,
      [dynSlot(amtRef), dynSlot(amtRef)],
      boundedAmount(),
      [output(0, FieldType.UINT256, V_CAPTURED)]
    );
    const call1 = secondCallReverts
      ? call(constRef(FieldType.ADDRESS, sink), boomSel, [])
      : call(
          constRef(FieldType.ADDRESS, sink),
          quoteUintSel,
          [dynSlot(amtRef)],
          boundedAmount(),
          [output(0, FieldType.UINT256, V_OBSERVED_VIA_OUTPUT)]
        );
    const engine = await agreementFrom(
      factory,
      Engine,
      await createComposableAgreement(factory, 
        "ipfs://x",
        ethers.ZeroHash,
        S_START,
        inputDefs as any,
        transitions as any,
        [] as any,
        [composableActionInit(S_START, I_GO, [call0, call1])] as any,
        [] as any,
        [] as any // no verifiers
      )
    );
    return { engine, actionLibAbi };
  }

  it("atomicity: a LATER call reverting rolls back the WHOLE permit transition (state unchanged, no output committed, no effect, nonce NOT consumed)", async () => {
    const [, signer] = await ethers.getSigners();
    const sink = await ethers.deployContract("MockSink");
    await sink.waitForDeployment();
    const { engine, actionLibAbi } = await buildPermitMultiCall(await sink.getAddress(), true);

    const amount = 77n;
    const payload = encodePayload([df(F_AMOUNT, FieldType.UINT256, uintWord(amount))]);
    const deadline = ethers.MaxUint256;
    const nonceBefore = await engine.nonces(signer.address);
    const { v, r, s } = await signPermit(engine, await engine.getAddress(), signer, I_GO, payload, deadline);

    await expect(
      engine.submitInputWithPermit(signer.address, I_GO, payload, deadline, v, r, s)
    ).to.be.revertedWithCustomError(actionLibAbi, "CallReverted");

    // Whole transition rolled back.
    expect(await engine.currentState()).to.equal(S_START);
    expect((await engine.getVar(V_CAPTURED))[0]).to.equal(false);
    expect((await engine.getVar(V_OBSERVED_VIA_OUTPUT))[0]).to.equal(false);
    expect((await engine.getVar(F_AMOUNT))[0]).to.equal(false);
    expect(await sink.recorded(amount)).to.equal(0n);
    // The nonce increment (an effect of the permit pipeline) also rolled back with the tx.
    expect(await engine.nonces(signer.address)).to.equal(nonceBefore);
  });

  it("atomicity: all calls succeed via the permit path -> outputs committed (the single post-interaction write) + effect lands + nonce consumed", async () => {
    const [, signer] = await ethers.getSigners();
    const sink = await ethers.deployContract("MockSink");
    await sink.waitForDeployment();
    const { engine } = await buildPermitMultiCall(await sink.getAddress(), false);

    const amount = 88n;
    const payload = encodePayload([df(F_AMOUNT, FieldType.UINT256, uintWord(amount))]);
    const deadline = ethers.MaxUint256;
    const nonceBefore = await engine.nonces(signer.address);
    const { v, r, s } = await signPermit(engine, await engine.getAddress(), signer, I_GO, payload, deadline);

    await (
      await engine.submitInputWithPermit(signer.address, I_GO, payload, deadline, v, r, s)
    ).wait();

    expect(await engine.currentState()).to.equal(S_DONE);
    const cap = await engine.getVar(V_CAPTURED);
    expect(cap[0]).to.equal(true);
    expect(coder.decode(["uint256"], cap[2])[0]).to.equal(amount);
    const out = await engine.getVar(V_OBSERVED_VIA_OUTPUT);
    expect(out[0]).to.equal(true);
    expect(coder.decode(["uint256"], out[2])[0]).to.equal(amount + 1n);
    expect(await sink.recorded(amount)).to.equal(amount);
    // The permit nonce was consumed exactly once on the successful path.
    expect(await engine.nonces(signer.address)).to.equal(nonceBefore + 1n);
  });
});
