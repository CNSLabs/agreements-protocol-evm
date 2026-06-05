/**
 * R3 — clone storage round-trip across every FieldType.
 *
 * Deploys a real clone via AgreementFactory, initializes it, and writes a var of
 * EVERY FieldType (UINT256, STRING, ADDRESS, BOOL, BYTES32, BYTES) through the
 * real init path, then reads each back through `getVar` and asserts the exact
 * (fType, bytes) round-trip — including that the legacy enum ordinals (UINT256..
 * BYTES32 = 0..4) are preserved and BYTES is the canonical-only ordinal 5.
 *
 * It also exercises edge values per type, a persisted-field round-trip through the
 * real `submitInput` -> `_persistFields` write path, and asserts the deployed
 * clone is a genuine EIP-1167 minimal proxy. (Effect / output-capture write paths
 * are R4+ — out of scope here, noted not built.)
 *
 * This is the behavioral half of the storage-layout-stability guardrail: the
 * layout snapshot proves the slots don't move; this proves the uniform
 * `mapping(bytes32 => (FieldType, bytes))` store still encodes/decodes every type
 * correctly through a real clone of the real implementation (no mocks, no harness).
 */

import { expect } from "chai";
import { ethers } from "hardhat";
import type { AgreementEngine } from "../../typechain-types";
import { FieldType, encFor, coder, type FieldTypeVal } from "../helpers/value-lib";

/** Typed handle to a deployed AgreementEngine clone. */
async function engineAt(addr: string): Promise<AgreementEngine> {
  return (await ethers.getContractAt("AgreementEngine", addr)) as unknown as AgreementEngine;
}

/** An init-var row: [varId, fType ordinal, canonical abi-encoded bytes]. */
type InitVarRow = [string, FieldTypeVal, string];

const S0 = ethers.id("S0");
const S1 = ethers.id("S1");
const ADDR = ethers.getAddress("0x000000000000000000000000000000000000a11e");
const B32 = ethers.id("rt-b32");

// DataField[] tuple shape accepted by submitInput's abi.decode.
const DATA_FIELD_ARRAY_ABI = ["tuple(bytes32 id, uint8 fType, bytes data)[]"];

// Nominal sample per FieldType: [label, ordinal, raw value, abi type for re-decode].
const SAMPLES: Array<{ name: string; fType: FieldTypeVal; value: any; abiType: string }> = [
  { name: "UINT256", fType: FieldType.UINT256, value: 123456789n, abiType: "uint256" },
  { name: "STRING", fType: FieldType.STRING, value: "hello, agreement", abiType: "string" },
  { name: "ADDRESS", fType: FieldType.ADDRESS, value: ADDR, abiType: "address" },
  { name: "BOOL", fType: FieldType.BOOL, value: true, abiType: "bool" },
  { name: "BYTES32", fType: FieldType.BYTES32, value: B32, abiType: "bytes32" },
  { name: "BYTES", fType: FieldType.BYTES, value: "0xdeadbeefcafe0011", abiType: "bytes" },
];

// Edge / boundary values per FieldType — zero, max, empty, etc.
const EDGE_SAMPLES: Array<{ name: string; fType: FieldTypeVal; value: any; abiType: string }> = [
  { name: "UINT256 zero", fType: FieldType.UINT256, value: 0n, abiType: "uint256" },
  { name: "UINT256 max", fType: FieldType.UINT256, value: 2n ** 256n - 1n, abiType: "uint256" },
  { name: "STRING empty", fType: FieldType.STRING, value: "", abiType: "string" },
  { name: "ADDRESS zero", fType: FieldType.ADDRESS, value: ethers.ZeroAddress, abiType: "address" },
  { name: "BOOL false", fType: FieldType.BOOL, value: false, abiType: "bool" },
  {
    name: "BYTES32 zero",
    fType: FieldType.BYTES32,
    value: ethers.ZeroHash,
    abiType: "bytes32",
  },
  { name: "BYTES empty", fType: FieldType.BYTES, value: "0x", abiType: "bytes" },
];

async function deployFactory() {
  const actionLib = await ethers.deployContract("ActionLib");
  await actionLib.waitForDeployment();
  const Engine = await ethers.getContractFactory("AgreementEngine", {
    libraries: { ActionLib: await actionLib.getAddress() },
  });
  const impl = await Engine.deploy();
  await impl.waitForDeployment();
  const factory = await ethers.deployContract("AgreementFactory", [await impl.getAddress()]);
  await factory.waitForDeployment();
  return { factory, implAddr: (await impl.getAddress()).toLowerCase() };
}

/** Create an agreement clone with the given init vars (and optional input/transitions). */
async function createAgreement(
  factory: any,
  owner: any,
  initVars: any[],
  inputDefs: any[] = [],
  transitions: any[] = []
): Promise<string> {
  const docUri = "ipfs://roundtrip";
  const docHash = ethers.id("roundtrip");
  // Composable init: InputDefInit [id, fields, verifierKeys] (no conditions); empty actions,
  // canonical conditions, and verifiers for these storage round-trip cases.
  const inputDefInits = inputDefs.map((d: any[]) => (d.length === 4 ? [d[0], d[1], d[3]] : d));
  const args = [docUri, docHash, S0, inputDefInits, transitions, initVars, [], [], []] as const;
  const predicted = await factory.connect(owner).createAgreement.staticCall(...args);
  await (await factory.connect(owner).createAgreement(...args)).wait();
  return predicted;
}

