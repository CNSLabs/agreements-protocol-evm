// SPDX-License-Identifier: Apache-2.0

import { expect } from "chai";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Signer } from "ethers";
import { ethers } from "hardhat";

const solc: { compile(input: string): string } = require("solc");

const AGENT_ID = 42n;
const REPUTATION_TAG_1 = "quality";
const REPUTATION_TAG_2 = "agreement";
const MIN_REPUTATION = 750n;
const MIN_REPUTATION_DECIMALS = 2;
const VALIDATION_TAG = "delivery";
const MIN_VALIDATION_AVERAGE = 80;
const EMPTY_PAYLOAD = ethers.AbiCoder.defaultAbiCoder().encode(
  ["tuple(bytes32,uint8,bytes)[]"],
  [[]]
);

interface CompiledContract {
  abi: any;
  evm: {
    bytecode: {
      object: string;
    };
  };
}

interface SolcOutput {
  contracts?: Record<string, Record<string, CompiledContract>>;
  errors?: Array<{
    severity: string;
    formattedMessage: string;
  }>;
}

let compiledMocks: Record<string, CompiledContract> | undefined;

function compileTestContracts(): Record<string, CompiledContract> {
  if (compiledMocks !== undefined) return compiledMocks;

  const sourceName = "MockERC8004Registries.sol";
  const source = readFileSync(path.join(__dirname, "contracts", sourceName), "utf8");
  const input = {
    language: "Solidity",
    sources: {
      [sourceName]: { content: source },
    },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: {
        "*": {
          "*": ["abi", "evm.bytecode.object"],
        },
      },
    },
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input))) as SolcOutput;
  const errors = (output.errors ?? []).filter((error) => error.severity === "error");
  if (errors.length > 0) {
    throw new Error(errors.map((error) => error.formattedMessage).join("\n"));
  }

  const contracts = output.contracts?.[sourceName];
  if (contracts === undefined) throw new Error("test registry mocks did not compile");
  compiledMocks = contracts;
  return contracts;
}

async function deployTestContract(
  contractName: string,
  signer: Signer,
  args: unknown[] = []
): Promise<any> {
  const compiled = compileTestContracts()[contractName];
  if (compiled === undefined) throw new Error(`missing compiled test contract: ${contractName}`);

  const factory = new ethers.ContractFactory(
    compiled.abi,
    `0x${compiled.evm.bytecode.object}`,
    signer
  );
  const contract = await factory.deploy(...args);
  await contract.waitForDeployment();
  return contract;
}

