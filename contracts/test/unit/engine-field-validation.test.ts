/**
 * Engine field-validation hardening — two related init/submit fixes.
 *
 * FIX 1 (persist-implies-required): `_persistFields` assumes "we already enforced
 * required = true in _validateFields", but nothing enforced it. A field declared
 * persist=true/required=false could be omitted on a later submission, leaving its
 * VAR at a stale prior value while a skipIfAbsent guard is skipped. The fix rejects
 * such a config AT INIT with PersistRequiresRequired, so the invariant actually holds.
 *
 * FIX 2 (non-canonical STRING/BYTES storage): init vars (_storeInitVars) and persisted
 * fields (_persistFields) previously stored raw caller-supplied bytes for STRING/BYTES
 * without canonical validation — only the DECODED length was capped. A value could decode
 * to a short string while carrying a huge trailing blob, bypassing the dynamic-value cap
 * and bloating storage. The fix applies ValueLib's canonical-encoding discipline (cap raw
 * length, decode, cap decoded length, re-encode, require exact byte equality) to both
 * paths, rejecting non-canonical bytes and storing only the canonical encoding.
 */

import { expect } from "chai";
import { ethers } from "hardhat";
import type { AgreementEngine } from "../../typechain-types";
import { FieldType, encFor, coder, type FieldTypeVal } from "../helpers/value-lib";

const S0 = ethers.id("S0");
const S1 = ethers.id("S1");

// DataField[] tuple shape accepted by submitInput's abi.decode.
const DATA_FIELD_ARRAY_ABI = ["tuple(bytes32 id, uint8 fType, bytes data)[]"];

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
  // `impl` doubles as the error-ABI source for revertedWithCustomError assertions: the engine
  // ABI carries PersistRequiresRequired / MalformedValue / ConfigCapExceeded.
  return { factory, impl: impl as unknown as AgreementEngine };
}

async function engineAt(addr: string): Promise<AgreementEngine> {
  return (await ethers.getContractAt("AgreementEngine", addr)) as unknown as AgreementEngine;
}

/** Create an agreement clone (returns the predicted clone address). */
async function createAgreement(
  factory: any,
  owner: any,
  initVars: any[],
  inputDefs: any[] = [],
  transitions: any[] = []
): Promise<string> {
  const docUri = "ipfs://field-validation";
  const docHash = ethers.id("field-validation");
  // InputDef init shape is [id, fields, verifierKeys] (no conditions).
  const inputDefInits = inputDefs.map((d: any[]) => (d.length === 4 ? [d[0], d[1], d[3]] : d));
  const args = [docUri, docHash, S0, inputDefInits, transitions, initVars, [], [], []] as const;
  const predicted = await factory.connect(owner).createAgreement.staticCall(...args);
  await (await factory.connect(owner).createAgreement(...args)).wait();
  return predicted;
}

/** Same as createAgreement but returns the (un-awaited) create tx promise for revert assertions. */
function createAgreementTx(
  factory: any,
  owner: any,
  initVars: any[],
  inputDefs: any[] = [],
  transitions: any[] = []
) {
  const docUri = "ipfs://field-validation";
  const docHash = ethers.id("field-validation");
  const inputDefInits = inputDefs.map((d: any[]) => (d.length === 4 ? [d[0], d[1], d[3]] : d));
  const args = [docUri, docHash, S0, inputDefInits, transitions, initVars, [], [], []] as const;
  return factory.connect(owner).createAgreement(...args);
}

// A non-canonical STRING encoding: decodes to "hi" but carries a trailing junk word the
// canonical abi.encode("hi") would not include. offset=0x20, length=2, "hi" padded, then
// an extra 32-byte trailing word (the "blob").
function nonCanonicalString(): string {
  const canonical = encFor(FieldType.STRING, "hi"); // 0x + offset + len + padded "hi"
  const trailingBlob = "ff".repeat(32);
  return canonical + trailingBlob;
}

// A non-canonical BYTES encoding: decodes to 0xdead but carries a trailing junk word.
function nonCanonicalBytes(): string {
  const canonical = encFor(FieldType.BYTES, "0xdead");
  const trailingBlob = "ab".repeat(32);
  return canonical + trailingBlob;
}

