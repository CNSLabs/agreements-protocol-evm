/**
 * AgreementEngine — FieldType unification (R2 hardening).
 *
 * The engine must use the single AgreementTypes.FieldType (which includes BYTES) rather
 * than a duplicate enum ending at BYTES32. These assert:
 *   - legacy ordinals are preserved (UINT256..BYTES32 = 0..4), so stored-var uint8 values
 *     and storage layout are unaffected (parity guarantee);
 *   - BYTES (ordinal 5) is a valid storable/comparable type: a BYTES init var round-trips
 *     through getVar with fType == 5 and exact data.
 */

import { expect } from "chai";
import { ethers } from "hardhat";
import { FieldType, encFor, coder } from "../helpers/value-lib";

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
  return factory;
}

const S0 = ethers.id("S0");

async function createWithInitVars(factory: any, owner: any, initVars: Array<[string, number, string]>) {
  const docUri = "ipfs://ft";
  const docHash = ethers.id("ft");
  const ivTuples = initVars.map(([id, fType, data]) => [id, fType, data]);
  // Composable init: empty inputDefs/transitions/actions/canonicalConds/verifiers.
  const args = [docUri, docHash, S0, [], [], ivTuples, [], [], []] as const;
  const predicted = await factory.connect(owner).createAgreement.staticCall(...args);
  await (await factory.connect(owner).createAgreement(...args)).wait();
  return ethers.getContractAt("AgreementEngine", predicted);
}

describe("AgreementEngine — FieldType unification preserves legacy ordinals", () => {
  it("stores and reads back each legacy-ordinal type via getVar (UINT256..BYTES32)", async () => {
    const factory = await deployFactory();
    const [owner] = await ethers.getSigners();
    const ADDR = ethers.getAddress("0x000000000000000000000000000000000000a11e");
    const B32 = ethers.id("ft-b32");
    const vars: Array<[string, number, string]> = [
      [ethers.id("u"), FieldType.UINT256, encFor(FieldType.UINT256, 123n)],
      [ethers.id("s"), FieldType.STRING, encFor(FieldType.STRING, "hello")],
      [ethers.id("a"), FieldType.ADDRESS, encFor(FieldType.ADDRESS, ADDR)],
      [ethers.id("b"), FieldType.BOOL, encFor(FieldType.BOOL, true)],
      [ethers.id("h"), FieldType.BYTES32, encFor(FieldType.BYTES32, B32)],
    ];
    const engine = await createWithInitVars(factory, owner, vars);
    for (const [id, fType, data] of vars) {
      const [set, gotType, gotData] = await engine.getVar(id);
      expect(set).to.equal(true);
      expect(Number(gotType)).to.equal(fType);
      expect(gotData).to.equal(data);
    }
  });
});

describe("AgreementEngine — BYTES (canonical ordinal 5) is a storable type", () => {
  it("a BYTES init var round-trips through getVar with fType == 5", async () => {
    const factory = await deployFactory();
    const [owner] = await ethers.getSigners();
    const bytesId = ethers.id("blob");
    const bytesData = encFor(FieldType.BYTES, "0xdeadbeefcafe");
    const engine = await createWithInitVars(factory, owner, [[bytesId, FieldType.BYTES, bytesData]]);
    const [set, gotType, gotData] = await engine.getVar(bytesId);
    expect(set).to.equal(true);
    expect(Number(gotType)).to.equal(FieldType.BYTES); // 5
    expect(gotData).to.equal(bytesData);
    // and decodes back to the original payload
    expect(coder.decode(["bytes"], gotData)[0]).to.equal("0xdeadbeefcafe");
  });
});
