// SPDX-License-Identifier: Apache-2.0
//
// v2 — on-chain authority enforcement trace.
//
// Proves the fix for: "if the resolver is off-chain and bypassable by direct RPC, what on-chain stops
// an unauthorized transition?" Answer: a real IInputVerifier registered in the agreement's verifierKeys.
// The engine calls it on every submitInput and the transition REVERTS if the sender fails the policy —
// direct-RPC included, because the engine itself invokes the verifier. This is the on-chain twin of the
// off-chain Erc8004AuthorityResolver (cns-service a2a slice): same policy, enforced not advised.

import { expect } from "chai";
import { ethers } from "hardhat";
import { AgreementEngine } from "../typechain-types";

const k = (s: string) => ethers.keccak256(ethers.toUtf8Bytes(s));
// submitInput payload = abi.encode(DataField[]); this input has no fields, so an empty array.
const EMPTY_PAYLOAD = ethers.AbiCoder.defaultAbiCoder().encode(["tuple(bytes32,uint8,bytes)[]"], [[]]);

describe("on-chain authority enforcement (AuthorityInputVerifier / v2)", function () {
  const START = k("START");
  const DONE = k("DONE");
  const ADVANCE = k("advance");
  const AUTH_KEY = k("authority");
  const MIN_REP = 50n;
  const REQUIRED_VALIDATION = k("role:party");

  async function deploy() {
    const [owner, agent, attacker] = await ethers.getSigners();

    const impl = await ethers.deployContract("AgreementEngine");
    await impl.waitForDeployment();
    const factory = await ethers.deployContract("AgreementFactory", [await impl.getAddress()]);
    await factory.waitForDeployment();

    const registry = await ethers.deployContract("MockErc8004Registry");
    await registry.waitForDeployment();

    const verifier = await ethers.deployContract("AuthorityInputVerifier", [
      await registry.getAddress(),
      MIN_REP,
      REQUIRED_VALIDATION,
    ]);
    await verifier.waitForDeployment();

    // Minimal FSM: START --advance--> DONE, where `advance` is gated ONLY by the authority verifier
    // (no SENDER conditions), so the verifier is the sole authority gate — any address may attempt it.
    const inputDefs = [{ id: ADVANCE, fields: [], conditions: [], verifierKeys: [AUTH_KEY] }];
    const transitions = [{ fromState: START, toState: DONE, inputId: ADVANCE }];
    const verifiers = [{ key: AUTH_KEY, verifier: await verifier.getAddress() }];

    const agreementAddress = await factory.createAgreement.staticCall(
      "ipfs://authority-trace", k("doc"), START, inputDefs, transitions, [], verifiers, []
    );
    await factory.createAgreement(
      "ipfs://authority-trace", k("doc"), START, inputDefs, transitions, [], verifiers, []
    );
    const agreement = (await ethers.getContractAt(
      "AgreementEngine",
      agreementAddress
    )) as unknown as AgreementEngine;

    return { owner, agent, attacker, registry, verifier, agreement };
  }

  it("REVERTS a direct-RPC submitInput from an unregistered sender", async function () {
    const { agreement, attacker, verifier } = await deploy();
    await expect(agreement.connect(attacker).submitInput(ADVANCE, EMPTY_PAYLOAD))
      .to.be.revertedWithCustomError(verifier, "NotRegistered")
      .withArgs(attacker.address);
    expect(await agreement.currentState()).to.equal(START); // state did not advance
  });

  it("REVERTS a sender registered but below the reputation floor", async function () {
    const { agreement, agent, registry, verifier } = await deploy();
    await registry.register(agent.address, 30); // 30 < 50
    await expect(agreement.connect(agent).submitInput(ADVANCE, EMPTY_PAYLOAD))
      .to.be.revertedWithCustomError(verifier, "BelowReputation")
      .withArgs(agent.address, 30, MIN_REP);
    expect(await agreement.currentState()).to.equal(START);
  });

  it("REVERTS a reputable sender missing the required validation", async function () {
    const { agreement, agent, registry, verifier } = await deploy();
    await registry.register(agent.address, 80); // meets reputation, but no validation attestation
    await expect(agreement.connect(agent).submitInput(ADVANCE, EMPTY_PAYLOAD))
      .to.be.revertedWithCustomError(verifier, "MissingValidation")
      .withArgs(agent.address, REQUIRED_VALIDATION);
    expect(await agreement.currentState()).to.equal(START);
  });

  it("PASSES a registered, reputable, attested sender — the transition applies on-chain", async function () {
    const { agreement, agent, registry } = await deploy();
    await registry.register(agent.address, 80);
    await registry.addValidation(agent.address, REQUIRED_VALIDATION);
    await expect(agreement.connect(agent).submitInput(ADVANCE, EMPTY_PAYLOAD))
      .to.emit(agreement, "InputAccepted");
    expect(await agreement.currentState()).to.equal(DONE); // authorized → state advanced
  });

  it("REVERTS after the sender's registration is revoked (on-chain off-switch)", async function () {
    const { agreement, agent, registry, verifier } = await deploy();
    await registry.register(agent.address, 80);
    await registry.addValidation(agent.address, REQUIRED_VALIDATION);
    await registry.revoke(agent.address); // revoke → the same signer is now blocked on-chain
    await expect(agreement.connect(agent).submitInput(ADVANCE, EMPTY_PAYLOAD))
      .to.be.revertedWithCustomError(verifier, "NotRegistered")
      .withArgs(agent.address);
    expect(await agreement.currentState()).to.equal(START);
  });
});