describe("AgreementEngine — FIX 1: persist=true requires required=true at init", () => {
  const inputId = ethers.id("setAmount");
  const amountFieldId = ethers.id("amount");

  it("rejects a config with a persist=true / required=false field (PersistRequiresRequired)", async () => {
    const { factory, impl } = await deployFactory();
    const [owner] = await ethers.getSigners();

    const inputDefs = [
      [
        inputId,
        [[amountFieldId, FieldType.UINT256, /*required*/ false, /*persist*/ true]],
        [],
        [],
      ],
    ];
    const transitions = [[S0, S1, inputId]];

    await expect(createAgreementTx(factory, owner, [], inputDefs, transitions))
      .to.be.revertedWithCustomError(impl, "PersistRequiresRequired")
      .withArgs(inputId, amountFieldId);
  });

  it("accepts persist=true / required=true and persists end to end (regression)", async () => {
    const { factory } = await deployFactory();
    const [owner] = await ethers.getSigners();

    const inputDefs = [
      [
        inputId,
        [[amountFieldId, FieldType.UINT256, /*required*/ true, /*persist*/ true]],
        [],
        [],
      ],
    ];
    const transitions = [[S0, S1, inputId]];

    const engine = await engineAt(
      await createAgreement(factory, owner, [], inputDefs, transitions)
    );

    const amount = 7777n;
    const payload = coder.encode(DATA_FIELD_ARRAY_ABI, [
      [[amountFieldId, FieldType.UINT256, encFor(FieldType.UINT256, amount)]],
    ]);
    await (await engine.connect(owner).submitInput(inputId, payload)).wait();

    expect(await engine.currentState()).to.equal(S1);
    const [set, , gotData] = await engine.getVar(amountFieldId);
    expect(set).to.equal(true);
    expect(coder.decode(["uint256"], gotData)[0]).to.equal(amount);
  });

  it("accepts persist=false / required=false (a plain optional field)", async () => {
    const { factory } = await deployFactory();
    const [owner] = await ethers.getSigners();

    const inputDefs = [
      [
        inputId,
        [[amountFieldId, FieldType.UINT256, /*required*/ false, /*persist*/ false]],
        [],
        [],
      ],
    ];
    const transitions = [[S0, S1, inputId]];

    // Must not revert at init.
    await createAgreement(factory, owner, [], inputDefs, transitions);
  });
});

describe("AgreementEngine — FIX 2: non-canonical STRING/BYTES rejected", () => {
  it("rejects a non-canonical STRING init var (trailing blob) at init", async () => {
    const { factory, impl } = await deployFactory();
    const [owner] = await ethers.getSigners();

    const initVars = [[ethers.id("note"), FieldType.STRING, nonCanonicalString()]];
    await expect(createAgreementTx(factory, owner, initVars))
      .to.be.revertedWithCustomError(impl, "MalformedValue")
      .withArgs(FieldType.STRING);
  });

  it("rejects a non-canonical BYTES init var (trailing blob) at init", async () => {
    const { factory, impl } = await deployFactory();
    const [owner] = await ethers.getSigners();

    const initVars = [[ethers.id("blob"), FieldType.BYTES, nonCanonicalBytes()]];
    await expect(createAgreementTx(factory, owner, initVars))
      .to.be.revertedWithCustomError(impl, "MalformedValue")
      .withArgs(FieldType.BYTES);
  });

  it("accepts canonical STRING / BYTES init vars and stores them canonically (regression)", async () => {
    const { factory } = await deployFactory();
    const [owner] = await ethers.getSigners();

    const strId = ethers.id("note");
    const bytesId = ethers.id("blob");
    const strVal = "hello, agreement";
    const bytesVal = "0xdeadbeefcafe";
    const initVars = [
      [strId, FieldType.STRING, encFor(FieldType.STRING, strVal)],
      [bytesId, FieldType.BYTES, encFor(FieldType.BYTES, bytesVal)],
    ];

    const engine = await engineAt(await createAgreement(factory, owner, initVars));

    const [sSet, , sData] = await engine.getVar(strId);
    expect(sSet).to.equal(true);
    expect(sData).to.equal(encFor(FieldType.STRING, strVal));

    const [bSet, , bData] = await engine.getVar(bytesId);
    expect(bSet).to.equal(true);
    expect(bData).to.equal(encFor(FieldType.BYTES, bytesVal));
  });

  it("rejects a non-canonical STRING submitted to a persisted field (trailing blob) at submit", async () => {
    const { factory, impl } = await deployFactory();
    const [owner] = await ethers.getSigners();

    const inputId = ethers.id("setNote");
    const noteFieldId = ethers.id("note");
    const inputDefs = [
      [
        inputId,
        [[noteFieldId, FieldType.STRING, /*required*/ true, /*persist*/ true]],
        [],
        [],
      ],
    ];
    const transitions = [[S0, S1, inputId]];

    const engine = await engineAt(
      await createAgreement(factory, owner, [], inputDefs, transitions)
    );

    const payload = coder.encode(DATA_FIELD_ARRAY_ABI, [
      [[noteFieldId, FieldType.STRING, nonCanonicalString()]],
    ]);
    await expect(engine.connect(owner).submitInput(inputId, payload))
      .to.be.revertedWithCustomError(impl, "MalformedValue")
      .withArgs(FieldType.STRING);
  });

  it("persists a canonical STRING field end to end (regression)", async () => {
    const { factory } = await deployFactory();
    const [owner] = await ethers.getSigners();

    const inputId = ethers.id("setNote");
    const noteFieldId = ethers.id("note");
    const inputDefs = [
      [
        inputId,
        [[noteFieldId, FieldType.STRING, /*required*/ true, /*persist*/ true]],
        [],
        [],
      ],
    ];
    const transitions = [[S0, S1, inputId]];

    const engine = await engineAt(
      await createAgreement(factory, owner, [], inputDefs, transitions)
    );

    const note = "all good";
    const payload = coder.encode(DATA_FIELD_ARRAY_ABI, [
      [[noteFieldId, FieldType.STRING, encFor(FieldType.STRING, note)]],
    ]);
    await (await engine.connect(owner).submitInput(inputId, payload)).wait();

    expect(await engine.currentState()).to.equal(S1);
    const [set, , gotData] = await engine.getVar(noteFieldId);
    expect(set).to.equal(true);
    expect(gotData).to.equal(encFor(FieldType.STRING, note));
    expect(coder.decode(["string"], gotData)[0]).to.equal(note);
  });
});
