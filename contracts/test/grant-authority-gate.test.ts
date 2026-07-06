// SPDX-License-Identifier: Apache-2.0
//
// The authority verifier on a REALISTIC grant workflow (not the minimal FSM). A grant-with-feedback
// agreement's load-bearing authority requirement is: only an authorized reviewer may ACCEPT a milestone
// (that triggers payout). Here the `acceptWork` input is gated by the on-chain AuthorityInputVerifier,
// so an unattested party's acceptance REVERTS on-chain while the attested reviewer's passes. Mirrors the
// real grant-with-feedback states (AWAITING_WORK → WORK_IN_REVIEW → WORK_ACCEPTED).

import { expect } from "chai";
import { ethers } from "hardhat";
import { AgreementEngine, MockErc8004Registry } from "../typechain-types";

const k = (s: string) => ethers.keccak256(ethers.toUtf8Bytes(s));
const EMPTY = ethers.AbiCoder.defaultAbiCoder().encode(["tuple(bytes32,uint8,bytes)[]"], [[]]);

describe("authority gate on a grant-with-feedback workflow", function () {
  const AWAITING_WORK = k("AWAITING_WORK");
  const WORK_IN_REVIEW = k("WORK_IN_REVIEW");
  const WORK_ACCEPTED = k("WORK_ACCEPTED");
  const SUBMIT_WORK = k("submitWork");
  const ACCEPT_WORK = k("acceptWork");
  const AUTH_KEY = k("reviewerAuthority");
  const ROLE_REVIEWER = k("role:reviewer");

  async function deploy() {
    const [, recipient, reviewer, imposter] = await ethers.getSigners();

    const impl = await ethers.deployContract("AgreementEngine");
    await impl.waitForDeployment();
    const factory = await ethers.deployContract("AgreementFactory", [await impl.getAddress()]);
    await factory.waitForDeployment();

    const registry = (await ethers.deployContract("MockErc8004Registry")) as unknown as MockErc8004Registry;
    await registry.waitForDeployment();
    // Only the reviewer holds the "role:reviewer" validation (min reputation 0).
    const verifier = await ethers.deployContract("AuthorityInputVerifier", [await registry.getAddress(), 0, ROLE_REVIEWER]);
    await verifier.waitForDeployment();

    const inputDefs = [
      { id: SUBMIT_WORK, fields: [], conditions: [], verifierKeys: [] }, // anyone (the recipient) submits
      { id: ACCEPT_WORK, fields: [], conditions: [], verifierKeys: [AUTH_KEY] }, // only an attested reviewer accepts
    ];
    const transitions = [
      { fromState: AWAITING_WORK, toState: WORK_IN_REVIEW, inputId: SUBMIT_WORK },
      { fromState: WORK_IN_REVIEW, toState: WORK_ACCEPTED, inputId: ACCEPT_WORK },
    ];
    const verifiers = [{ key: AUTH_KEY, verifier: await verifier.getAddress() }];

    const addr = await factory.createAgreement.staticCall(
      "ipfs://grant", k("doc"), AWAITING_WORK, inputDefs, transitions, [], verifiers, []
    );
    await factory.createAgreement("ipfs://grant", k("doc"), AWAITING_WORK, inputDefs, transitions, [], verifiers, []);
    const agreement = (await ethers.getContractAt("AgreementEngine", addr)) as unknown as AgreementEngine;

    return { recipient, reviewer, imposter, registry, verifier, agreement };
  }

  it("gates milestone acceptance — imposter reverts on-chain, attested reviewer accepts", async function () {
    const { recipient, reviewer, imposter, registry, verifier, agreement } = await deploy();

    // recipient submits work (ungated) → WORK_IN_REVIEW
    await agreement.connect(recipient).submitInput(SUBMIT_WORK, EMPTY);
    expect(await agreement.currentState()).to.equal(WORK_IN_REVIEW);

    // an unattested imposter tries to ACCEPT (and would trigger payout) → REVERTS on-chain
    await expect(agreement.connect(imposter).submitInput(ACCEPT_WORK, EMPTY))
      .to.be.revertedWithCustomError(verifier, "NotRegistered")
      .withArgs(imposter.address);
    expect(await agreement.currentState()).to.equal(WORK_IN_REVIEW); // not advanced

    // a registered-but-non-reviewer is also rejected (missing the role attestation)
    await registry.register(imposter.address, 100);
    await expect(agreement.connect(imposter).submitInput(ACCEPT_WORK, EMPTY))
      .to.be.revertedWithCustomError(verifier, "MissingValidation")
      .withArgs(imposter.address, ROLE_REVIEWER);

    // the attested reviewer accepts → WORK_ACCEPTED
    await registry.register(reviewer.address, 100);
    await registry.addValidation(reviewer.address, ROLE_REVIEWER);
    await expect(agreement.connect(reviewer).submitInput(ACCEPT_WORK, EMPTY)).to.emit(agreement, "InputAccepted");
    expect(await agreement.currentState()).to.equal(WORK_ACCEPTED);
  });
});
