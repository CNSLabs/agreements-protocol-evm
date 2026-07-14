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

  async function signDeterministicPermit(
    factory: any,
    signer: any,
    salt: string,
    deployment: {
      docUri: string;
      docHash: string;
      initialState: string;
      inputDefs: any[];
      transitions: any[];
      initVars: any[];
      verifiers: any[];
      actions: any[];
    },
    deadline: number
  ) {
    const coder = ethers.AbiCoder.defaultAbiCoder();
    const hash = (type: string, value: unknown) =>
      ethers.keccak256(coder.encode([type], [value]));
    const factoryAddress = await factory.getAddress();
    const predictedAgreement = await factory.predictAddress(salt);
    const nonce = await factory.nonces(signer.address);
    const network = await ethers.provider.getNetwork();

    const domain = {
      name: "AgreementFactory",
      version: "1",
      chainId: network.chainId,
      verifyingContract: factoryAddress,
    };
    const types = {
      PermitDeterministicAgreementWithActions: [
        { name: "docUri", type: "string" },
        { name: "docHash", type: "bytes32" },
        { name: "initialState", type: "bytes32" },
        { name: "inputDefsHash", type: "bytes32" },
        { name: "transitionsHash", type: "bytes32" },
        { name: "initVarsHash", type: "bytes32" },
        { name: "verifiersHash", type: "bytes32" },
        { name: "actionsHash", type: "bytes32" },
        { name: "salt", type: "bytes32" },
        { name: "predictedAgreement", type: "address" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    };
    const message = {
      docUri: deployment.docUri,
      docHash: deployment.docHash,
      initialState: deployment.initialState,
      inputDefsHash: hash(
        "tuple(bytes32 id,tuple(bytes32 fieldId,uint8 fType,bool required,bool persist)[] fields,tuple(uint8 op,bytes32 fieldId,bytes bytesArg)[] conditions,bytes32[] verifierKeys)[]",
        deployment.inputDefs
      ),
      transitionsHash: hash(
        "tuple(bytes32 fromState,bytes32 toState,bytes32 inputId)[]",
        deployment.transitions
      ),
      initVarsHash: hash(
        "tuple(bytes32 id,uint8 fType,bytes data)[]",
        deployment.initVars
      ),
      verifiersHash: hash(
        "tuple(bytes32 key,address verifier)[]",
        deployment.verifiers
      ),
      actionsHash: hash(
        "tuple(bytes32 fromState,bytes32 inputId,address target,uint256 value,bytes data)[]",
        deployment.actions
      ),
      salt,
      predictedAgreement,
      nonce,
      deadline,
    };
    const signature = await signer.signTypedData(domain, types, message);

    return { predictedAgreement, signature };
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

  it("authorizes against stored state before persisting submitted fields", async function () {
    const { owner, implementation, factory } = await deployProtocol();
    const [, attacker] = await ethers.getSigners();
    const coder = ethers.AbiCoder.defaultAbiCoder();
    const authorizedActor = ethers.keccak256(ethers.toUtf8Bytes("authorizedActor"));
    const inputId = ethers.keccak256(ethers.toUtf8Bytes("replaceAuthorizedActor"));
    const initialState = ethers.keccak256(ethers.toUtf8Bytes("INITIAL"));
    const completeState = ethers.keccak256(ethers.toUtf8Bytes("COMPLETE"));
    const inputDefs = [
      {
        id: inputId,
        fields: [
          { fieldId: authorizedActor, fType: 2, required: true, persist: true },
        ],
        conditions: [
          { op: 16, fieldId: authorizedActor, bytesArg: "0x" },
        ],
        verifierKeys: [],
      },
    ];
    const transitions = [
      { fromState: initialState, toState: completeState, inputId },
    ];
    const initVars = [
      { id: authorizedActor, fType: 2, data: coder.encode(["address"], [owner.address]) },
    ];
    const agreementAddress = await factory.createAgreement.staticCall(
      "ipfs://agreement/auth-before-write",
      ethers.keccak256(ethers.toUtf8Bytes("auth-before-write")),
      initialState,
      inputDefs,
      transitions,
      initVars,
      [],
      []
    );
    await factory.createAgreement(
      "ipfs://agreement/auth-before-write",
      ethers.keccak256(ethers.toUtf8Bytes("auth-before-write")),
      initialState,
      inputDefs,
      transitions,
      initVars,
      [],
      []
    );
    const agreement = await ethers.getContractAt("AgreementEngine", agreementAddress);
    const encodePayload = (actor: string) =>
      coder.encode(
        ["tuple(bytes32 id,uint8 fType,bytes data)[]"],
        [[{ id: authorizedActor, fType: 2, data: coder.encode(["address"], [actor]) }]]
      );

    await expect(agreement.connect(attacker).submitInput(inputId, encodePayload(attacker.address)))
      .to.be.revertedWithCustomError(implementation, "SenderAddressMismatch")
      .withArgs(attacker.address, owner.address);
    expect(await agreement.currentState()).to.equal(initialState);

    await expect(agreement.submitInput(inputId, encodePayload(owner.address)))
      .to.emit(agreement, "InputAccepted");
    expect(await agreement.currentState()).to.equal(completeState);
  });

  it("passes the permit signer, not the relayer, to input verifiers", async function () {
    const { owner, factory } = await deployProtocol();
    const [, relayer] = await ethers.getSigners();
    const verifier = await ethers.deployContract("ExpectedSenderInputVerifier", [owner.address]);
    await verifier.waitForDeployment();
    const verifierKey = ethers.keccak256(ethers.toUtf8Bytes("effective-signer"));
    const inputId = ethers.keccak256(ethers.toUtf8Bytes("verified-input"));
    const initialState = ethers.keccak256(ethers.toUtf8Bytes("INITIAL"));
    const completeState = ethers.keccak256(ethers.toUtf8Bytes("COMPLETE"));
    const inputDefs = [
      { id: inputId, fields: [], conditions: [], verifierKeys: [verifierKey] },
    ];
    const agreementAddress = await factory.createAgreement.staticCall(
      "ipfs://agreement/effective-signer",
      ethers.keccak256(ethers.toUtf8Bytes("effective-signer")),
      initialState,
      inputDefs,
      [{ fromState: initialState, toState: completeState, inputId }],
      [],
      [{ key: verifierKey, verifier: await verifier.getAddress() }],
      []
    );
    await factory.createAgreement(
      "ipfs://agreement/effective-signer",
      ethers.keccak256(ethers.toUtf8Bytes("effective-signer")),
      initialState,
      inputDefs,
      [{ fromState: initialState, toState: completeState, inputId }],
      [],
      [{ key: verifierKey, verifier: await verifier.getAddress() }],
      []
    );
    const agreement = await ethers.getContractAt("AgreementEngine", agreementAddress);
    const payload = ethers.AbiCoder.defaultAbiCoder().encode(
      ["tuple(bytes32 id,uint8 fType,bytes data)[]"],
      [[]]
    );
    const deadline = (await ethers.provider.getBlock("latest"))!.timestamp + 3600;
    const network = await ethers.provider.getNetwork();
    const signature = await owner.signTypedData(
        {
          name: "AgreementEngine",
          version: "1",
          chainId: network.chainId,
          verifyingContract: agreementAddress,
        },
        {
          PermitInput: [
            { name: "inputId", type: "bytes32" },
            { name: "payload", type: "bytes" },
            { name: "nonce", type: "uint256" },
            { name: "deadline", type: "uint256" },
          ],
        },
        { inputId, payload, nonce: 0n, deadline }
      );

    await expect(
      agreement.connect(relayer).submitInputWithPermit(
        owner.address,
        inputId,
        payload,
        deadline,
        signature
      )
    ).to.emit(agreement, "InputSubmittedWithPermit")
      .withArgs(owner.address, relayer.address, inputId);
    expect(await agreement.currentState()).to.equal(completeState);
  });

  it("accepts ERC-1271 signatures for factory creation and engine input permits", async function () {
    const { owner, factory } = await deployProtocol();
    const [, relayer] = await ethers.getSigners();
    const smartSigner = await ethers.deployContract("TestERC1271Signer", [owner.address]);
    await smartSigner.waitForDeployment();
    const smartSignerAddress = await smartSigner.getAddress();
    const factoryAddress = await factory.getAddress();
    const network = await ethers.provider.getNetwork();
    const coder = ethers.AbiCoder.defaultAbiCoder();
    const hash = (type: string, value: unknown) =>
      ethers.keccak256(coder.encode([type], [value]));
    const inputId = ethers.keccak256(ethers.toUtf8Bytes("smart-account-input"));
    const initialState = ethers.keccak256(ethers.toUtf8Bytes("INITIAL"));
    const completeState = ethers.keccak256(ethers.toUtf8Bytes("COMPLETE"));
    const deployment = {
      docUri: "ipfs://agreement/erc1271",
      docHash: ethers.keccak256(ethers.toUtf8Bytes("erc1271-package")),
      initialState,
      inputDefs: [{ id: inputId, fields: [], conditions: [], verifierKeys: [] }],
      transitions: [{ fromState: initialState, toState: completeState, inputId }],
      initVars: [],
      verifiers: [],
      actions: [],
    };
    const hashes = {
      inputDefsHash: hash(
        "tuple(bytes32 id,tuple(bytes32 fieldId,uint8 fType,bool required,bool persist)[] fields,tuple(uint8 op,bytes32 fieldId,bytes bytesArg)[] conditions,bytes32[] verifierKeys)[]",
        deployment.inputDefs
      ),
      transitionsHash: hash(
        "tuple(bytes32 fromState,bytes32 toState,bytes32 inputId)[]",
        deployment.transitions
      ),
      initVarsHash: hash("tuple(bytes32 id,uint8 fType,bytes data)[]", deployment.initVars),
      verifiersHash: hash("tuple(bytes32 key,address verifier)[]", deployment.verifiers),
      actionsHash: hash(
        "tuple(bytes32 fromState,bytes32 inputId,address target,uint256 value,bytes data)[]",
        deployment.actions
      ),
    };
    const deadline = (await ethers.provider.getBlock("latest"))!.timestamp + 3600;
    const domain = {
      name: "AgreementFactory",
      version: "1",
      chainId: network.chainId,
      verifyingContract: factoryAddress,
    };
    const factoryTypes = {
      PermitAgreementWithActions: [
        { name: "docUri", type: "string" },
        { name: "docHash", type: "bytes32" },
        { name: "initialState", type: "bytes32" },
        { name: "inputDefsHash", type: "bytes32" },
        { name: "transitionsHash", type: "bytes32" },
        { name: "initVarsHash", type: "bytes32" },
        { name: "verifiersHash", type: "bytes32" },
        { name: "actionsHash", type: "bytes32" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    };
    const creationSignature = await owner.signTypedData(domain, factoryTypes, {
      ...deployment,
      ...hashes,
      nonce: 0n,
      deadline,
    });
    const createArgs = [
      smartSignerAddress,
      deployment.docUri,
      deployment.docHash,
      deployment.initialState,
      deployment.inputDefs,
      deployment.transitions,
      deployment.initVars,
      deployment.verifiers,
      deployment.actions,
      deadline,
      creationSignature,
    ] as const;
    const agreementAddress = await factory
      .connect(relayer)
      .createAgreementWithPermit.staticCall(...createArgs);
    await expect(factory.connect(relayer).createAgreementWithPermit(...createArgs))
      .to.emit(factory, "AgreementCreatedWithPermit")
      .withArgs(agreementAddress, smartSignerAddress, relayer.address);
    const agreement = await ethers.getContractAt("AgreementEngine", agreementAddress);
    expect(await agreement.owner()).to.equal(smartSignerAddress);

    const payload = coder.encode(["tuple(bytes32 id,uint8 fType,bytes data)[]"], [[]]);
    const inputSignature = await owner.signTypedData(
      {
        name: "AgreementEngine",
        version: "1",
        chainId: network.chainId,
        verifyingContract: agreementAddress,
      },
      {
        PermitInput: [
          { name: "inputId", type: "bytes32" },
          { name: "payload", type: "bytes" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      },
      { inputId, payload, nonce: 0n, deadline }
    );
    await expect(
      agreement
        .connect(relayer)
        .submitInputWithPermit(smartSignerAddress, inputId, payload, deadline, inputSignature)
    ).to.emit(agreement, "InputSubmittedWithPermit")
      .withArgs(smartSignerAddress, relayer.address, inputId);
    expect(await agreement.currentState()).to.equal(completeState);

    const salt = ethers.keccak256(ethers.toUtf8Bytes("erc1271-deterministic"));
    const predictedAgreement = await factory.predictAddress(salt);
    const deterministicTypes = {
      PermitDeterministicAgreementWithActions: [
        ...factoryTypes.PermitAgreementWithActions.slice(0, 8),
        { name: "salt", type: "bytes32" },
        { name: "predictedAgreement", type: "address" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    };
    const deterministicSignature = await owner.signTypedData(domain, deterministicTypes, {
      ...deployment,
      ...hashes,
      salt,
      predictedAgreement,
      nonce: 1n,
      deadline,
    });
    await expect(
      factory.connect(relayer).createAgreementDeterministicWithPermit(
        smartSignerAddress,
        salt,
        deployment.docUri,
        deployment.docHash,
        deployment.initialState,
        deployment.inputDefs,
        deployment.transitions,
        deployment.initVars,
        deployment.verifiers,
        deployment.actions,
        deadline,
        deterministicSignature
      )
    ).to.emit(factory, "AgreementCreatedWithPermit")
      .withArgs(predictedAgreement, smartSignerAddress, relayer.address);
    expect(await (await ethers.getContractAt("AgreementEngine", predictedAgreement)).owner())
      .to.equal(smartSignerAddress);
  });

  it("binds deterministic permits to the package digest and exact clone identity", async function () {
    const { owner, implementation, factory } = await deployProtocol();
    const [, relayer] = await ethers.getSigners();
    const otherFactory = await ethers.deployContract("AgreementFactory", [
      await implementation.getAddress(),
    ]);
    await otherFactory.waitForDeployment();

    const salt = ethers.keccak256(ethers.toUtf8Bytes("canonical-package-v0"));
    const deployment = {
      docUri: "ipfs://agreement-package/canonical-v0",
      docHash: ethers.keccak256(ethers.toUtf8Bytes("canonical-package-digest")),
      initialState: ethers.keccak256(ethers.toUtf8Bytes("DRAFT")),
      inputDefs: [],
      transitions: [],
      initVars: [],
      verifiers: [],
      actions: [],
    };
    const latestBlock = await ethers.provider.getBlock("latest");
    const deadline = latestBlock!.timestamp + 3600;
    const { predictedAgreement, signature } = await signDeterministicPermit(
      factory,
      owner,
      salt,
      deployment,
      deadline
    );
    const submit = (
      targetFactory: any,
      submittedSalt: string,
      docHash: string
    ) =>
      targetFactory.connect(relayer).createAgreementDeterministicWithPermit(
        owner.address,
        submittedSalt,
        deployment.docUri,
        docHash,
        deployment.initialState,
        deployment.inputDefs,
        deployment.transitions,
        deployment.initVars,
        deployment.verifiers,
        deployment.actions,
        deadline,
        signature
      );

    const differentSalt = ethers.keccak256(ethers.toUtf8Bytes("other-salt"));
    await expect(submit(factory, differentSalt, deployment.docHash))
      .to.be.revertedWithCustomError(factory, "InvalidSignature");

    const differentDigest = ethers.keccak256(
      ethers.toUtf8Bytes("mutated-package-digest")
    );
    await expect(submit(factory, salt, differentDigest))
      .to.be.revertedWithCustomError(factory, "InvalidSignature");

    await expect(submit(otherFactory, salt, deployment.docHash))
      .to.be.revertedWithCustomError(otherFactory, "InvalidSignature");

    expect(await factory.nonces(owner.address)).to.equal(0n);
    await expect(submit(factory, salt, deployment.docHash))
      .to.emit(factory, "AgreementDeployed")
      .withArgs(
        predictedAgreement,
        owner.address,
        deployment.docUri,
        deployment.docHash
      );

    const agreement = await ethers.getContractAt(
      "AgreementEngine",
      predictedAgreement
    );
    expect(await agreement.owner()).to.equal(owner.address);
    expect(await agreement.docHash()).to.equal(deployment.docHash);
    expect(await factory.nonces(owner.address)).to.equal(1n);
  });
});
