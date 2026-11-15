// SPDX-License-Identifier: Apache-2.0

import { expect } from "chai";
import { ethers } from "hardhat";
import manifest from "../deployments/erc8004/linea-sepolia.json";

const describeFork =
  process.env.HARDHAT_FORK === "true" ? describe : describe.skip;

const VERSION_AND_OWNER_ABI = [
  "function getVersion() view returns (string)",
  "function owner() view returns (address)",
];

const IDENTITY_ABI = [
  ...VERSION_AND_OWNER_ABI,
  "error ERC721NonexistentToken(uint256 tokenId)",
  "function ownerOf(uint256 agentId) view returns (address)",
  "function getAgentWallet(uint256 agentId) view returns (address)",
  "function tokenURI(uint256 agentId) view returns (string)",
];

const REPUTATION_ABI = [
  ...VERSION_AND_OWNER_ABI,
  "function getIdentityRegistry() view returns (address)",
  "function readAllFeedback(uint256 agentId,address[] clientAddresses,string tag1,string tag2,bool includeRevoked) view returns (address[] clients,uint64[] feedbackIndexes,int128[] values,uint8[] valueDecimals,string[] tag1s,string[] tag2s,bool[] revokedStatuses)",
  "event NewFeedback(uint256 indexed agentId,address indexed clientAddress,uint64 feedbackIndex,int128 value,uint8 valueDecimals,string indexed indexedTag1,string tag1,string tag2,string endpoint,string feedbackURI,bytes32 feedbackHash)",
];

const VALIDATION_ABI = [
  ...VERSION_AND_OWNER_ABI,
  "function getIdentityRegistry() view returns (address)",
  "function getAgentValidations(uint256 agentId) view returns (bytes32[])",
  "function getValidatorRequests(address validatorAddress) view returns (bytes32[])",
  "function getValidationStatus(bytes32 requestHash) view returns (address validatorAddress,uint256 agentId,uint8 response,bytes32 responseHash,string tag,uint256 lastUpdate)",
  "function getSummary(uint256 agentId,address[] validatorAddresses,string tag) view returns (uint64 count,uint8 avgResponse)",
  "event ValidationRequest(address indexed validatorAddress,uint256 indexed agentId,string requestURI,bytes32 indexed requestHash)",
];

type RegistryManifest = {
  proxy: string;
  version: string;
  proxyRuntimeBytecodeBytes: number;
  proxyRuntimeBytecodeHash: string;
  implementation: string;
  implementationRuntimeBytecodeBytes: number;
  implementationRuntimeBytecodeHash: string;
  identityRegistry?: string;
};

function checksum(address: string): string {
  return ethers.getAddress(address);
}

function byteLength(bytecode: string): number {
  return (bytecode.length - 2) / 2;
}

