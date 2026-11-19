// SPDX-License-Identifier: Apache-2.0
//
// Adversarial regression tests for the V1.1 security release. Each test states
// an attack that succeeded before its fix and asserts that it is now refused.

import { expect } from "chai";
import { ethers } from "hardhat";

const id = (s: string) => ethers.keccak256(ethers.toUtf8Bytes(s));
const coder = ethers.AbiCoder.defaultAbiCoder();
const hash = (type: string, value: unknown) => ethers.keccak256(coder.encode([type], [value]));
const emptyPayload = coder.encode(["tuple(bytes32 id,uint8 fType,bytes data)[]"], [[]]);

const INPUT_DEFS =
  "tuple(bytes32 id,tuple(bytes32 fieldId,uint8 fType,bool required,bool persist)[] fields,tuple(uint8 op,bytes32 fieldId,bytes bytesArg)[] conditions,bytes32[] verifierKeys)[]";
const TRANSITIONS = "tuple(bytes32 fromState,bytes32 toState,bytes32 inputId)[]";
const INIT_VARS = "tuple(bytes32 id,uint8 fType,bytes data)[]";
const VERIFIERS = "tuple(bytes32 key,address verifier)[]";
const ACTIONS = "tuple(bytes32 fromState,bytes32 inputId,address target,uint256 value,bytes data)[]";

const CREATION_FIELDS = [
  { name: "signer", type: "address" },
  { name: "docUri", type: "string" },
  { name: "docHash", type: "bytes32" },
  { name: "initialState", type: "bytes32" },
  { name: "inputDefsHash", type: "bytes32" },
  { name: "transitionsHash", type: "bytes32" },
  { name: "initVarsHash", type: "bytes32" },
  { name: "verifiersHash", type: "bytes32" },
  { name: "actionsHash", type: "bytes32" },
];
const TAIL = [
  { name: "nonce", type: "uint256" },
  { name: "deadline", type: "uint256" },
];
const PERMIT_INPUT = [
  { name: "signer", type: "address" },
  { name: "inputId", type: "bytes32" },
  { name: "payload", type: "bytes" },
  ...TAIL,
];

type Deployment = {
  docUri: string;
  docHash: string;
  initialState: string;
  inputDefs: any[];
  transitions: any[];
  initVars: any[];
  verifiers: any[];
  actions: any[];
};

const deploymentHashes = (d: Deployment) => ({
  docUri: d.docUri,
  docHash: d.docHash,
  initialState: d.initialState,
  inputDefsHash: hash(INPUT_DEFS, d.inputDefs),
  transitionsHash: hash(TRANSITIONS, d.transitions),
  initVarsHash: hash(INIT_VARS, d.initVars),
  verifiersHash: hash(VERIFIERS, d.verifiers),
  actionsHash: hash(ACTIONS, d.actions),
});
const createArgs = (d: Deployment) =>
  [d.docUri, d.docHash, d.initialState, d.inputDefs, d.transitions, d.initVars, d.verifiers, d.actions] as const;

