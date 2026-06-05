/**
 * Differential parity harness.
 *
 * Deploys a frozen Legacy clone and a canonical AgreementEngine clone from identical
 * init params, submits the identical payload to both, and returns the observable
 * tuple for each: (reverted, currentState, persisted-var deltas).
 *
 * No mocking: both are real contracts deployed via their real factories. The two
 * engines are byte-for-byte identical except for the condition representation and
 * evaluation path, which is what these tests exercise.
 */

import { ethers } from "hardhat";
import { expect } from "chai";
import type { ParityCase, DataField, Submission } from "./corpus";
import { desugarLegacyInputDefs } from "./desugar-bridge";

const coder = ethers.AbiCoder.defaultAbiCoder();

// DataField[] tuple type used to abi.encode the submitInput payload.
const DATA_FIELD_ARRAY_ABI = ["tuple(bytes32 id, uint8 fType, bytes data)[]"];

export interface DeployedProtocol {
  legacyFactory: any;
  canonicalFactory: any;
}

let _cached: DeployedProtocol | null = null;

export async function deployBothProtocols(): Promise<DeployedProtocol> {
  if (_cached) return _cached;

  const legacyImpl = await ethers.deployContract("LegacyAgreementEngine");
  await legacyImpl.waitForDeployment();
  const legacyFactory = await ethers.deployContract("LegacyAgreementFactory", [
    await legacyImpl.getAddress(),
  ]);
  await legacyFactory.waitForDeployment();

  const actionLib = await ethers.deployContract("ActionLib");
  await actionLib.waitForDeployment();
  const CanonicalEngine = await ethers.getContractFactory("AgreementEngine", {
    libraries: { ActionLib: await actionLib.getAddress() },
  });
  const canonicalImpl = await CanonicalEngine.deploy();
  await canonicalImpl.waitForDeployment();
  const canonicalFactory = await ethers.deployContract("AgreementFactory", [
    await canonicalImpl.getAddress(),
  ]);
  await canonicalFactory.waitForDeployment();

  _cached = { legacyFactory, canonicalFactory };
  return _cached;
}

/** Common init-arg tuples shared by both factories. */
function commonInitArgs(c: ParityCase) {
  const transitions = c.transitions.map((t) => [t.fromState, t.toState, t.inputId]);
  const initVars = c.initVars.map((v) => [v.id, v.fType, v.data]);
  return { transitions, initVars };
}

/** Legacy factory init args: inputDefs carry the legacy `Op` conditions; no actions. */
function legacyInitArgs(c: ParityCase) {
  const inputDefs = c.inputDefs.map((d) => [
    d.id,
    d.fields.map((f) => [f.fieldId, f.fType, f.required, f.persist]),
    d.conditions.map((cond) => [cond.op, cond.fieldId, cond.bytesArg]),
    d.verifierKeys,
  ]);
  return { inputDefs, ...commonInitArgs(c) };
}

function encodePayload(fields: DataField[]): string {
  return coder.encode(DATA_FIELD_ARRAY_ABI, [fields.map((f) => [f.id, f.fType, f.data])]);
}

export interface CreateResult {
  ok: boolean;
  agreement?: string;
  error?: string;
}

/**
 * Create an agreement clone on the LEGACY factory from the legacy `Op` corpus (the
 * ground-truth oracle path — frozen and unchanged). Captures an init revert as ok=false.
 */
async function createLegacyAgreement(factory: any, c: ParityCase, owner: any): Promise<CreateResult> {
  const { inputDefs, transitions, initVars } = legacyInitArgs(c);
  const docUri = "ipfs://parity";
  const docHash = ethers.id("dochash");
  try {
    const predicted = await factory
      .connect(owner)
      .createAgreement.staticCall(docUri, docHash, c.initialState, inputDefs, transitions, initVars, []);
    const tx = await factory
      .connect(owner)
      .createAgreement(docUri, docHash, c.initialState, inputDefs, transitions, initVars, []);
    await tx.wait();
    return { ok: true, agreement: predicted };
  } catch (e: any) {
    return { ok: false, error: String(e?.shortMessage ?? e?.message ?? e) };
  }
}

/**
 * Create an agreement clone on the NEW composable factory, feeding it via the SDK TS desugar
 * (legacy `Op` corpus -> canonical conditions + composable init). No legacy actions exist in
 * the corpus, so `actions` and `verifiers` are empty. Captures an init revert as ok=false —
 * which is exactly where the self-referential-VAR named exception surfaces (the new engine
 * rejects it at init while the legacy engine accepts it).
 */