describe("AgreementEngine — clone storage round-trip across every FieldType (R3)", () => {
  it("writes and reads back a var of every FieldType through a real clone, exact (fType, bytes)", async () => {
    const { factory } = await deployFactory();
    const [owner] = await ethers.getSigners();

    const initVars: InitVarRow[] = SAMPLES.map((s, i) => [
      ethers.id(`${s.name}-${i}`),
      s.fType,
      encFor(s.fType, s.value),
    ]);
    const engine = await engineAt(await createAgreement(factory, owner, initVars));

    for (let i = 0; i < SAMPLES.length; i++) {
      const s = SAMPLES[i];
      const [id, fType, data] = initVars[i];
      const [set, gotType, gotData] = await engine.getVar(id);

      expect(set, `${s.name}: var should be set`).to.equal(true);
      expect(Number(gotType), `${s.name}: fType ordinal preserved`).to.equal(fType);
      expect(gotData, `${s.name}: stored bytes identical`).to.equal(data);
      expect(coder.decode([s.abiType], gotData)[0]).to.deep.equal(
        coder.decode([s.abiType], encFor(s.fType, s.value))[0]
      );
    }
  });

  it("round-trips edge / boundary values across all six types (0, max, empty, zero addr/hash)", async () => {
    const { factory } = await deployFactory();
    const [owner] = await ethers.getSigners();

    const initVars: InitVarRow[] = EDGE_SAMPLES.map((s, i) => [
      ethers.id(`${s.name}-${i}`),
      s.fType,
      encFor(s.fType, s.value),
    ]);
    const engine = await engineAt(await createAgreement(factory, owner, initVars));

    for (let i = 0; i < EDGE_SAMPLES.length; i++) {
      const s = EDGE_SAMPLES[i];
      const [id, fType, data] = initVars[i];
      const [set, gotType, gotData] = await engine.getVar(id);

      // Even an "empty" dynamic value is stored as canonical abi.encode (length-prefixed),
      // so `set` is true and the bytes round-trip exactly.
      expect(set, `${s.name}: var should be set`).to.equal(true);
      expect(Number(gotType), `${s.name}: fType ordinal preserved`).to.equal(fType);
      expect(gotData, `${s.name}: stored bytes identical`).to.equal(data);
      expect(coder.decode([s.abiType], gotData)[0]).to.deep.equal(
        coder.decode([s.abiType], encFor(s.fType, s.value))[0]
      );
    }
  });

  it("round-trips a persisted field through the real submitInput -> _persistFields write path", async () => {
    const { factory } = await deployFactory();
    const [owner] = await ethers.getSigners();

    const inputId = ethers.id("setAmount");
    const amountFieldId = ethers.id("amount");

    // InputDef with one persisted UINT256 field; one transition S0 -> S1 on this input.
    const inputDefs = [
      [
        inputId,
        [[amountFieldId, FieldType.UINT256, /*required*/ true, /*persist*/ true]],
        [], // conditions
        [], // verifierKeys
      ],
    ];
    const transitions = [[S0, S1, inputId]];

    const engine = await engineAt(
      await createAgreement(factory, owner, [], inputDefs, transitions)
    );

    // Field not yet written: getVar reports unset.
    const before = await engine.getVar(amountFieldId);
    expect(before[0]).to.equal(false);

    // Submit the input; _persistFields writes vars[amount] = (UINT256, 4242).
    const amount = 4242n;
    const payload = coder.encode(DATA_FIELD_ARRAY_ABI, [
      [[amountFieldId, FieldType.UINT256, encFor(FieldType.UINT256, amount)]],
    ]);
    await (await engine.connect(owner).submitInput(inputId, payload)).wait();

    // The transition fired and the persisted field round-trips exactly.
    expect(await engine.currentState()).to.equal(S1);
    const [set, gotType, gotData] = await engine.getVar(amountFieldId);
    expect(set).to.equal(true);
    expect(Number(gotType)).to.equal(FieldType.UINT256);
    expect(gotData).to.equal(encFor(FieldType.UINT256, amount));
    expect(coder.decode(["uint256"], gotData)[0]).to.equal(amount);
  });

  it("deploys a genuine EIP-1167 minimal-proxy clone (runtime bytecode embeds the impl)", async () => {
    const { factory, implAddr } = await deployFactory();
    const [owner] = await ethers.getSigners();

    const clone = await createAgreement(factory, owner, []);
    const code = (await ethers.provider.getCode(clone)).toLowerCase();

    // Canonical EIP-1167 minimal proxy: 10-byte prefix + 20-byte impl + 15-byte suffix.
    const prefix = "0x363d3d373d3d3d363d73";
    const suffix = "5af43d82803e903d91602b57fd5bf3";
    const implNoPrefix = implAddr.replace(/^0x/, "");
    expect(code).to.equal(prefix + implNoPrefix + suffix);
    expect((code.length - 2) / 2).to.equal(45); // 45-byte minimal proxy
  });

  it("pins the legacy enum ordinals: UINT256..BYTES32 = 0..4, BYTES = 5", () => {
    // The wire ordinal is load-bearing: stored-var values and clone storage are
    // parity-comparable with the legacy engine only because these ordinals match.
    expect(FieldType.UINT256).to.equal(0);
    expect(FieldType.STRING).to.equal(1);
    expect(FieldType.ADDRESS).to.equal(2);
    expect(FieldType.BOOL).to.equal(3);
    expect(FieldType.BYTES32).to.equal(4);
    expect(FieldType.BYTES).to.equal(5);
  });
});