describe("AgreementsProtocol (adversarial)", function () {
  async function deployProtocol() {
    const implementation = await ethers.deployContract("AgreementEngine");
    await implementation.waitForDeployment();
    const factory: any = await ethers.deployContract("AgreementFactory", [
      await implementation.getAddress(),
    ]);
    await factory.waitForDeployment();
    const network = await ethers.provider.getNetwork();
    const factoryDomain = {
      name: "AgreementFactory",
      version: "1",
      chainId: network.chainId,
      verifyingContract: await factory.getAddress(),
    };
    const engineDomain = (agreement: string) => ({
      name: "AgreementEngine",
      version: "1",
      chainId: network.chainId,
      verifyingContract: agreement,
    });
    const deadline = (await ethers.provider.getBlock("latest"))!.timestamp + 3600;
    return { implementation, factory, factoryDomain, engineDomain, deadline };
  }

  const empty = (name: string): Deployment => ({
    docUri: `ipfs://${name}`,
    docHash: id(name),
    initialState: id("S0"),
    inputDefs: [],
    transitions: [],
    initVars: [],
    verifiers: [],
    actions: [],
  });

  describe("deterministic addresses are reserved for their creator", function () {
    it("an account that learns a salt cannot take the address predicted for another account", async function () {
      const { factory } = await deployProtocol();
      const [victim, attacker] = await ethers.getSigners();
      const salt = id("victim-salt");
      const predicted = await factory.predictAddress(victim.address, salt);

      // The attacker front-runs with the same salt and its own agreement.
      const attackerAddress = await factory
        .connect(attacker)
        .createAgreementDeterministic.staticCall(salt, ...createArgs(empty("attacker")));
      await factory.connect(attacker).createAgreementDeterministic(salt, ...createArgs(empty("attacker")));

      expect(attackerAddress).to.not.equal(predicted);
      expect(attackerAddress).to.equal(await factory.predictAddress(attacker.address, salt));
      expect(await ethers.provider.getCode(predicted)).to.equal("0x");

      // The victim still gets the address it predicted, as owner.
      await expect(factory.connect(victim).createAgreementDeterministic(salt, ...createArgs(empty("victim"))))
        .to.emit(factory, "AgreementDeployed")
        .withArgs(predicted, victim.address, "ipfs://victim", id("victim"));
      expect(await (await ethers.getContractAt("AgreementEngine", predicted)).owner()).to.equal(victim.address);
    });

    it("the direct path cannot take the address a signer's deterministic permit names", async function () {
      const { factory, factoryDomain, deadline } = await deployProtocol();
      const [signer, attacker, relayer] = await ethers.getSigners();
      const salt = id("signed-salt");
      const deployment = empty("signed");
      const predicted = await factory.predictAddress(signer.address, salt);
      const signature = await signer.signTypedData(
        factoryDomain,
        {
          PermitDeterministicAgreementWithActions: [
            ...CREATION_FIELDS,
            { name: "salt", type: "bytes32" },
            { name: "predictedAgreement", type: "address" },
            ...TAIL,
          ],
        },
        {
          signer: signer.address,
          ...deploymentHashes(deployment),
          salt,
          predictedAgreement: predicted,
          nonce: 0n,
          deadline,
        }
      );

      // The attacker sees the permit in the mempool and uses its salt directly.
      await factory.connect(attacker).createAgreementDeterministic(salt, ...createArgs(empty("attacker")));
      expect(await ethers.provider.getCode(predicted)).to.equal("0x");

      // The permit still creates the signer's agreement at the signed address.
      await expect(
        factory
          .connect(relayer)
          .createAgreementDeterministicWithPermit(signer.address, salt, ...createArgs(deployment), deadline, signature)
      )
        .to.emit(factory, "AgreementCreatedWithPermit")
        .withArgs(predicted, signer.address, relayer.address);
      expect(await (await ethers.getContractAt("AgreementEngine", predicted)).owner()).to.equal(signer.address);
    });

    it("a creator's own salt still cannot be used twice", async function () {
      const { factory } = await deployProtocol();
      const [creator] = await ethers.getSigners();
      const salt = id("once");
      await factory.connect(creator).createAgreementDeterministic(salt, ...createArgs(empty("first")));
      await expect(
        factory.connect(creator).createAgreementDeterministic(salt, ...createArgs(empty("second")))
      ).to.be.reverted;
    });

    it("a deterministic permit deploys only the signed agreement at the signed address", async function () {
      const { factory, factoryDomain, deadline } = await deployProtocol();
      const [signer, relayer] = await ethers.getSigners();
      const salt = id("permit-salt");
      const agreed = empty("permit-terms");
      const predicted = await factory.predictAddress(signer.address, salt);
      const signature = await signer.signTypedData(
        factoryDomain,
        {
          PermitDeterministicAgreementWithActions: [
            ...CREATION_FIELDS,
            { name: "salt", type: "bytes32" },
            { name: "predictedAgreement", type: "address" },
            ...TAIL,
          ],
        },
        { signer: signer.address, ...deploymentHashes(agreed), salt, predictedAgreement: predicted, nonce: 0n, deadline }
      );

      // A relayer that swaps the terms is refused.
      const altered = { ...agreed, initVars: [{ id: id("amount"), fType: 0, data: coder.encode(["uint256"], [1n]) }] };
      await expect(
        factory
          .connect(relayer)
          .createAgreementDeterministicWithPermit(signer.address, salt, ...createArgs(altered), deadline, signature)
      ).to.be.revertedWithCustomError(factory, "InvalidSignature");

      await expect(
        factory
          .connect(relayer)
          .createAgreementDeterministicWithPermit(signer.address, salt, ...createArgs(agreed), deadline, signature)
      )
        .to.emit(factory, "AgreementCreatedWithPermit")
        .withArgs(predicted, signer.address, relayer.address);
    });
  });

  describe("input permits are single-use per signer and do not depend on other signers", function () {
    const signA = id("partyASign");
    const signB = id("partyBSign");
    const [S0, A_SIGNED, B_SIGNED, SIGNED] = [id("S0"), id("A_SIGNED"), id("B_SIGNED"), id("SIGNED")];
    const hashPayload = (fieldId: string, documentHash: string) =>
      coder.encode(
        ["tuple(bytes32 id,uint8 fType,bytes data)[]"],
        [[{ id: fieldId, fType: 4, data: coder.encode(["bytes32"], [documentHash]) }]]
      );

    // Two parties approve one pinned document. Either may go first.
    async function deployTwoSigner(factory: any, partyA: string, partyB: string) {
      // SENDER_EQ_VAR_ADDRESS: the sender, or the permit's signer, must be the stored party
      const issuer = (partyVar: string) => ({ op: 16, fieldId: partyVar, bytesArg: "0x" });
      const partyVar = (name: string, party: string) => ({
        id: id(name),
        fType: 2,
        data: coder.encode(["address"], [party]),
      });
      const deployment: Deployment = {
        ...empty("two-signer"),
        initialState: S0,
        inputDefs: [
          {
            id: signA,
            fields: [{ fieldId: id("aHash"), fType: 4, required: true, persist: true }],
            conditions: [issuer(id("partyA"))],
            verifierKeys: [],
          },
          {
            id: signB,
            fields: [{ fieldId: id("bHash"), fType: 4, required: true, persist: true }],
            conditions: [issuer(id("partyB"))],
            verifierKeys: [],
          },
        ],
        initVars: [partyVar("partyA", partyA), partyVar("partyB", partyB)],
        transitions: [
          { fromState: S0, toState: A_SIGNED, inputId: signA },
          { fromState: S0, toState: B_SIGNED, inputId: signB },
          { fromState: A_SIGNED, toState: SIGNED, inputId: signB },
          { fromState: B_SIGNED, toState: SIGNED, inputId: signA },
        ],
      };
      const address = await factory.createAgreement.staticCall(...createArgs(deployment));
      await factory.createAgreement(...createArgs(deployment));
      return (await ethers.getContractAt("AgreementEngine", address)) as any;
    }

    const signInput = (signer: any, domain: any, inputId: string, payload: string, nonce: bigint, deadline: number) =>
      signer.signTypedData(
        domain,
        { PermitInput: PERMIT_INPUT },
        { signer: signer.address, inputId, payload, nonce, deadline }
      );

    for (const first of ["A", "B"] as const) {
      it(`two parties sign up front and party ${first}'s permit can be submitted first`, async function () {
        const { factory, engineDomain, deadline } = await deployProtocol();
        const [partyA, partyB, relayer] = await ethers.getSigners();
        const agreement = await deployTwoSigner(factory, partyA.address, partyB.address);
        const domain = engineDomain(await agreement.getAddress());
        const documentHash = id("the pinned document");
        const payloadA = hashPayload(id("aHash"), documentHash);
        const payloadB = hashPayload(id("bHash"), documentHash);

        // Both sign before anything is submitted.
        const permitA = await signInput(partyA, domain, signA, payloadA, 0n, deadline);
        const permitB = await signInput(partyB, domain, signB, payloadB, 0n, deadline);
        const submitA = () =>
          agreement.connect(relayer).submitInputWithPermit(partyA.address, signA, payloadA, deadline, permitA);
        const submitB = () =>
          agreement.connect(relayer).submitInputWithPermit(partyB.address, signB, payloadB, deadline, permitB);

        await (first === "A" ? submitA() : submitB());
        expect(await agreement.currentState()).to.equal(first === "A" ? A_SIGNED : B_SIGNED);
        // Accepting one party's permit leaves the other's untouched.
        await (first === "A" ? submitB() : submitA());
        expect(await agreement.currentState()).to.equal(SIGNED);
        expect(await agreement.nonces(partyA.address)).to.equal(1n);
        expect(await agreement.nonces(partyB.address)).to.equal(1n);
      });
    }

    it("one party's permit cannot stand in for the other party's input", async function () {
      const { factory, implementation, engineDomain, deadline } = await deployProtocol();
      const [partyA, partyB, relayer] = await ethers.getSigners();
      const agreement = await deployTwoSigner(factory, partyA.address, partyB.address);
      const payloadB = hashPayload(id("bHash"), id("the pinned document"));
      const permit = await signInput(partyA, engineDomain(await agreement.getAddress()), signB, payloadB, 0n, deadline);

      await expect(
        agreement.connect(relayer).submitInputWithPermit(partyA.address, signB, payloadB, deadline, permit)
      ).to.be.revertedWithCustomError(implementation, "SenderAddressMismatch");
      expect(await agreement.currentState()).to.equal(S0);
    });

    it("a used permit cannot be replayed, even in a state that accepts its input again", async function () {
      const { factory, implementation, engineDomain, deadline } = await deployProtocol();
      const [signer, other, relayer] = await ethers.getSigners();
      const [advance, rewind] = [id("advance"), id("rewind")];
      const deployment: Deployment = {
        ...empty("cycle"),
        initialState: S0,
        inputDefs: [
          { id: advance, fields: [], conditions: [], verifierKeys: [] },
          { id: rewind, fields: [], conditions: [], verifierKeys: [] },
        ],
        transitions: [
          { fromState: S0, toState: A_SIGNED, inputId: advance },
          { fromState: A_SIGNED, toState: S0, inputId: rewind },
        ],
      };
      const address = await factory.createAgreement.staticCall(...createArgs(deployment));
      await factory.createAgreement(...createArgs(deployment));
      const agreement: any = await ethers.getContractAt("AgreementEngine", address);
      const permit = await signInput(signer, engineDomain(address), advance, emptyPayload, 0n, deadline);
      const submit = () =>
        agreement.connect(relayer).submitInputWithPermit(signer.address, advance, emptyPayload, deadline, permit);

      await submit();
      await agreement.connect(other).submitInput(rewind, emptyPayload);
      expect(await agreement.currentState()).to.equal(S0);

      await expect(submit()).to.be.revertedWithCustomError(implementation, "InvalidSignature");
      expect(await agreement.currentState()).to.equal(S0);
    });

    it("a signer's later permit supersedes an earlier unused one", async function () {
      const { factory, implementation, engineDomain, deadline } = await deployProtocol();
      const [partyA, partyB, relayer] = await ethers.getSigners();
      const agreement = await deployTwoSigner(factory, partyA.address, partyB.address);
      const domain = engineDomain(await agreement.getAddress());
      const stale = hashPayload(id("aHash"), id("an earlier draft"));
      const current = hashPayload(id("aHash"), id("the pinned document"));

      // Both carry nonce 0, so accepting one makes the other unusable.
      const stalePermit = await signInput(partyA, domain, signA, stale, 0n, deadline);
      const currentPermit = await signInput(partyA, domain, signA, current, 0n, deadline);
      await agreement.connect(relayer).submitInputWithPermit(partyA.address, signA, current, deadline, currentPermit);

      await expect(
        agreement.connect(relayer).submitInputWithPermit(partyA.address, signA, stale, deadline, stalePermit)
      ).to.be.revertedWithCustomError(implementation, "InvalidSignature");
    });

    it("an acceptance permit left unused cannot be presented after its signer rejects directly and the work comes back", async function () {
      const { factory, implementation, engineDomain, deadline } = await deployProtocol();
      const [reviewer, worker, holder] = await ethers.getSigners();
      const [IN_REVIEW, REWORK, ACCEPTED] = [id("IN_REVIEW"), id("REWORK"), id("ACCEPTED")];
      const [accept, reject, resubmit] = [id("accept"), id("reject"), id("resubmit")];
      const issuer = (partyVar: string) => ({ op: 16, fieldId: id(partyVar), bytesArg: "0x" });
      const input = (inputId: string, partyVar: string) =>
        ({ id: inputId, fields: [], conditions: [issuer(partyVar)], verifierKeys: [] });
      const party = (name: string, account: string) =>
        ({ id: id(name), fType: 2, data: coder.encode(["address"], [account]) });
      const deployment: Deployment = {
        ...empty("review-cycle"),
        initialState: IN_REVIEW,
        inputDefs: [input(accept, "reviewer"), input(reject, "reviewer"), input(resubmit, "worker")],
        initVars: [party("reviewer", reviewer.address), party("worker", worker.address)],
        transitions: [
          { fromState: IN_REVIEW, toState: ACCEPTED, inputId: accept },
          { fromState: IN_REVIEW, toState: REWORK, inputId: reject },
          { fromState: REWORK, toState: IN_REVIEW, inputId: resubmit },
        ],
      };
      const address = await factory.createAgreement.staticCall(...createArgs(deployment));
      await factory.createAgreement(...createArgs(deployment));
      const agreement: any = await ethers.getContractAt("AgreementEngine", address);
      const domain = engineDomain(address);

      // The reviewer signs an acceptance. Nobody submits it.
      const oldAcceptance = await signInput(reviewer, domain, accept, emptyPayload, 0n, deadline);

      // The reviewer changes their mind and rejects on chain, and the work is resubmitted.
      await agreement.connect(reviewer).submitInput(reject, emptyPayload);
      expect(await agreement.nonces(reviewer.address)).to.equal(1n);
      await agreement.connect(worker).submitInput(resubmit, emptyPayload);
      expect(await agreement.currentState()).to.equal(IN_REVIEW);

      // Before the fix the old acceptance was still good here and accepted the new submission.
      await expect(
        agreement.connect(holder).submitInputWithPermit(reviewer.address, accept, emptyPayload, deadline, oldAcceptance)
      ).to.be.revertedWithCustomError(implementation, "InvalidSignature");
      expect(await agreement.currentState()).to.equal(IN_REVIEW);

      // An acceptance signed for the new submission carries the reviewer's new nonce.
      const newAcceptance = await signInput(reviewer, domain, accept, emptyPayload, 1n, deadline);
      await agreement.connect(holder).submitInputWithPermit(reviewer.address, accept, emptyPayload, deadline, newAcceptance);
      expect(await agreement.currentState()).to.equal(ACCEPTED);
      expect(await agreement.nonces(reviewer.address)).to.equal(2n);
    });

    it("one party's direct input retires its own unused permit and leaves the other party's valid", async function () {
      const { factory, implementation, engineDomain, deadline } = await deployProtocol();
      const [partyA, partyB, relayer] = await ethers.getSigners();
      const agreement = await deployTwoSigner(factory, partyA.address, partyB.address);
      const domain = engineDomain(await agreement.getAddress());
      const payloadA = hashPayload(id("aHash"), id("the pinned document"));
      const payloadB = hashPayload(id("bHash"), id("the pinned document"));

      // Both sign before anything is submitted.
      const permitA = await signInput(partyA, domain, signA, payloadA, 0n, deadline);
      const permitB = await signInput(partyB, domain, signB, payloadB, 0n, deadline);

      // Party A then submits its own input directly.
      await agreement.connect(partyA).submitInput(signA, payloadA);
      expect(await agreement.currentState()).to.equal(A_SIGNED);
      expect(await agreement.nonces(partyA.address)).to.equal(1n);
      expect(await agreement.nonces(partyB.address)).to.equal(0n);
      expect(await agreement.nonces(relayer.address)).to.equal(0n);

      // Party A's own unused permit is gone.
      await expect(
        agreement.connect(relayer).submitInputWithPermit(partyA.address, signA, payloadA, deadline, permitA)
      ).to.be.revertedWithCustomError(implementation, "InvalidSignature");

      // Party B's permit, signed up front, is still accepted.
      await agreement.connect(relayer).submitInputWithPermit(partyB.address, signB, payloadB, deadline, permitB);
      expect(await agreement.currentState()).to.equal(SIGNED);
      expect(await agreement.nonces(partyB.address)).to.equal(1n);
    });

    it("a direct input that is refused leaves the caller's permit usable", async function () {
      const { factory, implementation, engineDomain, deadline } = await deployProtocol();
      const [partyA, partyB, relayer] = await ethers.getSigners();
      const agreement = await deployTwoSigner(factory, partyA.address, partyB.address);
      const payloadA = hashPayload(id("aHash"), id("the pinned document"));
      const payloadB = hashPayload(id("bHash"), id("the pinned document"));
      const permitA = await signInput(partyA, engineDomain(await agreement.getAddress()), signA, payloadA, 0n, deadline);

      // Party A tries to submit party B's input: refused, and nothing is consumed.
      await expect(agreement.connect(partyA).submitInput(signB, payloadB))
        .to.be.revertedWithCustomError(implementation, "SenderAddressMismatch");
      expect(await agreement.nonces(partyA.address)).to.equal(0n);

      await agreement.connect(relayer).submitInputWithPermit(partyA.address, signA, payloadA, deadline, permitA);
      expect(await agreement.currentState()).to.equal(A_SIGNED);
    });

    // A permit does not name the agreement's state, and another party's input does not
    // retire it. Where one reviewer can send work back and another has signed an approval,
    // the agreement itself has to tie the approval to what was reviewed: the approval
    // carries the report's hash and a condition compares it with the stored one.
    for (const bound of [true, false]) {
      const title = bound
        ? "an approval that names the report's hash is refused once another reviewer returns the report and it is revised"
        : "without that condition the same unused approval is accepted for the revised report";
      it(title, async function () {
        const { factory, implementation, engineDomain, deadline } = await deployProtocol();
        const [author, reviewer, secondReviewer, holder] = await ethers.getSigners();
        const [DRAFTING, IN_REVIEW, APPROVED] = [id("DRAFTING"), id("IN_REVIEW"), id("APPROVED")];
        const [submitReport, returnReport, approveReport] = [id("submitReport"), id("returnReport"), id("approveReport")];
        const [reportHash, approvedReportHash] = [id("reportHash"), id("approvedReportHash")];
        const party = (name: string, account: string) =>
          ({ id: id(name), fType: 2, data: coder.encode(["address"], [account]) });
        // SENDER_IN_ALLOWED_ADDRESSES: either reviewer
        const eitherReviewer = {
          op: 17,
          fieldId: ethers.ZeroHash,
          bytesArg: coder.encode(["bytes32[]", "address[]"], [[id("reviewer"), id("secondReviewer")], []]),
        };
        // STRING_EQ_VAR: the submitted field must equal the stored report hash
        const namesStoredReport = { op: 3, fieldId: approvedReportHash, bytesArg: coder.encode(["bytes32"], [reportHash]) };
        const textPayload = (fieldId: string, value: string) =>
          coder.encode(
            ["tuple(bytes32 id,uint8 fType,bytes data)[]"],
            [[{ id: fieldId, fType: 1, data: coder.encode(["string"], [value]) }]]
          );
        const deployment: Deployment = {
          ...empty(`report-review-${bound}`),
          initialState: DRAFTING,
          inputDefs: [
            {
              id: submitReport,
              fields: [{ fieldId: reportHash, fType: 1, required: true, persist: true }],
              conditions: [{ op: 16, fieldId: id("author"), bytesArg: "0x" }],
              verifierKeys: [],
            },
            { id: returnReport, fields: [], conditions: [eitherReviewer], verifierKeys: [] },
            {
              id: approveReport,
              fields: [{ fieldId: approvedReportHash, fType: 1, required: true, persist: false }],
              conditions: bound ? [eitherReviewer, namesStoredReport] : [eitherReviewer],
              verifierKeys: [],
            },
          ],
          initVars: [
            party("author", author.address),
            party("reviewer", reviewer.address),
            party("secondReviewer", secondReviewer.address),
          ],
          transitions: [
            { fromState: DRAFTING, toState: IN_REVIEW, inputId: submitReport },
            { fromState: IN_REVIEW, toState: DRAFTING, inputId: returnReport },
            { fromState: IN_REVIEW, toState: APPROVED, inputId: approveReport },
          ],
        };
        const address = await factory.createAgreement.staticCall(...createArgs(deployment));
        await factory.createAgreement(...createArgs(deployment));
        const agreement: any = await ethers.getContractAt("AgreementEngine", address);
        const domain = engineDomain(address);
        const [version1, version2] = [id("report, version 1"), id("report, version 2")];

        // Version 1 is submitted. One reviewer signs an approval of it that nobody submits.
        await agreement.connect(author).submitInput(submitReport, textPayload(reportHash, version1));
        const approvalOfVersion1 = textPayload(approvedReportHash, version1);
        const oldApproval = await signInput(reviewer, domain, approveReport, approvalOfVersion1, 0n, deadline);

        // The other reviewer returns the report, and version 2 comes in.
        await agreement.connect(secondReviewer).submitInput(returnReport, emptyPayload);
        await agreement.connect(author).submitInput(submitReport, textPayload(reportHash, version2));
        expect(await agreement.currentState()).to.equal(IN_REVIEW);
        // The first reviewer's nonce has not moved: the permit itself is still good.
        expect(await agreement.nonces(reviewer.address)).to.equal(0n);

        const presentOldApproval = () =>
          agreement
            .connect(holder)
            .submitInputWithPermit(reviewer.address, approveReport, approvalOfVersion1, deadline, oldApproval);

        if (!bound) {
          // Nothing ties the approval to version 1, so it approves version 2.
          await presentOldApproval();
          expect(await agreement.currentState()).to.equal(APPROVED);
          return;
        }

        await expect(presentOldApproval())
          .to.be.revertedWithCustomError(implementation, "ComparisonFailed")
          .withArgs("STRING_EQ_VAR", "STRING");
        // The same holds for an approval sent directly.
        await expect(agreement.connect(reviewer).submitInput(approveReport, approvalOfVersion1))
          .to.be.revertedWithCustomError(implementation, "ComparisonFailed")
          .withArgs("STRING_EQ_VAR", "STRING");
        expect(await agreement.currentState()).to.equal(IN_REVIEW);
        expect(await agreement.nonces(reviewer.address)).to.equal(0n);

        // An approval of version 2 is accepted.
        const approvalOfVersion2 = textPayload(approvedReportHash, version2);
        const newApproval = await signInput(reviewer, domain, approveReport, approvalOfVersion2, 0n, deadline);
        await agreement
          .connect(holder)
          .submitInputWithPermit(reviewer.address, approveReport, approvalOfVersion2, deadline, newApproval);
        expect(await agreement.currentState()).to.equal(APPROVED);
      });
    }

    it("a signer cancels an unsubmitted permit, and only its own", async function () {
      const { factory, implementation, engineDomain, deadline } = await deployProtocol();
      const [partyA, partyB, relayer] = await ethers.getSigners();
      const agreement = await deployTwoSigner(factory, partyA.address, partyB.address);
      const domain = engineDomain(await agreement.getAddress());
      const payloadA = hashPayload(id("aHash"), id("the pinned document"));
      const payloadB = hashPayload(id("bHash"), id("the pinned document"));
      const permitA = await signInput(partyA, domain, signA, payloadA, 0n, deadline);
      const permitB = await signInput(partyB, domain, signB, payloadB, 0n, deadline);

      // Party A changes its mind before the relayer submits.
      await expect(agreement.connect(partyA).cancelPermits())
        .to.emit(agreement, "PermitsCancelled")
        .withArgs(partyA.address, 1n);
      expect(await agreement.nonces(partyA.address)).to.equal(1n);
      expect(await agreement.nonces(partyB.address)).to.equal(0n);

      await expect(
        agreement.connect(relayer).submitInputWithPermit(partyA.address, signA, payloadA, deadline, permitA)
      ).to.be.revertedWithCustomError(implementation, "InvalidSignature");
      expect(await agreement.currentState()).to.equal(S0);

      // Party B's permit is untouched.
      await agreement.connect(relayer).submitInputWithPermit(partyB.address, signB, payloadB, deadline, permitB);
      expect(await agreement.currentState()).to.equal(B_SIGNED);

      // Party A can still sign again, with its new nonce, or submit directly.
      const again = await signInput(partyA, domain, signA, payloadA, 1n, deadline);
      await agreement.connect(relayer).submitInputWithPermit(partyA.address, signA, payloadA, deadline, again);
      expect(await agreement.currentState()).to.equal(SIGNED);
      expect(await agreement.nonces(partyA.address)).to.equal(2n);
    });

    it("nobody can cancel another signer's permit, and cancelling does not block direct submission", async function () {
      const { factory, engineDomain, deadline } = await deployProtocol();
      const [partyA, partyB, relayer] = await ethers.getSigners();
      const agreement = await deployTwoSigner(factory, partyA.address, partyB.address);
      const domain = engineDomain(await agreement.getAddress());
      const payloadA = hashPayload(id("aHash"), id("the pinned document"));
      const payloadB = hashPayload(id("bHash"), id("the pinned document"));
      const permitA = await signInput(partyA, domain, signA, payloadA, 0n, deadline);

      // The relayer and party B each cancel: only their own nonces move.
      await agreement.connect(relayer).cancelPermits();
      await agreement.connect(partyB).cancelPermits();
      expect(await agreement.nonces(partyA.address)).to.equal(0n);
      await agreement.connect(relayer).submitInputWithPermit(partyA.address, signA, payloadA, deadline, permitA);
      expect(await agreement.currentState()).to.equal(A_SIGNED);

      // Party B cancelled, and still submits its own input directly.
      await agreement.connect(partyB).submitInput(signB, payloadB);
      expect(await agreement.currentState()).to.equal(SIGNED);
    });

    it("the implementation contract itself accepts no cancellation", async function () {
      const { implementation } = await deployProtocol();
      await expect(implementation.cancelPermits()).to.be.revertedWithCustomError(implementation, "NotInitialized");
    });

    it("a permit cannot carry a payload other than the one signed", async function () {
      const { factory, implementation, engineDomain, deadline } = await deployProtocol();
      const [partyA, partyB, relayer] = await ethers.getSigners();
      const agreement = await deployTwoSigner(factory, partyA.address, partyB.address);
      const signed = hashPayload(id("aHash"), id("the pinned document"));
      const swapped = hashPayload(id("aHash"), id("a different document"));
      const permit = await signInput(partyA, engineDomain(await agreement.getAddress()), signA, signed, 0n, deadline);

      await expect(
        agreement.connect(relayer).submitInputWithPermit(partyA.address, signA, swapped, deadline, permit)
      ).to.be.revertedWithCustomError(implementation, "InvalidSignature");
      expect(await agreement.currentState()).to.equal(S0);
    });
  });

  describe("permits name their signer", function () {
    async function siblings() {
      const [key] = await ethers.getSigners();
      const accountA = await ethers.deployContract("TestERC1271Signer", [key.address]);
      const accountB = await ethers.deployContract("TestERC1271Signer", [key.address]);
      return { key, accountA: await accountA.getAddress(), accountB: await accountB.getAddress() };
    }

    it("a creation permit signed for one smart account is refused for a sibling account", async function () {
      const { factory, factoryDomain, deadline } = await deployProtocol();
      const { key, accountA, accountB } = await siblings();
      const [, relayer] = await ethers.getSigners();
      const deployment = empty("for-A");
      const signature = await key.signTypedData(
        factoryDomain,
        { PermitAgreementWithActions: [...CREATION_FIELDS, ...TAIL] },
        { signer: accountA, ...deploymentHashes(deployment), nonce: 0n, deadline }
      );
      const asRelayer = factory.connect(relayer);

      // Before the fix this created an agreement owned by account B.
      await expect(
        asRelayer.createAgreementWithPermit(accountB, ...createArgs(deployment), deadline, signature)
      ).to.be.revertedWithCustomError(factory, "InvalidSignature");
      expect(await factory.nonces(accountB)).to.equal(0n);

      const address = await asRelayer.createAgreementWithPermit.staticCall(
        accountA, ...createArgs(deployment), deadline, signature
      );
      await asRelayer.createAgreementWithPermit(accountA, ...createArgs(deployment), deadline, signature);
      expect(await (await ethers.getContractAt("AgreementEngine", address)).owner()).to.equal(accountA);
    });

    it("a deterministic creation permit signed for one smart account is refused for a sibling account", async function () {
      const { factory, factoryDomain, deadline } = await deployProtocol();
      const { key, accountA, accountB } = await siblings();
      const [, relayer] = await ethers.getSigners();
      const deployment = empty("det-for-A");
      const salt = id("sibling-salt");
      const signature = await key.signTypedData(
        factoryDomain,
        {
          PermitDeterministicAgreementWithActions: [
            ...CREATION_FIELDS,
            { name: "salt", type: "bytes32" },
            { name: "predictedAgreement", type: "address" },
            ...TAIL,
          ],
        },
        {
          signer: accountA,
          ...deploymentHashes(deployment),
          salt,
          predictedAgreement: await factory.predictAddress(accountA, salt),
          nonce: 0n,
          deadline,
        }
      );
      await expect(
        factory
          .connect(relayer)
          .createAgreementDeterministicWithPermit(accountB, salt, ...createArgs(deployment), deadline, signature)
      ).to.be.revertedWithCustomError(factory, "InvalidSignature");
    });

    it("an input permit signed for one smart account is refused for a sibling account", async function () {
      const { factory, implementation, engineDomain, deadline } = await deployProtocol();
      const { key, accountA, accountB } = await siblings();
      const [, relayer] = await ethers.getSigners();
      const inputId = id("sign");
      const deployment: Deployment = {
        ...empty("input-for-A"),
        inputDefs: [{ id: inputId, fields: [], conditions: [], verifierKeys: [] }],
        transitions: [{ fromState: id("S0"), toState: id("S1"), inputId }],
      };
      const address = await factory.createAgreement.staticCall(...createArgs(deployment));
      await factory.createAgreement(...createArgs(deployment));
      const agreement: any = await ethers.getContractAt("AgreementEngine", address);
      const signature = await key.signTypedData(
        engineDomain(address),
        { PermitInput: PERMIT_INPUT },
        { signer: accountA, inputId, payload: emptyPayload, nonce: 0n, deadline }
      );

      // Before the fix this was accepted with account B recorded as the signer.
      await expect(
        agreement.connect(relayer).submitInputWithPermit(accountB, inputId, emptyPayload, deadline, signature)
      ).to.be.revertedWithCustomError(implementation, "InvalidSignature");
      expect(await agreement.currentState()).to.equal(id("S0"));

      await expect(
        agreement.connect(relayer).submitInputWithPermit(accountA, inputId, emptyPayload, deadline, signature)
      )
        .to.emit(agreement, "InputSubmittedWithPermit")
        .withArgs(accountA, relayer.address, inputId);
    });
  });

  describe("an action either takes effect or stops its transition", function () {
    const inputId = id("sign");
    const withAction = (name: string, action: { target: string; value?: bigint; data?: string }): Deployment => ({
      ...empty(name),
      inputDefs: [{ id: inputId, fields: [], conditions: [], verifierKeys: [] }],
      transitions: [{ fromState: id("S0"), toState: id("S1"), inputId }],
      actions: [
        { fromState: id("S0"), inputId, target: action.target, value: action.value ?? 0n, data: action.data ?? "0x" },
      ],
    });
    const mintCall = (to: string) =>
      new ethers.Interface(["function mint(address to, uint256 amount)"]).encodeFunctionData("mint", [to, 5n]);

    it("an agreement whose action forwards ETH cannot be created, on any creation path", async function () {
      const { implementation, factory, factoryDomain, deadline } = await deployProtocol();
      const [creator, relayer] = await ethers.getSigners();
      const token = await ethers.deployContract("TestERC20", ["Token", "TKN"]);
      // The engine cannot hold ETH. Before the fix this agreement was created
      // and then could never leave S0: the action reverted every time.
      const deployment = withAction("eth-action", { target: await token.getAddress(), value: 1n });
      const refused = (tx: Promise<unknown>) =>
        expect(tx)
          .to.be.revertedWithCustomError(implementation, "ActionValueNotSupported")
          .withArgs(id("S0"), inputId, 1n);
      const salt = id("eth-action-salt");

      await refused(factory.connect(creator).createAgreement(...createArgs(deployment)));
      await refused(factory.connect(creator).createAgreementDeterministic(salt, ...createArgs(deployment)));

      const signature = await creator.signTypedData(
        factoryDomain,
        { PermitAgreementWithActions: [...CREATION_FIELDS, ...TAIL] },
        { signer: creator.address, ...deploymentHashes(deployment), nonce: 0n, deadline }
      );
      await refused(
        factory
          .connect(relayer)
          .createAgreementWithPermit(creator.address, ...createArgs(deployment), deadline, signature)
      );

      const deterministicSignature = await creator.signTypedData(
        factoryDomain,
        {
          PermitDeterministicAgreementWithActions: [
            ...CREATION_FIELDS,
            { name: "salt", type: "bytes32" },
            { name: "predictedAgreement", type: "address" },
            ...TAIL,
          ],
        },
        {
          signer: creator.address,
          ...deploymentHashes(deployment),
          salt,
          predictedAgreement: await factory.predictAddress(creator.address, salt),
          nonce: 0n,
          deadline,
        }
      );
      await refused(
        factory
          .connect(relayer)
          .createAgreementDeterministicWithPermit(
            creator.address,
            salt,
            ...createArgs(deployment),
            deadline,
            deterministicSignature
          )
      );

      // A refused creation consumes nothing: the same permit still works for the
      // same agreement without the value.
      expect(await factory.nonces(creator.address)).to.equal(0n);
    });

    it("an action aimed at an address without code stops the transition", async function () {
      const { implementation, factory } = await deployProtocol();
      const [creator] = await ethers.getSigners();
      const nowhere = ethers.Wallet.createRandom().address;

      // Before the fix only token transfers were checked: any other call to an
      // address without code succeeded, the state moved and ActionExecuted was
      // emitted although nothing had happened.
      const calls = { empty: "0x", approve: "0x095ea7b3" + "00".repeat(64), mint: mintCall(creator.address) };
      for (const [name, data] of Object.entries(calls)) {
        const deployment = withAction(`no-code-${name}`, { target: nowhere, data });
        const address = await factory.createAgreement.staticCall(...createArgs(deployment));
        await factory.createAgreement(...createArgs(deployment));
        const agreement: any = await ethers.getContractAt("AgreementEngine", address);

        await expect(agreement.submitInput(inputId, emptyPayload))
          .to.be.revertedWithCustomError(implementation, "ActionTargetHasNoCode")
          .withArgs(nowhere);
        expect(await agreement.currentState()).to.equal(id("S0"));
      }
    });

    it("a target deployed after the agreement is accepted once it exists", async function () {
      const { implementation, factory } = await deployProtocol();
      const [creator, , , deployer] = await ethers.getSigners();
      // The agreement names a token that is not deployed yet.
      const tokenAddress = ethers.getCreateAddress({ from: deployer.address, nonce: await deployer.getNonce() });
      const deployment = withAction("late-target", { target: tokenAddress, data: mintCall(creator.address) });
      const address = await factory.createAgreement.staticCall(...createArgs(deployment));
      await factory.createAgreement(...createArgs(deployment));
      const agreement: any = await ethers.getContractAt("AgreementEngine", address);

      await expect(agreement.submitInput(inputId, emptyPayload))
        .to.be.revertedWithCustomError(implementation, "ActionTargetHasNoCode")
        .withArgs(tokenAddress);

      const token: any = await ethers.deployContract("TestERC20", ["Token", "TKN"], deployer);
      expect(await token.getAddress()).to.equal(tokenAddress);

      await expect(agreement.submitInput(inputId, emptyPayload))
        .to.emit(agreement, "ActionExecuted")
        .withArgs(id("S0"), id("S1"), inputId, tokenAddress);
      expect(await agreement.currentState()).to.equal(id("S1"));
      expect(await token.balanceOf(creator.address)).to.equal(5n);
    });
  });
});
