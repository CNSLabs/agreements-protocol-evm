// SPDX-License-Identifier: Apache-2.0

import { expect } from "chai";
import { ethers } from "hardhat";

describe("AgreementsProtocol", function () {
  async function deployProtocol() {
    const [owner] = await ethers.getSigners();
    const implementation = await ethers.deployContract("AgreementEngine");
    await implementation.waitForDeployment();

    const factory = await ethers.deployContract("AgreementFactory", [
      await implementation.getAddress(),
    ]);
    await factory.waitForDeployment();

    return { owner, implementation, factory };
  }

  it("stores verifier registrations during initialization", async function () {
    const { owner, factory } = await deployProtocol();
    const verifier = await ethers.deployContract("MockInputVerifier");
    await verifier.waitForDeployment();

    const docUri = "ipfs://agreement/test";
    const docHash = ethers.keccak256(ethers.toUtf8Bytes("doc"));
    const initialState = ethers.keccak256(ethers.toUtf8Bytes("INITIAL"));
    const verifierKey = ethers.keccak256(ethers.toUtf8Bytes("kyc"));

    const inputDefs: any[] = [];
    const transitions: any[] = [];
    const initVars: any[] = [];
    const verifiers = [{ key: verifierKey, verifier: await verifier.getAddress() }];
    const actions: any[] = [];

    const agreementAddress = await factory.createAgreement.staticCall(
      docUri,
      docHash,
      initialState,
      inputDefs,
      transitions,
      initVars,
      verifiers,
      actions
    );

    await expect(
      factory.createAgreement(
        docUri,
        docHash,
        initialState,
        inputDefs,
        transitions,
        initVars,
        verifiers,
        actions
      )
    )
      .to.emit(factory, "AgreementDeployed")
      .withArgs(agreementAddress, owner.address, docUri, docHash);

    const agreement = await ethers.getContractAt(
      "AgreementEngine",
      agreementAddress
    );
    expect(await agreement.verifierRegistry(verifierKey)).to.equal(
      await verifier.getAddress()
    );
  });

  it("rejects input definitions that reference unknown verifier keys", async function () {
    const { implementation, factory } = await deployProtocol();

    const docUri = "ipfs://agreement/test";
    const docHash = ethers.keccak256(ethers.toUtf8Bytes("doc"));
    const initialState = ethers.keccak256(ethers.toUtf8Bytes("INITIAL"));
    const unknownVerifierKey = ethers.keccak256(ethers.toUtf8Bytes("missing"));
    const inputId = ethers.keccak256(ethers.toUtf8Bytes("submit"));

    const inputDefs = [
      {
        id: inputId,
        fields: [],
        conditions: [],
        verifierKeys: [unknownVerifierKey],
      },
    ];

    await expect(
      factory.createAgreement(
        docUri,
        docHash,
        initialState,
        inputDefs,
        [],
        [],
        [],
        []
      )
    )
      .to.be.revertedWithCustomError(implementation, "UnknownVerifier")
      .withArgs(unknownVerifierKey);
  });
});
