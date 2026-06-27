/**
 * Shared helpers for ActionLib unit tests.
 *
 * ArgSlot / Call / Action builders and a deploy helper for the ActionLibHarness.
 * Reuses the value-lib enum mirrors and ValueRef builders so the two libs share one
 * vocabulary.
 */

import { ethers } from "hardhat";
import {
  FieldType,
  type FieldTypeVal,
  type ValueRef,
  type Condition,
  constRef,
  coder,
} from "./value-lib";

// ---------------------------------------------------------------------------
// ArgSlot / Call / Action builders (tuple shapes the harness expects)
// ---------------------------------------------------------------------------

export interface ArgSlot {
  dynamic: boolean;
  constWord: string; // bytes32
  value: ValueRef;
}

export interface Output {
  returnIndex: bigint;
  outType: FieldTypeVal;
  targetVar: string; // bytes32
}

export interface Call {
  target: ValueRef;
  selector: string; // bytes4
  args: ArgSlot[];
  constraints: Condition[];
  outputs: Output[];
}

const ZERO_REF: ValueRef = { source: 0, vType: FieldType.UINT256, data: "0x" };
const ZERO32 = "0x" + "00".repeat(32);

/** A baked constant-word arg slot (dynamic = false). `word` is the 32-byte word. */
export function constSlot(word: string): ArgSlot {
  return { dynamic: false, constWord: word, value: ZERO_REF };
}

/** A runtime-substituted arg slot (dynamic = true), resolved from `value`. */
export function dynSlot(value: ValueRef): ArgSlot {
  return { dynamic: true, constWord: ZERO32, value };
}

/** Build a Call. */
export function call(
  target: ValueRef,
  selector: string,
  args: ArgSlot[],
  constraints: Condition[] = [],
  outputs: Output[] = []
): Call {
  return { target, selector, args, constraints, outputs };
}

/** Build an Output capture spec (decode the returnIndex-th word to outType -> targetVar). */
export function output(returnIndex: bigint | number, outType: FieldTypeVal, targetVar: string): Output {
  return { returnIndex: BigInt(returnIndex), outType, targetVar };
}

// ---------------------------------------------------------------------------
// Word encoders — the canonical 32-byte call-word for a fixed-size type.
// (For these fixed-width types, abi.encode(value) IS the 32-byte word, matching
// ValueLib.resolve's canonical output.)
// ---------------------------------------------------------------------------

export function wordUint(v: bigint | number): string {
  return coder.encode(["uint256"], [v]);
}
export function wordAddress(v: string): string {
  return coder.encode(["address"], [v]);
}
export function wordBool(v: boolean): string {
  return coder.encode(["bool"], [v]);
}
export function wordBytes32(v: string): string {
  return coder.encode(["bytes32"], [v]);
}

// ---------------------------------------------------------------------------
// ABI encoding (for authoring composable actions on the engine)
// ---------------------------------------------------------------------------

// Tuple types matching ActionLib.Call (and its nested AgreementTypes structs).
const VALUE_REF_TUPLE = "(uint8 source, uint8 vType, bytes data)";
const CONDITION_TUPLE = `(${VALUE_REF_TUPLE} left, uint8 op, bool skipIfAbsent, ${VALUE_REF_TUPLE}[] right)`;
const ARG_SLOT_TUPLE = `(bool dynamic, bytes32 constWord, ${VALUE_REF_TUPLE} value)`;
const OUTPUT_TUPLE = "(uint256 returnIndex, uint8 outType, bytes32 targetVar)";
export const CALL_TUPLE = `(${VALUE_REF_TUPLE} target, bytes4 selector, ${ARG_SLOT_TUPLE}[] args, ${CONDITION_TUPLE}[] constraints, ${OUTPUT_TUPLE}[] outputs)`;

/** ABI-encode an ActionLib.Call[] into the opaque `encodedCalls` bytes the engine stores. */
export function encodeCalls(calls: Call[]): string {
  return coder.encode([`${CALL_TUPLE}[]`], [calls]);
}

/** Build a ComposableActionInit row (fromState, inputId, encodedCalls). */
export function composableActionInit(fromState: string, inputId: string, calls: Call[]) {
  return { fromState, inputId, encodedCalls: encodeCalls(calls) };
}

/** ABI-encode an AgreementTypes.Condition[] (the canonical input-condition authoring form). */
export function encodeConditions(conditions: Condition[]): string {
  return coder.encode([`${CONDITION_TUPLE}[]`], [conditions]);
}

/** Build a CanonicalConditionInit row (inputId, encodedConditions). */
export function canonicalConditionInit(inputId: string, conditions: Condition[]) {
  return { inputId, encodedConditions: encodeConditions(conditions) };
}

/**
 * Build a VerifierReg row (key, verifier) for the composable init verifier param.
 * Owner-less governance (R8): verifiers are registered AT INIT, not post-init.
 */
export function verifierReg(key: string, verifier: string) {
  return { key, verifier };
}

/**
 * Strip the legacy `conditions` slot from a legacy-shaped inputDef tuple
 * `[id, fields, conditions, verifierKeys]` -> the composable `InputDef` tuple
 * `[id, fields, verifierKeys]`. Conditions are no longer carried in the input def (they are
 * supplied via CanonicalConditionInit); composable tests author them empty, so this just
 * drops the (always-empty) conditions element.
 */
export function toInputDefInit(def: any[]): any[] {
  if (def.length === 4) return [def[0], def[1], def[3]];
  return def; // already InputDefInit-shaped
}

/**
 * Test wrapper preserving the old `createComposableAgreement` call shape (legacy 4-tuple
 * inputDefs) on top of the renamed composable `createAgreement`. Drops the dead conditions
 * slot from each inputDef and forwards to `factory.createAgreement`. Keeps the many composable
 * integration tests legible without re-shaping every inputDefs literal by hand.
 */
export function createComposableAgreement(
  factory: any,
  docUri: string,
  docHash: string,
  initialState: string,
  inputDefs: any[],
  transitions: any[],
  initVars: any[],
  actions: any[],
  canonicalConds: any[],
  verifiers: any[]
) {
  return factory.createAgreement(
    docUri,
    docHash,
    initialState,
    inputDefs.map(toInputDefInit),
    transitions,
    initVars,
    actions,
    canonicalConds,
    verifiers
  );
}

/** Deploy the linked ActionLib and return an AgreementEngine ContractFactory linked to it. */
export async function deployLinkedEngineFactory() {
  const actionLib = await ethers.deployContract("ActionLib");
  await actionLib.waitForDeployment();
  return ethers.getContractFactory("AgreementEngine", {
    libraries: { ActionLib: await actionLib.getAddress() },
  });
}

// ---------------------------------------------------------------------------
// Deploy
// ---------------------------------------------------------------------------

export async function freshActionLibHarness(): Promise<any> {
  // The harness calls ActionLib's public entry points (encodeLegacyCall / composeCalldata),
  // so ActionLib must be linked at deploy — same as the engine.
  const actionLib = await ethers.deployContract("ActionLib");
  await actionLib.waitForDeployment();
  const Harness = await ethers.getContractFactory("ActionLibHarness", {
    libraries: { ActionLib: await actionLib.getAddress() },
  });
  const h = await Harness.deploy();
  await h.waitForDeployment();
  return h;
}

export { constRef };