async function createComposableAgreement(factory: any, c: ParityCase, owner: any): Promise<CreateResult> {
  const { transitions, initVars } = commonInitArgs(c);
  const { inputDefInits, canonicalConds } = desugarLegacyInputDefs(c.inputDefs);
  const docUri = "ipfs://parity";
  const docHash = ethers.id("dochash");
  try {
    const predicted = await factory
      .connect(owner)
      .createAgreement.staticCall(
        docUri,
        docHash,
        c.initialState,
        inputDefInits,
        transitions,
        initVars,
        [], // no composable actions in the parity corpus
        canonicalConds,
        [] // no verifiers
      );
    const tx = await factory
      .connect(owner)
      .createAgreement(
        docUri,
        docHash,
        c.initialState,
        inputDefInits,
        transitions,
        initVars,
        [],
        canonicalConds,
        []
      );
    await tx.wait();
    return { ok: true, agreement: predicted };
  } catch (e: any) {
    return { ok: false, error: String(e?.shortMessage ?? e?.message ?? e) };
  }
}

export interface Observable {
  initReverted: boolean;
  initError?: string;
  submitReverted: boolean;
  submitError?: string;
  currentState: string;
  // persisted-var deltas: a broad set of var ids (declared/submitted/referenced +
  // sentinels) so accidental persistence of a non-persisted field, or mutation of a
  // referenced var, surfaces as a delta divergence.
  varDeltas: Record<string, { set: boolean; fType: number; data: string }>;
  // The authorizing signer's nonce after the submission (permit replay accounting).
  // Captured only for permit cases (undefined otherwise).
  signerNonce?: string;
  // Number of InputAccepted events emitted by the final submission (0 or 1).
  inputAcceptedCount?: number;
}

// A few sentinel var ids that no case sets/persists. If either engine ever reports
// one as set, something wrote outside the declared surface.
const SENTINEL_VAR_IDS = [
  ethers.id("__sentinel_a__"),
  ethers.id("__sentinel_b__"),
  ethers.id("__sentinel_c__"),
];

/**
 * Collect the var ids whose deltas we observe. Broad on purpose:
 *  - every init var id,
 *  - every declared input field id (across all inputs) — catches accidental
 *    persistence of a field that was NOT marked persist,
 *  - every submitted field id (including prior submissions),
 *  - every RHS var id referenced by a VAR-sourced condition (decoded from bytesArg),
 *  - sentinel ids that nothing should ever write.
 */
function observedVarIds(c: ParityCase): string[] {
  const ids = new Set<string>();
  for (const v of c.initVars) ids.add(v.id);
  for (const d of c.inputDefs) {
    for (const f of d.fields) ids.add(f.fieldId);
    for (const cond of d.conditions) {
      // VAR-sourced legacy conditions encode the target var id as a bytes32 in bytesArg.
      // UINT/STRING/ADDRESS _EQ_VAR (and friends) use this; SENDER_EQ_VAR uses fieldId.
      ids.add(cond.fieldId);
      const refIds = decodeVarRefIds(cond);
      for (const r of refIds) ids.add(r);
    }
  }
  const allSubs = [...(c.priorSubmissions ?? []), c.submission];
  for (const sub of allSubs) for (const f of sub.fields) ids.add(f.id);
  for (const s of SENTINEL_VAR_IDS) ids.add(s);
  return [...ids];
}

/** Decode any var ids a legacy condition's bytesArg references (best-effort). */
function decodeVarRefIds(cond: { op: number; fieldId: string; bytesArg: string }): string[] {
  // SENDER_IN_ALLOWED_ADDRESSES: bytesArg = (bytes32[] varIds, address[] addrs)
  if (cond.op === 17) {
    try {
      const [varIds] = coder.decode(["bytes32[]", "address[]"], cond.bytesArg);
      return [...varIds];
    } catch {
      return [];
    }
  }
  // *_VAR ops encode a single bytes32 var id; CONST ops encode a value (not a var id).
  // We attempt a bytes32 decode and accept it only when bytesArg is exactly 32 bytes.
  const hex = cond.bytesArg.startsWith("0x") ? cond.bytesArg.slice(2) : cond.bytesArg;
  if (hex.length === 64) {
    try {
      return [coder.decode(["bytes32"], cond.bytesArg)[0]];
    } catch {
      return [];
    }
  }
  return [];
}

async function readVars(engine: any, ids: string[]): Promise<Observable["varDeltas"]> {
  const out: Observable["varDeltas"] = {};
  for (const idv of ids) {
    const [set, fType, data] = await engine.getVar(idv);
    out[idv] = { set, fType: Number(fType), data };
  }
  return out;
}

/** EIP-712 permit signature over PermitInput(inputId, payload, nonce, deadline). */
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
  const value = { inputId, payload, nonce, deadline };
  const sig = await signer.signTypedData(domain, types, value);
  const split = ethers.Signature.from(sig);
  return { v: split.v, r: split.r, s: split.s };
}

