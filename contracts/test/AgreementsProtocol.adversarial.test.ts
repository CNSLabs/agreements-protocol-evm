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
  { name: "expectedState", type: "bytes32" },
  { name: "expectedStateNonce", type: "uint256" },
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
  });

  describe("input permits are valid for one position in the agreement's history", function () {
    const inputA = id("advance");
    const inputB = id("rewind");
    const [S0, S1, S2] = [id("S0"), id("S1"), id("S2")];

    async function deployAgreement(factory: any, transitions: any[]) {
      const deployment: Deployment = {
        ...empty("history"),
        initialState: S0,
        inputDefs: [
          { id: inputA, fields: [], conditions: [], verifierKeys: [] },
          { id: inputB, fields: [], conditions: [], verifierKeys: [] },
        ],
        transitions,
      };
      const address = await factory.createAgreement.staticCall(...createArgs(deployment));
      await factory.createAgreement(...createArgs(deployment));
      return (await ethers.getContractAt("AgreementEngine", address)) as any;
    }

    const signInput = (signer: any, domain: any, expectedState: string, expectedStateNonce: bigint, deadline: number) =>
      signer.signTypedData(
        domain,
        { PermitInput: PERMIT_INPUT },
        { signer: signer.address, inputId: inputA, payload: emptyPayload, expectedState, expectedStateNonce, nonce: 0n, deadline }
      );

    it("a permit signed in one state is refused once the agreement has moved to another", async function () {
      const { factory, implementation, engineDomain, deadline } = await deployProtocol();
      const [signer, other, relayer] = await ethers.getSigners();
      const agreement = await deployAgreement(factory, [
        { fromState: S0, toState: S1, inputId: inputA },
        { fromState: S1, toState: S2, inputId: inputA },
      ]);
      // Signed in S0, meaning "move S0 -> S1".
      const signature = await signInput(signer, engineDomain(await agreement.getAddress()), S0, 0n, deadline);

      await agreement.connect(other).submitInput(inputA, emptyPayload); // S0 -> S1 by someone else
      expect(await agreement.stateNonce()).to.equal(1n);

      // Before the fix this moved S1 -> S2 on the signer's authority.
      await expect(
        agreement.connect(relayer).submitInputWithPermit(signer.address, inputA, emptyPayload, deadline, signature)
      ).to.be.revertedWithCustomError(implementation, "InvalidSignature");
      expect(await agreement.currentState()).to.equal(S1);
      expect(await agreement.nonces(signer.address)).to.equal(0n);
    });

    it("a withheld permit is refused in a later visit to the same state", async function () {
      const { factory, implementation, engineDomain, deadline } = await deployProtocol();
      const [signer, other, relayer] = await ethers.getSigners();
      const agreement = await deployAgreement(factory, [
        { fromState: S0, toState: S1, inputId: inputA },
        { fromState: S1, toState: S0, inputId: inputB },
      ]);
      const signature = await signInput(signer, engineDomain(await agreement.getAddress()), S0, 0n, deadline);

      // The relayer withholds the permit while the agreement goes S0 -> S1 -> S0.
      await agreement.connect(other).submitInput(inputA, emptyPayload);
      await agreement.connect(other).submitInput(inputB, emptyPayload);
      expect(await agreement.currentState()).to.equal(S0);
      expect(await agreement.stateNonce()).to.equal(2n);

      await expect(
        agreement.connect(relayer).submitInputWithPermit(signer.address, inputA, emptyPayload, deadline, signature)
      ).to.be.revertedWithCustomError(implementation, "InvalidSignature");
      expect(await agreement.currentState()).to.equal(S0);

      // A permit signed for the current position is accepted.
      const fresh = await signInput(signer, engineDomain(await agreement.getAddress()), S0, 2n, deadline);
      await expect(
        agreement.connect(relayer).submitInputWithPermit(signer.address, inputA, emptyPayload, deadline, fresh)
      )
        .to.emit(agreement, "InputSubmittedWithPermit")
        .withArgs(signer.address, relayer.address, inputA);
      expect(await agreement.currentState()).to.equal(S1);
      expect(await agreement.stateNonce()).to.equal(3n);
    });

    it("a permit that names the wrong state nonce is refused even in the right state", async function () {
      const { factory, implementation, engineDomain, deadline } = await deployProtocol();
      const [signer, , relayer] = await ethers.getSigners();
      const agreement = await deployAgreement(factory, [{ fromState: S0, toState: S1, inputId: inputA }]);
      const signature = await signInput(signer, engineDomain(await agreement.getAddress()), S0, 1n, deadline);
      await expect(
        agreement.connect(relayer).submitInputWithPermit(signer.address, inputA, emptyPayload, deadline, signature)
      ).to.be.revertedWithCustomError(implementation, "InvalidSignature");
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
        { signer: accountA, inputId, payload: emptyPayload, expectedState: id("S0"), expectedStateNonce: 0n, nonce: 0n, deadline }
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
});