describeFork("ERC-8004 canonical Linea Sepolia snapshot", function () {
  this.timeout(120_000);

  before(async function () {
    const configuredForkBlock = Number(
      process.env.HARDHAT_FORK_BLOCK_NUMBER
    );
    if (configuredForkBlock !== manifest.network.forkBlockNumber) {
      throw new Error(
        `HARDHAT_FORK_BLOCK_NUMBER must equal the manifest pin ` +
          `${manifest.network.forkBlockNumber}`
      );
    }

    const forkBlock = await ethers.provider.getBlock(configuredForkBlock);
    if (forkBlock?.hash !== manifest.network.forkBlockHash) {
      throw new Error(
        `Fork block hash does not match the manifest pin: ${forkBlock?.hash}`
      );
    }

    // EDR cannot execute eth_call against the historical fork block for a
    // custom chain, even with hardfork history configured. Mine one empty,
    // local-only block so calls execute against identical inherited state.
    await ethers.provider.send("hardhat_mine", ["0x1"]);
  });

  it("forks the exact pinned block", async function () {
    const networkInfo = await ethers.provider.getNetwork();
    const block = await ethers.provider.getBlock(
      manifest.network.forkBlockNumber
    );

    expect(networkInfo.chainId).to.equal(BigInt(manifest.network.chainId));
    expect(await ethers.provider.getBlockNumber()).to.equal(
      manifest.network.forkBlockNumber + 1
    );
    expect(block).not.to.equal(null);
    expect(block!.hash).to.equal(manifest.network.forkBlockHash);
    expect(new Date(Number(block!.timestamp) * 1_000).toISOString()).to.equal(
      manifest.network.forkBlockTimestamp
    );

    const executionBlock = await ethers.provider.getBlock(
      manifest.network.forkBlockNumber + 1
    );
    expect(executionBlock).not.to.equal(null);
    expect(executionBlock!.parentHash).to.equal(manifest.network.forkBlockHash);
    expect(executionBlock!.transactions).to.deep.equal([]);
  });

  it("matches the pinned proxy and implementation provenance", async function () {
    const registries = Object.values(
      manifest.registries
    ) as RegistryManifest[];

    for (const registry of registries) {
      const proxyCode = await ethers.provider.getCode(registry.proxy);
      const implementationSlotValue = await ethers.provider.getStorage(
        registry.proxy,
        manifest.eip1967ImplementationSlot
      );
      const implementation = checksum(
        `0x${implementationSlotValue.slice(-40)}`
      );
      const implementationCode = await ethers.provider.getCode(implementation);

      expect(byteLength(proxyCode)).to.equal(
        registry.proxyRuntimeBytecodeBytes
      );
      expect(ethers.keccak256(proxyCode)).to.equal(
        registry.proxyRuntimeBytecodeHash
      );
      expect(implementation).to.equal(checksum(registry.implementation));
      expect(byteLength(implementationCode)).to.equal(
        registry.implementationRuntimeBytecodeBytes
      );
      expect(ethers.keccak256(implementationCode)).to.equal(
        registry.implementationRuntimeBytecodeHash
      );
    }
  });

  it("matches registry versions, ownership, and cross-registry wiring", async function () {
    const identity = new ethers.Contract(
      manifest.registries.identity.proxy,
      IDENTITY_ABI,
      ethers.provider
    );
    const reputation = new ethers.Contract(
      manifest.registries.reputation.proxy,
      REPUTATION_ABI,
      ethers.provider
    );
    const validation = new ethers.Contract(
      manifest.registries.validation.proxy,
      VALIDATION_ABI,
      ethers.provider
    );

    for (const [contract, registry] of [
      [identity, manifest.registries.identity],
      [reputation, manifest.registries.reputation],
      [validation, manifest.registries.validation],
    ] as const) {
      expect(await contract.getVersion()).to.equal(registry.version);
      expect(await contract.owner()).to.equal(
        checksum(manifest.registryOwner)
      );
    }

    expect(await reputation.getIdentityRegistry()).to.equal(
      checksum(manifest.registries.identity.proxy)
    );
    expect(await validation.getIdentityRegistry()).to.equal(
      checksum(manifest.registries.identity.proxy)
    );
  });

  it("reproduces the complete CNS-operated test snapshot at the pin", async function () {
    const identity = new ethers.Contract(
      manifest.registries.identity.proxy,
      IDENTITY_ABI,
      ethers.provider
    );
    const reputation = new ethers.Contract(
      manifest.registries.reputation.proxy,
      REPUTATION_ABI,
      ethers.provider
    );
    const validation = new ethers.Contract(
      manifest.registries.validation.proxy,
      VALIDATION_ABI,
      ethers.provider
    );

    for (const agent of manifest.observedUsageAtForkBlock.agents) {
      expect(await identity.ownerOf(agent.agentId)).to.equal(
        checksum(agent.owner)
      );
      expect(await identity.getAgentWallet(agent.agentId)).to.equal(
        checksum(agent.agentWallet)
      );
      expect(await identity.tokenURI(agent.agentId)).to.equal(agent.agentURI);

      const feedback = await reputation.readAllFeedback(
        agent.agentId,
        [],
        "",
        "",
        true
      );
      expect([...feedback[0]]).to.deep.equal(
        agent.reputationClients.map(checksum)
      );
      expect([...feedback[1]]).to.deep.equal([1n]);
      expect([...feedback[2]]).to.deep.equal([1n]);
      expect([...feedback[3]]).to.deep.equal([0n]);
      expect([...feedback[4]]).to.deep.equal(["agreement-lifecycle"]);
      expect([...feedback[5]]).to.deep.equal(["milestone-accepted"]);
      expect([...feedback[6]]).to.deep.equal([false]);

      expect([
        ...(await validation.getAgentValidations(agent.agentId)),
      ]).to.deep.equal(agent.validationRequestHashes);
    }

    await expect(
      identity.ownerOf(
        manifest.observedUsageAtForkBlock.nextAgentIdObservedAbsent
      )
    )
      .to.be.revertedWithCustomError(identity, "ERC721NonexistentToken")
      .withArgs(
        BigInt(manifest.observedUsageAtForkBlock.nextAgentIdObservedAbsent)
      );
  });

  it("binds the public transactions to Reputation and Validation state", async function () {
    const reputation = new ethers.Contract(
      manifest.registries.reputation.proxy,
      REPUTATION_ABI,
      ethers.provider
    );
    const validation = new ethers.Contract(
      manifest.registries.validation.proxy,
      VALIDATION_ABI,
      ethers.provider
    );
    const composition =
      manifest.knownPublicTransactions.agreementCompositionAndReputationFeedback;
    const request = manifest.knownPublicTransactions.validationRequest;

    const compositionReceipt = await ethers.provider.getTransactionReceipt(
      composition.hash
    );
    expect(compositionReceipt).not.to.equal(null);
    expect(compositionReceipt!.status).to.equal(composition.status);
    expect(compositionReceipt!.blockNumber).to.equal(composition.blockNumber);
    expect(compositionReceipt!.blockHash).to.equal(composition.blockHash);

    const feedbackLog = compositionReceipt!.logs.find(
      (log) =>
        checksum(log.address) ===
        checksum(manifest.registries.reputation.proxy)
    );
    expect(feedbackLog).not.to.equal(undefined);
    const parsedFeedback = reputation.interface.parseLog(feedbackLog!);
    expect(parsedFeedback).not.to.equal(null);
    expect(parsedFeedback!.name).to.equal("NewFeedback");
    expect(parsedFeedback!.args.agentId).to.equal(2n);
    expect(parsedFeedback!.args.clientAddress).to.equal(
      checksum(
        manifest.observedUsageAtForkBlock.agents[2].reputationClients[0]
      )
    );
    expect(parsedFeedback!.args.feedbackIndex).to.equal(1n);
    expect(parsedFeedback!.args.tag1).to.equal("agreement-lifecycle");
    expect(parsedFeedback!.args.tag2).to.equal("milestone-accepted");

    const requestReceipt = await ethers.provider.getTransactionReceipt(
      request.hash
    );
    expect(requestReceipt).not.to.equal(null);
    expect(requestReceipt!.status).to.equal(request.status);
    expect(requestReceipt!.blockNumber).to.equal(request.blockNumber);
    expect(requestReceipt!.blockHash).to.equal(request.blockHash);
    expect(requestReceipt!.from).to.equal(checksum(request.from));
    expect(requestReceipt!.to).to.equal(
      checksum(manifest.registries.validation.proxy)
    );

    const requestLog = requestReceipt!.logs.find(
      (log) =>
        checksum(log.address) ===
        checksum(manifest.registries.validation.proxy)
    );
    expect(requestLog).not.to.equal(undefined);
    const parsedRequest = validation.interface.parseLog(requestLog!);
    expect(parsedRequest).not.to.equal(null);
    expect(parsedRequest!.name).to.equal("ValidationRequest");
    expect(parsedRequest!.args.validatorAddress).to.equal(
      checksum(request.validator)
    );
    expect(parsedRequest!.args.agentId).to.equal(BigInt(request.agentId));
    expect(parsedRequest!.args.requestHash).to.equal(request.requestHash);

    const status = await validation.getValidationStatus(request.requestHash);
    expect(status.validatorAddress).to.equal(checksum(request.validator));
    expect(status.agentId).to.equal(BigInt(request.agentId));
    expect(status.response).to.equal(0n);
    expect(status.responseHash).to.equal(ethers.ZeroHash);
    expect(status.tag).to.equal("");

    expect(
      await validation.getValidatorRequests(request.validator)
    ).to.deep.equal([request.requestHash]);

    const summary = await validation.getSummary(
      request.agentId,
      [request.validator],
      ""
    );
    expect(summary.count).to.equal(
      BigInt(request.responseCountAtForkBlock)
    );
    expect(summary.avgResponse).to.equal(0n);
  });
});