/**
 * Submit one Submission to a deployed engine.
 * Returns { reverted, error, acceptedCount } where acceptedCount is the number of
 * InputAccepted events emitted (1 on accept, 0 on revert).
 */
async function submitOne(
  engine: any,
  engineAddress: string,
  sub: Submission,
  signers: any[]
): Promise<{ reverted: boolean; error?: string; acceptedCount: number }> {
  const payload = encodePayload(sub.fields);
  const mode = sub.mode ?? "direct";
  const submitterIndex = sub.submitterIndex ?? 1;
  const submitter = signers[submitterIndex];

  try {
    let receipt: any;
    if (mode === "permit") {
      const signerIndex = sub.signerIndex ?? submitterIndex;
      const permitSigner = signers[signerIndex];
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
      const { v, r, s } = await signPermit(engine, engineAddress, permitSigner, sub.inputId, payload, deadline);
      const tx = await engine
        .connect(submitter)
        .submitInputWithPermit(permitSigner.address, sub.inputId, payload, deadline, v, r, s);
      receipt = await tx.wait();
    } else {
      const tx = await engine.connect(submitter).submitInput(sub.inputId, payload);
      receipt = await tx.wait();
    }
    // Count InputAccepted events emitted by this submission.
    let acceptedCount = 0;
    for (const log of receipt.logs ?? []) {
      try {
        const parsed = engine.interface.parseLog(log);
        if (parsed && parsed.name === "InputAccepted") acceptedCount++;
      } catch {
        /* unrelated log */
      }
    }
    return { reverted: false, acceptedCount };
  } catch (e: any) {
    return { reverted: true, error: String(e?.shortMessage ?? e?.message ?? e), acceptedCount: 0 };
  }
}

/** The authorizing signer index of the final submission (for nonce observation). */
function authSignerIndex(c: ParityCase): number {
  const sub = c.submission;
  const mode = sub.mode ?? "direct";
  return mode === "permit" ? sub.signerIndex ?? sub.submitterIndex ?? 1 : sub.submitterIndex ?? 1;
}

/** Run a case against one engine (one factory + engine artifact name). */
async function runOnEngine(
  factory: any,
  engineArtifact: string,
  c: ParityCase,
  owner: any,
  signers: any[]
): Promise<Observable> {
  // The legacy engine ingests the legacy `Op` corpus directly (ground-truth oracle); the new
  // engine is fed via the SDK TS desugar -> composable init.
  const created =
    engineArtifact === "LegacyAgreementEngine"
      ? await createLegacyAgreement(factory, c, owner)
      : await createComposableAgreement(factory, c, owner);
  if (!created.ok) {
    return {
      initReverted: true,
      initError: created.error,
      submitReverted: false,
      currentState: "",
      varDeltas: {},
    };
  }

  const engine = await ethers.getContractAt(engineArtifact, created.agreement!);
  const ids = observedVarIds(c);

  // Apply any prior submissions in order. Each is expected to succeed (it sets up
  // state/vars for the asserted submission); a revert here is a setup failure.
  for (const prior of c.priorSubmissions ?? []) {
    const r = await submitOne(engine, created.agreement!, prior, signers);
    if (r.reverted) {
      throw new Error(`prior submission '${prior.inputId}' reverted on ${engineArtifact}: ${r.error}`);
    }
  }

  const permitMode = (c.submission.mode ?? "direct") === "permit";
  const result = await submitOne(engine, created.agreement!, c.submission, signers);

  const currentState = await engine.currentState();
  const varDeltas = await readVars(engine, ids);
  const signerNonce = permitMode
    ? String(await engine.nonces(signers[authSignerIndex(c)].address))
    : undefined;

  return {
    initReverted: false,
    submitReverted: result.reverted,
    submitError: result.error,
    currentState,
    varDeltas,
    signerNonce,
    inputAcceptedCount: result.acceptedCount,
  };
}

export interface DifferentialResult {
  legacy: Observable;
  canonical: Observable;
}

/** Deploy to both engines and submit identical payload; return both observables. */
export async function runDifferential(c: ParityCase): Promise<DifferentialResult> {
  const { legacyFactory, canonicalFactory } = await deployBothProtocols();
  const signers = await ethers.getSigners();
  const owner = signers[0];

  const legacy = await runOnEngine(legacyFactory, "LegacyAgreementEngine", c, owner, signers);
  const canonical = await runOnEngine(canonicalFactory, "AgreementEngine", c, owner, signers);

  return { legacy, canonical };
}