describe("ERC8004AuthorityVerifier", function () {
  async function deployFixture() {
    const [
      deployer,
      owner,
      tokenApproved,
      operator,
      wallet,
      stranger,
      clientA,
      clientB,
      validator,
    ] = await ethers.getSigners();

    const identity = await deployTestContract(
      "MockERC8004IdentityRegistry",
      deployer
    );
    const identityAddress = await identity.getAddress();
    const reputation = await deployTestContract(
      "MockERC8004ReputationRegistry",
      deployer,
      [identityAddress]
    );
    const validation = await deployTestContract(
      "MockERC8004ValidationRegistry",
      deployer,
      [identityAddress]
    );

    const reputationClients = [clientA.address, clientB.address];
    const validationValidators = [validator.address];

    await identity.setAgent(AGENT_ID, owner.address, wallet.address);
    await identity.setApproved(AGENT_ID, tokenApproved.address);
    await identity.setApprovalForAll(owner.address, operator.address, true);

    await reputation.setExpectedQuery(
      AGENT_ID,
      reputationClients,
      REPUTATION_TAG_1,
      REPUTATION_TAG_2
    );
    await reputation.setSummary(2, 8, 0);
    await validation.setExpectedQuery(
      AGENT_ID,
      validationValidators,
      VALIDATION_TAG
    );
    await validation.setSummary(1, 90);

    const verifierArgs: any[] = [
      identityAddress,
      await reputation.getAddress(),
      await validation.getAddress(),
      AGENT_ID,
      reputationClients,
      REPUTATION_TAG_1,
      REPUTATION_TAG_2,
      MIN_REPUTATION,
      MIN_REPUTATION_DECIMALS,
      validationValidators,
      VALIDATION_TAG,
      MIN_VALIDATION_AVERAGE,
    ];
    const verifier = await ethers.deployContract(
      "ERC8004AuthorityVerifier",
      verifierArgs
    );
    await verifier.waitForDeployment();

    return {
      deployer,
      owner,
      tokenApproved,
      operator,
      wallet,
      stranger,
      clientA,
      clientB,
      validator,
      identity,
      reputation,
      validation,
      verifier,
      verifierArgs,
    };
  }

  async function verifyFor(verifier: any, sender: string) {
    const agreementCaller = await verifier.runner.getAddress();
    return verifier.verify(
      agreementCaller,
      ethers.ZeroHash,
      "0x",
      sender
    );
  }

  it("accepts the configured token owner, token approval, operator, and bound wallet", async function () {
    const { owner, tokenApproved, operator, wallet, verifier } =
      await deployFixture();

    for (const signer of [owner, tokenApproved, operator, wallet]) {
      await expect(verifyFor(verifier, signer.address)).not.to.be.reverted;
    }
  });

  it("rejects an account with no authority over the configured agent", async function () {
    const { stranger, verifier } = await deployFixture();

    await expect(verifyFor(verifier, stranger.address))
      .to.be.revertedWithCustomError(verifier, "SenderNotAuthorized")
      .withArgs(AGENT_ID, stranger.address);
  });

  it("requires the caller to match the supplied agreement address", async function () {
    const { deployer, owner, stranger, verifier } = await deployFixture();

    await expect(
      verifier.verify(
        stranger.address,
        ethers.ZeroHash,
        "0x",
        owner.address
      )
    )
      .to.be.revertedWithCustomError(verifier, "AgreementCallerMismatch")
      .withArgs(deployer.address, stranger.address);
  });

  it("does not treat the zero address as an authorized bound wallet", async function () {
    const { identity, verifier } = await deployFixture();
    await identity.setApproved(AGENT_ID, ethers.ZeroAddress);
    await identity.setAgentWallet(AGENT_ID, ethers.ZeroAddress);

    await expect(verifyFor(verifier, ethers.ZeroAddress))
      .to.be.revertedWithCustomError(verifier, "SenderNotAuthorized")
      .withArgs(AGENT_ID, ethers.ZeroAddress);
  });

  it("requires matching reputation evidence from the configured clients and tags", async function () {
    const { owner, reputation, verifier } = await deployFixture();
    await reputation.setSummary(0, 0, 0);

    await expect(verifyFor(verifier, owner.address))
      .to.be.revertedWithCustomError(verifier, "ReputationUnavailable")
      .withArgs(AGENT_ID);
  });

  it("compares reputation values and floors across decimal precisions", async function () {
    const { owner, reputation, verifier } = await deployFixture();

    await reputation.setSummary(1, 75, 1);
    await expect(verifyFor(verifier, owner.address)).not.to.be.reverted;

    await reputation.setSummary(1, 749, 2);
    await expect(verifyFor(verifier, owner.address))
      .to.be.revertedWithCustomError(verifier, "ReputationBelowFloor")
      .withArgs(
        AGENT_ID,
        749,
        2,
        MIN_REPUTATION,
        MIN_REPUTATION_DECIMALS
      );
  });

  it("normalizes signed reputation values without changing their ordering", async function () {
    const { owner, reputation, verifier, verifierArgs } =
      await deployFixture();
    const signedFloorArgs: any[] = [...verifierArgs];
    signedFloorArgs[7] = -750n;
    signedFloorArgs[8] = 2;
    const signedFloorVerifier = await ethers.deployContract(
      "ERC8004AuthorityVerifier",
      signedFloorArgs
    );
    await signedFloorVerifier.waitForDeployment();

    await reputation.setSummary(1, -75, 1);
    await expect(
      verifyFor(signedFloorVerifier, owner.address)
    ).not.to.be.reverted;

    await reputation.setSummary(1, -751, 2);
    await expect(verifyFor(signedFloorVerifier, owner.address))
      .to.be.revertedWithCustomError(
        signedFloorVerifier,
        "ReputationBelowFloor"
      )
      .withArgs(AGENT_ID, -751, 2, -750, 2);
  });

  it("rejects a reputation result with decimals outside the v2.0.0 range", async function () {
    const { owner, reputation, verifier } = await deployFixture();
    await reputation.setSummary(1, 8, 19);

    await expect(verifyFor(verifier, owner.address))
      .to.be.revertedWithCustomError(
        verifier,
        "UnsupportedReputationDecimals"
      )
      .withArgs(19);
  });

  it("requires a response from the configured validators with the configured tag", async function () {
    const { owner, validation, verifier } = await deployFixture();
    await validation.setSummary(0, 0);

    await expect(verifyFor(verifier, owner.address))
      .to.be.revertedWithCustomError(verifier, "ValidationUnavailable")
      .withArgs(AGENT_ID);
  });

  it("enforces the trusted-validator average floor", async function () {
    const { owner, validation, verifier } = await deployFixture();
    await validation.setSummary(2, 79);

    await expect(verifyFor(verifier, owner.address))
      .to.be.revertedWithCustomError(verifier, "ValidationBelowFloor")
      .withArgs(AGENT_ID, 79, MIN_VALIDATION_AVERAGE);
  });

  it("rejects a malformed validation average above the registry range", async function () {
    const { owner, validation, verifier } = await deployFixture();
    await validation.setSummary(1, 101);

    await expect(verifyFor(verifier, owner.address))
      .to.be.revertedWithCustomError(verifier, "InvalidValidationAverage")
      .withArgs(101);
  });

  it("fails closed when a registry no longer links to the configured identity", async function () {
    const { owner, stranger, reputation, verifier, identity } =
      await deployFixture();
    await reputation.setIdentityRegistry(stranger.address);

    await expect(verifyFor(verifier, owner.address))
      .to.be.revertedWithCustomError(verifier, "RegistryIdentityMismatch")
      .withArgs(
        await reputation.getAddress(),
        await identity.getAddress(),
        stranger.address
      );
  });

  it("fails closed when an identity registry read fails", async function () {
    const { owner, identity, verifier } = await deployFixture();
    await identity.setFailReads(true);

    await expect(verifyFor(verifier, owner.address)).to.be.revertedWith(
      "identity read failed"
    );
  });

  it("fails closed when reputation or validation registry reads fail", async function () {
    const { owner, reputation, validation, verifier } = await deployFixture();

    await reputation.setFailReads(true);
    await expect(verifyFor(verifier, owner.address)).to.be.revertedWith(
      "reputation read failed"
    );

    await reputation.setFailReads(false);
    await validation.setFailReads(true);
    await expect(verifyFor(verifier, owner.address)).to.be.revertedWith(
      "validation read failed"
    );
  });

  it("rejects empty, zero, or duplicate constructor trust lists", async function () {
    const { clientA, validator, verifier, verifierArgs } =
      await deployFixture();

    const emptyClientsArgs: any[] = [...verifierArgs];
    emptyClientsArgs[4] = [];
    await expect(
      ethers.deployContract("ERC8004AuthorityVerifier", emptyClientsArgs)
    ).to.be.revertedWithCustomError(verifier, "EmptyTrustedClients");

    const zeroClientArgs: any[] = [...verifierArgs];
    zeroClientArgs[4] = [ethers.ZeroAddress];
    await expect(
      ethers.deployContract("ERC8004AuthorityVerifier", zeroClientArgs)
    ).to.be.revertedWithCustomError(verifier, "ZeroTrustAddress");

    const duplicateClientArgs: any[] = [...verifierArgs];
    duplicateClientArgs[4] = [clientA.address, clientA.address];
    await expect(
      ethers.deployContract("ERC8004AuthorityVerifier", duplicateClientArgs)
    )
      .to.be.revertedWithCustomError(verifier, "DuplicateTrustAddress")
      .withArgs(clientA.address);

    const emptyValidatorsArgs: any[] = [...verifierArgs];
    emptyValidatorsArgs[9] = [];
    await expect(
      ethers.deployContract("ERC8004AuthorityVerifier", emptyValidatorsArgs)
    ).to.be.revertedWithCustomError(verifier, "EmptyTrustedValidators");

    const zeroValidatorArgs: any[] = [...verifierArgs];
    zeroValidatorArgs[9] = [ethers.ZeroAddress];
    await expect(
      ethers.deployContract("ERC8004AuthorityVerifier", zeroValidatorArgs)
    ).to.be.revertedWithCustomError(verifier, "ZeroTrustAddress");

    const duplicateValidatorArgs: any[] = [...verifierArgs];
    duplicateValidatorArgs[9] = [validator.address, validator.address];
    await expect(
      ethers.deployContract(
        "ERC8004AuthorityVerifier",
        duplicateValidatorArgs
      )
    )
      .to.be.revertedWithCustomError(verifier, "DuplicateTrustAddress")
      .withArgs(validator.address);

    const unsupportedDecimalsArgs: any[] = [...verifierArgs];
    unsupportedDecimalsArgs[8] = 19;
    await expect(
      ethers.deployContract(
        "ERC8004AuthorityVerifier",
        unsupportedDecimalsArgs
      )
    )
      .to.be.revertedWithCustomError(
        verifier,
        "UnsupportedReputationDecimals"
      )
      .withArgs(19);

    const invalidValidationFloorArgs: any[] = [...verifierArgs];
    invalidValidationFloorArgs[11] = 101;
    await expect(
      ethers.deployContract(
        "ERC8004AuthorityVerifier",
        invalidValidationFloorArgs
      )
    )
      .to.be.revertedWithCustomError(verifier, "InvalidValidationFloor")
      .withArgs(101);
  });

  it("rejects empty required reputation and validation tags", async function () {
    const { verifier, verifierArgs } = await deployFixture();

    const emptyReputationTagArgs: any[] = [...verifierArgs];
    emptyReputationTagArgs[5] = "";
    await expect(
      ethers.deployContract(
        "ERC8004AuthorityVerifier",
        emptyReputationTagArgs
      )
    ).to.be.revertedWithCustomError(verifier, "EmptyReputationTag");

    const emptyValidationTagArgs: any[] = [...verifierArgs];
    emptyValidationTagArgs[10] = "";
    await expect(
      ethers.deployContract(
        "ERC8004AuthorityVerifier",
        emptyValidationTagArgs
      )
    ).to.be.revertedWithCustomError(verifier, "EmptyValidationTag");
  });

  it("rejects empty registry addresses and mismatched initial registry links", async function () {
    const { stranger, validation, verifier, verifierArgs, identity } =
      await deployFixture();

    const zeroRegistryArgs: any[] = [...verifierArgs];
    zeroRegistryArgs[0] = ethers.ZeroAddress;
    await expect(
      ethers.deployContract("ERC8004AuthorityVerifier", zeroRegistryArgs)
    ).to.be.revertedWithCustomError(verifier, "ZeroRegistryAddress");

    await validation.setIdentityRegistry(stranger.address);
    await expect(
      ethers.deployContract("ERC8004AuthorityVerifier", verifierArgs)
    )
      .to.be.revertedWithCustomError(verifier, "RegistryIdentityMismatch")
      .withArgs(
        await validation.getAddress(),
        await identity.getAddress(),
        stranger.address
      );
  });

  it("blocks an unauthorized engine input and allows the configured agent authority", async function () {
    const { deployer, owner, stranger, verifier } = await deployFixture();
    const implementation = await ethers.deployContract("AgreementEngine");
    await implementation.waitForDeployment();
    const factory: any = await ethers.deployContract("AgreementFactory", [
      await implementation.getAddress(),
    ]);
    await factory.waitForDeployment();

    const start = ethers.id("START");
    const done = ethers.id("DONE");
    const advance = ethers.id("advance");
    const verifierKey = ethers.id("erc8004-authority");
    const inputDefs = [
      {
        id: advance,
        fields: [],
        conditions: [],
        verifierKeys: [verifierKey],
      },
    ];
    const transitions = [{ fromState: start, toState: done, inputId: advance }];
    const verifiers = [
      { key: verifierKey, verifier: await verifier.getAddress() },
    ];

    const agreementAddress = await factory
      .connect(deployer)
      .createAgreement.staticCall(
        "ipfs://erc8004-authority-example",
        ethers.id("document"),
        start,
        inputDefs,
        transitions,
        [],
        verifiers,
        []
      );
    await factory
      .connect(deployer)
      .createAgreement(
        "ipfs://erc8004-authority-example",
        ethers.id("document"),
        start,
        inputDefs,
        transitions,
        [],
        verifiers,
        []
      );
    const agreement: any = await ethers.getContractAt(
      "AgreementEngine",
      agreementAddress
    );

    await expect(
      agreement.connect(stranger).submitInput(advance, EMPTY_PAYLOAD)
    )
      .to.be.revertedWithCustomError(verifier, "SenderNotAuthorized")
      .withArgs(AGENT_ID, stranger.address);
    expect(await agreement.currentState()).to.equal(start);

    await expect(agreement.connect(owner).submitInput(advance, EMPTY_PAYLOAD))
      .to.emit(agreement, "InputAccepted")
      .withArgs(start, done, advance, EMPTY_PAYLOAD);
    expect(await agreement.currentState()).to.equal(done);
  });
});