/** Compare the observable tuples for strict parity (reverted, state, var deltas). */
export function tuplesEqual(a: Observable, b: Observable): { equal: boolean; reason?: string } {
  if (a.initReverted !== b.initReverted) {
    return { equal: false, reason: `initReverted differs: legacy=${a.initReverted} new=${b.initReverted}` };
  }
  if (a.initReverted) return { equal: true }; // both reverted at init
  if (a.submitReverted !== b.submitReverted) {
    return {
      equal: false,
      reason: `submitReverted differs: legacy=${a.submitReverted} (${a.submitError}) new=${b.submitReverted} (${b.submitError})`,
    };
  }
  if (a.currentState !== b.currentState) {
    return { equal: false, reason: `currentState differs: legacy=${a.currentState} new=${b.currentState}` };
  }
  const ids = new Set([...Object.keys(a.varDeltas), ...Object.keys(b.varDeltas)]);
  for (const idv of ids) {
    const va = a.varDeltas[idv];
    const vb = b.varDeltas[idv];
    if (!va || !vb || va.set !== vb.set || va.fType !== vb.fType || va.data !== vb.data) {
      return {
        equal: false,
        reason: `var delta differs for ${idv}: legacy=${JSON.stringify(va)} new=${JSON.stringify(vb)}`,
      };
    }
  }
  if ((a.signerNonce ?? null) !== (b.signerNonce ?? null)) {
    return { equal: false, reason: `signerNonce differs: legacy=${a.signerNonce} new=${b.signerNonce}` };
  }
  if ((a.inputAcceptedCount ?? 0) !== (b.inputAcceptedCount ?? 0)) {
    return {
      equal: false,
      reason: `InputAccepted count differs: legacy=${a.inputAcceptedCount} new=${b.inputAcceptedCount}`,
    };
  }
  return { equal: true };
}

/**
 * Ground-truth parity assertion for a non-exception ParityCase.
 *
 * Anchors parity to ground truth, not just mutual agreement:
 *  1. BOTH engines must initialize successfully — a both-revert-at-init is a FAILURE,
 *     not parity (a setup bug that broke both identically would otherwise pass).
 *  2. The LEGACY (frozen reference) outcome must equal the case's expected
 *     accept/reject — anchoring the corpus's `expectAccept` to legacy ground truth.
 *  3. The new engine's observable tuple must equal legacy's (full differential parity).
 *  4. On accept, the resulting state is `expectedToState`; on reject it is unchanged
 *     (`expectedRejectState`, defaulting to the case's pre-submission current state).
 *
 * Throws (via chai) with a descriptive message on any mismatch.
 */
export function assertParity(c: ParityCase, legacy: Observable, canonical: Observable): void {
  // 1. Both engines must have initialized. A both-revert-at-init no longer "passes".
  expect(
    legacy.initReverted,
    `[${c.name}] legacy failed to initialize (setup bug?): ${legacy.initError}`
  ).to.equal(false);
  expect(
    canonical.initReverted,
    `[${c.name}] new engine failed to initialize: ${canonical.initError}`
  ).to.equal(false);

  // 2. Legacy's actual outcome must match the corpus's ground-truth expectAccept.
  const legacyAccepted = !legacy.submitReverted;
  expect(
    legacyAccepted,
    `[${c.name}] legacy actual outcome (accepted=${legacyAccepted}; submitError=${legacy.submitError}) ` +
      `disagrees with corpus expectAccept=${c.expectAccept} — corpus bug or a real discovery, not to be silently adjusted`
  ).to.equal(c.expectAccept);

  // 3. New engine matches legacy across the full observable tuple.
  const cmp = tuplesEqual(legacy, canonical);
  expect(cmp.equal, `[${c.name}] new diverges from legacy: ${cmp.reason}`).to.equal(true);

  // 4. Resulting state matches the expected accept/reject state.
  const expectedState = c.expectAccept
    ? c.expectedToState
    : c.expectedRejectState ?? preSubmissionState(c);
  expect(legacy.currentState, `[${c.name}] legacy resulting state`).to.equal(expectedState);
  // (canonical equals legacy via step 3, so this also pins the new engine.)
}

/** The FSM state expected immediately before the asserted submission (for reject cases). */
function preSubmissionState(c: ParityCase): string {
  // With prior submissions, the pre-submission state is the toState of the last prior
  // transition; otherwise it is the agreement's initialState.
  const priors = c.priorSubmissions ?? [];
  if (priors.length === 0) return c.initialState;
  const lastInputId = priors[priors.length - 1].inputId;
  // Find the transition fired by the last prior input from any from-state.
  const t = c.transitions.find((tr) => tr.inputId === lastInputId);
  return t ? t.toState : c.initialState;
}
