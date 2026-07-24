// SPDX-License-Identifier: Apache-2.0
//
// Live Linea Sepolia proof for MetaMask Agent Wallet composition with the
// ERC-8004 Validation Registry listed in the official testnet address config.
//
// The validator is the configured Linea Sepolia runner signer. It must be
// distinct from the Agent Wallet and must not be an approved operator for the
// agent identity. The runner never changes the Agent Wallet policy and refuses
// to emit PASS unless the policy is still byte-for-byte unchanged at the end.

import { ethers, network } from "hardhat";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { JsonRpcProvider, TransactionReceipt } from "ethers";

const CHAIN_ID = 59141;
const RPC_URL =
  process.env.LINEA_SEPOLIA_RPC_URL || "https://rpc.sepolia.linea.build";
const SECONDARY_RPC_URL =
  process.env.VALIDATION_SECONDARY_RPC_URL ||
  "https://linea-sepolia-rpc.publicnode.com";
const EXPLORER_TX = "https://sepolia.lineascan.build/tx/";
const EXPLORER_ADDRESS = "https://sepolia.lineascan.build/address/";

const IDENTITY_REGISTRY = "0x8004A818BFB912233c491871b3d84c89A494BD9e";
const REPUTATION_REGISTRY = "0x8004B663056A597Dffe9eCcC1965A193B7388713";
const VALIDATION_REGISTRY = "0x8004Cb1BF31DAf7788923b405b754f57acEB4272";
const DELEGATION_MANAGER = "0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3";
const EXPECTED_IMPLEMENTATION = "0xdB31F5d9167f8eBc8b30FBbF814c4D297C2d7f99";
const EXPECTED_OWNER = "0x547289319C3e6aedB179C0b8e8aF0B5ACd062603";
const AGENT_ID = 2n;
const SUBJECT_TRANSACTION =
  "0xcdbc193bb4cffa2ed874fbf53e0bac618f9da2dcf6936f83e77ad42763693a9a";
const SUBJECT_AGREEMENT = "0xd0465017fb4A3c603cb3b315C0EF82a3d21E3A4d";
const SOURCE_REPOSITORY = "https://github.com/erc-8004/erc-8004-contracts";
const SOURCE_COMMIT = "68fc6765761a10fb26f0692df21c8a6f9d12b1be";
const VALIDATION_SOURCE_COMMIT =
  "27caef926f8529491256da5b86804cf827d44b93";
const PROXY_CREATION_TRANSACTION =
  "0xe0eb7e52b0daacecfcd14a95a8af860a98644ed52f7467634f0b53830d5f327e";
const IMPLEMENTATION_CREATION_TRANSACTION =
  "0xecd8eaac18e96da58434e3cf034a62b10005d99d1d83ce293a964cecaf2c3130";
const UPGRADE_TRANSACTION =
  "0x964d1ec9c3e60052541e5371a37bf4e318d3fabb40720f425da67a04a1547194";
const EIP1967_IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const ERROR_STRING_SELECTOR = "0x08c379a0";
const EXPLICIT_GAS = "0x7a120";
const DONE_STATE = ethers.keccak256(ethers.toUtf8Bytes("DONE"));
const execFileAsync = promisify(execFile);

const validationAbi = [
  "event ValidationRequest(address indexed validatorAddress,uint256 indexed agentId,string requestURI,bytes32 indexed requestHash)",
  "event ValidationResponse(address indexed validatorAddress,uint256 indexed agentId,bytes32 indexed requestHash,uint8 response,string responseURI,bytes32 responseHash,string tag)",
  "function validationRequest(address validatorAddress,uint256 agentId,string requestURI,bytes32 requestHash)",
  "function validationResponse(bytes32 requestHash,uint8 response,string responseURI,bytes32 responseHash,string tag)",
  "function getValidationStatus(bytes32 requestHash) view returns (address validatorAddress,uint256 agentId,uint8 response,bytes32 responseHash,string tag,uint256 lastUpdate)",
  "function getSummary(uint256 agentId,address[] validatorAddresses,string tag) view returns (uint64 count,uint8 avgResponse)",
  "function getAgentValidations(uint256 agentId) view returns (bytes32[])",
  "function getValidatorRequests(address validatorAddress) view returns (bytes32[])",
  "function getIdentityRegistry() view returns (address)",
  "function getVersion() pure returns (string)",
  "function owner() view returns (address)",
] as const;

const identityAbi = [
  "function ownerOf(uint256 agentId) view returns (address)",
  "function getAgentWallet(uint256 agentId) view returns (address)",
  "function getApproved(uint256 agentId) view returns (address)",
  "function isApprovedForAll(address owner,address operator) view returns (bool)",
  "function getVersion() pure returns (string)",
] as const;

const reputationAbi = [
  "event NewFeedback(uint256 indexed agentId,address indexed clientAddress,uint64 feedbackIndex,int128 value,uint8 valueDecimals,string indexed indexedTag1,string tag1,string tag2,string endpoint,string feedbackURI,bytes32 feedbackHash)",
  "function readFeedback(uint256 agentId,address clientAddress,uint64 feedbackIndex) view returns (int128 value,uint8 valueDecimals,string tag1,string tag2,bool isRevoked)",
] as const;

const agreementAbi = [
  "function currentState() view returns (bytes32)",
] as const;

const upgradeAbi = [
  "function upgradeToAndCall(address newImplementation,bytes data)",
] as const;

const initializeAbi = [
  "function initialize(address identityRegistry)",
] as const;

type JsonObject = Record<string, unknown>;

type AgentWalletTransaction = {
  hash: string;
  walletResult: JsonObject;
};

type AgentWalletPolicy = {
  policy: string;
  address: string;
};

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function findStringByKey(value: unknown, keys: Set<string>): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const match = findStringByKey(item, keys);
      if (match) return match;
    }
    return undefined;
  }
  if (!isJsonObject(value)) return undefined;
  for (const [key, child] of Object.entries(value)) {
    if (keys.has(key) && typeof child === "string") return child;
  }
  for (const child of Object.values(value)) {
    const match = findStringByKey(child, keys);
    if (match) return match;
  }
  return undefined;
}

function extractRevertData(error: unknown): string | undefined {
  const visited = new Set<unknown>();
  const queue: unknown[] = [error];
  while (queue.length > 0) {
    const current = queue.shift();
    if (visited.has(current)) continue;
    visited.add(current);
    if (typeof current === "string") {
      const match = current.match(/0x[0-9a-fA-F]{8,}/);
      if (match) return match[0];
      continue;
    }
    if (!isJsonObject(current)) continue;
    for (const [key, child] of Object.entries(current)) {
      if (
        (key === "data" || key === "result") &&
        typeof child === "string" &&
        /^0x[0-9a-fA-F]+$/.test(child)
      ) {
        return child;
      }
      queue.push(child);
    }
  }
  return undefined;
}

function decodeErrorString(data: string | undefined): string | undefined {
  if (!data || data.slice(0, 10).toLowerCase() !== ERROR_STRING_SELECTOR) {
    return undefined;
  }
  try {
    return ethers.AbiCoder.defaultAbiCoder().decode(
      ["string"],
      `0x${data.slice(10)}`,
    )[0] as string;
  } catch {
    return undefined;
  }
}

function dataUri(document: JsonObject): { json: string; uri: string; hash: string } {
  const json = JSON.stringify(document);
  return {
    json,
    uri: `data:application/json;base64,${Buffer.from(json).toString("base64")}`,
    hash: ethers.keccak256(ethers.toUtf8Bytes(json)),
  };
}

async function runAgentWalletCommand(args: string[]): Promise<JsonObject> {
  const cliBin =
    process.env.AGENT_WALLET_CLI_BIN || "mm";
  const nodeBin = process.env.AGENT_WALLET_NODE_BIN;
  const command = nodeBin || cliBin;
  const commandArgs = nodeBin ? [cliBin, ...args, "--json"] : [...args, "--json"];
  try {
    const result = await execFileAsync(command, commandArgs, {
      env: process.env,
      maxBuffer: 10 * 1024 * 1024,
      timeout: 11 * 60 * 1000,
    });
    const parsed = JSON.parse(String(result.stdout).trim()) as JsonObject;
    if (parsed.ok !== true || !isJsonObject(parsed.data)) {
      throw new Error(`Agent Wallet command failed: ${String(result.stdout).trim()}`);
    }
    return parsed.data;
  } catch (error) {
    const detail = error as Error & {
      stdout?: string | Buffer;
      stderr?: string | Buffer;
    };
    const stdout = String(detail.stdout || "").trim();
    if (stdout) {
      try {
        const parsed = JSON.parse(stdout) as JsonObject;
        if (parsed.ok === true && isJsonObject(parsed.data)) return parsed.data;
      } catch {
        // Fall through to the bounded diagnostic below.
      }
    }
    const diagnostic = String(detail.stderr || stdout || detail.message).trim();
    throw new Error(
      `Agent Wallet command '${args.slice(0, 3).join(" ")}' failed: ${diagnostic}`,
      { cause: error },
    );
  }
}

async function requireReadyAgentWallet(): Promise<JsonObject> {
  const doctor = await runAgentWalletCommand(["doctor"]);
  if (doctor.authenticated !== true || doctor.initialized !== true) {
    throw new Error("MetaMask Agent Wallet is not authenticated and initialized");
  }
  return doctor;
}

async function resolveAgentWalletAddress(): Promise<string> {
  const result = await runAgentWalletCommand(["wallet", "address"]);
  const address = findStringByKey(result, new Set(["address", "evmAddress"]));
  if (!address || !ethers.isAddress(address)) {
    throw new Error("MetaMask Agent Wallet did not return a valid EVM address");
  }
  return ethers.getAddress(address);
}

function assertAgentWalletResult(
  result: JsonObject,
  expectedAddress: string,
  operation: string,
): void {
  const resultAddress = findStringByKey(
    result,
    new Set(["address", "evmAddress"]),
  );
  if (
    !resultAddress ||
    !ethers.isAddress(resultAddress) ||
    resultAddress.toLowerCase() !== expectedAddress.toLowerCase()
  ) {
    throw new Error(
      `${operation} returned wallet ${resultAddress || "unknown"}; expected ${expectedAddress}`,
    );
  }
}

async function getAgentWalletPolicy(
  expectedAddress: string,
): Promise<AgentWalletPolicy> {
  const result = await runAgentWalletCommand(["wallet", "policy", "get"]);
  if (typeof result.policy !== "string") {
    throw new Error("MetaMask Agent Wallet did not return policy YAML");
  }
  assertAgentWalletResult(result, expectedAddress, "Policy read");
  return { policy: result.policy, address: expectedAddress };
}

function policyFingerprint(policy: string): string {
  const wallet = policy.match(/wallet_address:\s*"([^"]+)"/);
  const addresses = policy.match(
    /addresses:\n  allowlist:\n((?:    - "[^"]+"\n)*)  blocklist:([^\n]*)/,
  );
  const chains = policy.match(
    /  allowed_chains:\n((?:    - [0-9]+\n)*)  outflow_limits_usd:/,
  );
  const outflow = policy.match(/    rolling_24h: ([0-9]+(?:\.[0-9]+)?)/);
  if (!wallet || !addresses || !chains || !outflow) {
    throw new Error("Unexpected Agent Wallet policy shape");
  }
  const allowlist = Array.from(
    addresses[1].matchAll(/    - "([^"]+)"\n/g),
    (match) => match[1].toLowerCase(),
  ).sort();
  const allowedChains = Array.from(
    chains[1].matchAll(/    - ([0-9]+)\n/g),
    (match) => Number(match[1]),
  ).sort((left, right) => left - right);
  return JSON.stringify({
    wallet: wallet[1].toLowerCase(),
    allowlist,
    blocklist: addresses[2].trim().toLowerCase(),
    allowedChains,
    rolling24hUsd: Number(outflow[1]),
  });
}

async function sendAgentWalletTransaction(
  agentWallet: string,
  to: string,
  data: string,
  value: bigint,
  intent: string,
  gas = EXPLICIT_GAS,
): Promise<AgentWalletTransaction> {
  const result = await runAgentWalletCommand([
    "wallet",
    "send-transaction",
    "--chain-id",
    String(CHAIN_ID),
    "--payload",
    JSON.stringify({
      to,
      data,
      value: ethers.toQuantity(value),
      gas,
    }),
    "--intent",
    intent,
    "--wait",
  ]);
  const hash = findStringByKey(
    result,
    new Set(["hash", "txHash", "transactionHash"]),
  );
  if (!hash || !/^0x[0-9a-fA-F]{64}$/.test(hash)) {
    throw new Error("MetaMask Agent Wallet did not return a transaction hash");
  }
  assertAgentWalletResult(result, agentWallet, "Transaction submission");
  return { hash, walletResult: result };
}

async function waitForReceipt(
  provider: JsonRpcProvider,
  hash: string,
): Promise<TransactionReceipt> {
  const deadline = Date.now() + 6 * 60 * 1000;
  while (Date.now() < deadline) {
    const receipt = await provider.getTransactionReceipt(hash);
    if (receipt) return receipt;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`Timed out waiting for receipt ${hash}`);
}

async function receiptRecord(
  provider: JsonRpcProvider,
  receipt: TransactionReceipt,
): Promise<JsonObject> {
  const [block, transaction] = await Promise.all([
    provider.getBlock(receipt.blockNumber),
    provider.getTransaction(receipt.hash),
  ]);
  if (!block || !transaction) {
    throw new Error(`Missing block or transaction for ${receipt.hash}`);
  }
  return {
    hash: receipt.hash,
    url: `${EXPLORER_TX}${receipt.hash}`,
    from: receipt.from,
    to: receipt.to,
    blockNumber: receipt.blockNumber,
    blockHash: receipt.blockHash,
    timestamp: new Date(block.timestamp * 1000).toISOString(),
    status: receipt.status,
    gasUsed: receipt.gasUsed.toString(),
    nonce: transaction.nonce,
    value: transaction.value.toString(),
    data: transaction.data,
    dataHash: ethers.keccak256(transaction.data),
    transactionType: transaction.type,
    logCount: receipt.logs.length,
  };
}

async function assertMinedStatus(
  provider: JsonRpcProvider,
  hash: string,
  expectedStatus: number,
): Promise<TransactionReceipt> {
  const receipt = await waitForReceipt(provider, hash);
  if (receipt.status !== expectedStatus) {
    throw new Error(
      `Transaction ${hash} status was ${receipt.status}; expected ${expectedStatus}`,
    );
  }
  return receipt;
}

async function assertTransactionBinding(
  provider: JsonRpcProvider,
  receipt: TransactionReceipt,
  expected: {
    from: string;
    to: string;
    data: string;
    value: bigint;
  },
): Promise<void> {
  const transaction = await provider.getTransaction(receipt.hash);
  if (
    !transaction ||
    transaction.from.toLowerCase() !== expected.from.toLowerCase() ||
    transaction.to?.toLowerCase() !== expected.to.toLowerCase() ||
    transaction.data.toLowerCase() !== expected.data.toLowerCase() ||
    transaction.value !== expected.value
  ) {
    throw new Error(`Transaction ${receipt.hash} did not match its intended payload`);
  }
}

async function bindRevert(
  provider: JsonRpcProvider,
  receipt: TransactionReceipt,
  expectedReason: string,
): Promise<JsonObject> {
  const transaction = await provider.getTransaction(receipt.hash);
  if (!transaction || !transaction.to) {
    throw new Error(`Missing transaction payload for ${receipt.hash}`);
  }
  let revertData: string | undefined;
  try {
    await provider.send("eth_call", [
      {
        from: transaction.from,
        to: transaction.to,
        data: transaction.data,
        value: ethers.toQuantity(transaction.value),
        gas: ethers.toQuantity(transaction.gasLimit),
      },
      ethers.toQuantity(receipt.blockNumber),
    ]);
  } catch (error) {
    revertData = extractRevertData(error);
  }
  const reason = decodeErrorString(revertData);
  if (reason !== expectedReason) {
    throw new Error(
      `Pinned replay for ${receipt.hash} returned '${reason || "unknown"}'; expected '${expectedReason}'`,
    );
  }
  return {
    method:
      "eth_call of the identical payload from the identical sender at the mined block",
    blockNumber: receipt.blockNumber,
    revertData,
    selector: revertData?.slice(0, 10),
    error: reason,
  };
}

async function bindViewRevert(
  provider: JsonRpcProvider,
  to: string,
  data: string,
  blockNumber: number,
  expectedReason: string,
): Promise<JsonObject> {
  let revertData: string | undefined;
  try {
    await provider.send("eth_call", [
      { to, data },
      ethers.toQuantity(blockNumber),
    ]);
  } catch (error) {
    revertData = extractRevertData(error);
  }
  const reason = decodeErrorString(revertData);
  if (reason !== expectedReason) {
    throw new Error(
      `View call at block ${blockNumber} returned '${reason || "unknown"}'; expected '${expectedReason}'`,
    );
  }
  return {
    method: "eth_call at the mined control block",
    blockNumber,
    revertData,
    selector: revertData?.slice(0, 10),
    error: reason,
  };
}

async function gitMetadata(): Promise<{
  commit: string;
  workingTreeDirty: boolean;
}> {
  const root = path.resolve(__dirname, "../..");
  const [commit, status] = await Promise.all([
    execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root }),
    execFileAsync("git", ["status", "--porcelain"], { cwd: root }),
  ]);
  return {
    commit: String(commit.stdout).trim(),
    workingTreeDirty: String(status.stdout).trim().length > 0,
  };
}

async function main() {
  if (network.name !== "lineaSepolia") {
    throw new Error("Run this proof with --network lineaSepolia");
  }

  const primaryUrl = new URL(RPC_URL);
  const secondaryUrl = new URL(SECONDARY_RPC_URL);
  const localHosts = new Set(["localhost", "127.0.0.1", "::1"]);
  if (
    localHosts.has(primaryUrl.hostname) ||
    localHosts.has(secondaryUrl.hostname) ||
    primaryUrl.href === secondaryUrl.href
  ) {
    throw new Error(
      "This public proof requires two distinct, non-local Linea Sepolia RPC endpoints",
    );
  }
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const secondaryProvider = new ethers.JsonRpcProvider(SECONDARY_RPC_URL);
  const [primaryChainId, secondaryChainId] = await Promise.all([
    provider.send("eth_chainId", []),
    secondaryProvider.send("eth_chainId", []),
  ]);
  if (
    BigInt(primaryChainId) !== BigInt(CHAIN_ID) ||
    BigInt(secondaryChainId) !== BigInt(CHAIN_ID)
  ) {
    throw new Error(
      `RPC chain mismatch: primary=${primaryChainId}, secondary=${secondaryChainId}`,
    );
  }
  const sourceGit = await gitMetadata();
  if (sourceGit.workingTreeDirty) {
    throw new Error(
      "Refusing to emit public evidence from a dirty working tree; commit the exact runner first",
    );
  }

  const agentWalletDoctor = await requireReadyAgentWallet();
  const agentWallet = await resolveAgentWalletAddress();
  const [validatorWallet] = await ethers.getSigners();
  if (!validatorWallet) {
    throw new Error(
      "A configured Linea Sepolia signer is required for the distinct validator",
    );
  }
  const validatorAddress = await validatorWallet.getAddress();
  const configuredValidatorAddress =
    process.env.VALIDATION_PROOF_VALIDATOR_ADDRESS;
  if (
    !configuredValidatorAddress ||
    !ethers.isAddress(configuredValidatorAddress)
  ) {
    throw new Error(
      "VALIDATION_PROOF_VALIDATOR_ADDRESS must pin the public address of the configured test signer",
    );
  }
  const validatorExpectedAddress = ethers.getAddress(
    configuredValidatorAddress,
  );
  if (
    validatorAddress.toLowerCase() !== validatorExpectedAddress.toLowerCase()
  ) {
    throw new Error(
      `Configured validator was ${validatorAddress}; expected ${validatorExpectedAddress}`,
    );
  }
  if (validatorAddress.toLowerCase() === agentWallet.toLowerCase()) {
    throw new Error("Configured validator unexpectedly equals Agent Wallet");
  }
  const identity = new ethers.Contract(IDENTITY_REGISTRY, identityAbi, provider);
  const validation = new ethers.Contract(
    VALIDATION_REGISTRY,
    validationAbi,
    provider,
  );
  const reputation = new ethers.Contract(
    REPUTATION_REGISTRY,
    reputationAbi,
    provider,
  );
  const agreement = new ethers.Contract(
    SUBJECT_AGREEMENT,
    agreementAbi,
    provider,
  );
  const validationInterface = new ethers.Interface(validationAbi);
  const reputationInterface = new ethers.Interface(reputationAbi);

  const [
    identityCode,
    proxyCode,
    version,
    linkedIdentity,
    registryOwner,
    identityOwner,
    registeredAgentWallet,
    identityVersion,
    implementationSlot,
    preAgentValidations,
    identityApproved,
    validatorApprovedForAll,
    validatorBalance,
    agentWalletBalance,
    feeData,
  ] = await Promise.all([
    provider.getCode(IDENTITY_REGISTRY),
    provider.getCode(VALIDATION_REGISTRY),
    validation.getVersion() as Promise<string>,
    validation.getIdentityRegistry() as Promise<string>,
    validation.owner() as Promise<string>,
    identity.ownerOf(AGENT_ID) as Promise<string>,
    identity.getAgentWallet(AGENT_ID) as Promise<string>,
    identity.getVersion() as Promise<string>,
    provider.getStorage(VALIDATION_REGISTRY, EIP1967_IMPLEMENTATION_SLOT),
    validation.getAgentValidations(AGENT_ID) as Promise<string[]>,
    identity.getApproved(AGENT_ID) as Promise<string>,
    identity.isApprovedForAll(agentWallet, validatorAddress) as Promise<boolean>,
    provider.getBalance(validatorAddress),
    provider.getBalance(agentWallet),
    provider.getFeeData(),
  ]);

  const implementation = ethers.getAddress(
    `0x${implementationSlot.slice(-40)}`,
  );
  const implementationCode = await provider.getCode(implementation);
  const [
    proxyCreationReceipt,
    implementationCreationReceipt,
    upgradeReceipt,
    upgradeTransaction,
  ] = await Promise.all([
    provider.getTransactionReceipt(PROXY_CREATION_TRANSACTION),
    provider.getTransactionReceipt(IMPLEMENTATION_CREATION_TRANSACTION),
    provider.getTransactionReceipt(UPGRADE_TRANSACTION),
    provider.getTransaction(UPGRADE_TRANSACTION),
  ]);
  if (
    !proxyCreationReceipt ||
    proxyCreationReceipt.status !== 1 ||
    !implementationCreationReceipt ||
    implementationCreationReceipt.status !== 1 ||
    !upgradeReceipt ||
    upgradeReceipt.status !== 1 ||
    !upgradeTransaction ||
    upgradeTransaction.to?.toLowerCase() !== VALIDATION_REGISTRY.toLowerCase()
  ) {
    throw new Error(
      "One or more pinned Validation Registry deployment transactions failed verification",
    );
  }
  const upgradeInterface = new ethers.Interface(upgradeAbi);
  const initializeInterface = new ethers.Interface(initializeAbi);
  const decodedUpgrade = upgradeInterface.decodeFunctionData(
    "upgradeToAndCall",
    upgradeTransaction.data,
  );
  const decodedInitialize = initializeInterface.decodeFunctionData(
    "initialize",
    decodedUpgrade.data,
  );
  if (
    decodedUpgrade.newImplementation.toLowerCase() !==
      EXPECTED_IMPLEMENTATION.toLowerCase() ||
    decodedInitialize.identityRegistry.toLowerCase() !==
      IDENTITY_REGISTRY.toLowerCase()
  ) {
    throw new Error(
      "Pinned upgrade transaction does not install the expected implementation and Identity Registry",
    );
  }
  const expected = [
    [version, "2.0.0", "Validation Registry version"],
    [linkedIdentity, IDENTITY_REGISTRY, "linked Identity Registry"],
    [registryOwner, EXPECTED_OWNER, "Validation Registry owner"],
    [identityOwner, agentWallet, "ERC-8004 identity owner"],
    [registeredAgentWallet, agentWallet, "ERC-8004 agent wallet"],
    [implementation, EXPECTED_IMPLEMENTATION, "proxy implementation"],
  ] as const;
  for (const [actual, wanted, label] of expected) {
    if (actual.toLowerCase() !== wanted.toLowerCase()) {
      throw new Error(`${label} was ${actual}; expected ${wanted}`);
    }
  }
  for (const [code, label] of [
    [identityCode, "Identity Registry"],
    [proxyCode, "Validation Registry proxy"],
    [implementationCode, "Validation Registry implementation"],
  ] as const) {
    if (code === "0x") throw new Error(`${label} has no deployed bytecode`);
  }
  if (
    identityApproved.toLowerCase() === validatorAddress.toLowerCase() ||
    validatorApprovedForAll
  ) {
    throw new Error(
      "Configured validator is already authorized for agent 2; unauthorized-request control would be invalid",
    );
  }
  if (validatorBalance === 0n) {
    throw new Error("Configured validator has no Linea Sepolia balance for gas");
  }
  const proofGasPrice = feeData.maxFeePerGas ?? feeData.gasPrice;
  if (!proofGasPrice) {
    throw new Error("RPC did not return a gas price for proof preflight");
  }
  const validatorGasBudget = proofGasPrice * 500_000n * 5n * 2n;
  const agentWalletGasBudget =
    proofGasPrice * BigInt(EXPLICIT_GAS) * 2n * 2n;
  if (validatorBalance < validatorGasBudget) {
    throw new Error(
      `Configured validator balance ${validatorBalance} is below the conservative proof gas budget ${validatorGasBudget}`,
    );
  }
  if (agentWalletBalance < agentWalletGasBudget) {
    throw new Error(
      `Agent Wallet balance ${agentWalletBalance} is below the conservative proof gas budget ${agentWalletGasBudget}`,
    );
  }

  const subjectReceipt = await provider.getTransactionReceipt(
    SUBJECT_TRANSACTION,
  );
  if (
    !subjectReceipt ||
    subjectReceipt.status !== 1 ||
    subjectReceipt.from.toLowerCase() !== agentWallet.toLowerCase() ||
    subjectReceipt.to?.toLowerCase() !== DELEGATION_MANAGER.toLowerCase()
  ) {
    throw new Error(
      "Pinned composition transaction was not a successful Agent Wallet call to the Delegation Manager",
    );
  }
  const subjectFeedbackEvent = subjectReceipt.logs
    .filter(
      (log) => log.address.toLowerCase() === REPUTATION_REGISTRY.toLowerCase(),
    )
    .map((log) => {
      try {
        return reputationInterface.parseLog(log);
      } catch {
        return null;
      }
    })
    .find((event) => event?.name === "NewFeedback");
  if (
    !subjectFeedbackEvent ||
    subjectFeedbackEvent.args.agentId !== AGENT_ID ||
    subjectFeedbackEvent.args.clientAddress.toLowerCase() !==
      SUBJECT_AGREEMENT.toLowerCase() ||
    subjectFeedbackEvent.args.feedbackIndex !== 1n ||
    subjectFeedbackEvent.args.value !== 1n ||
    subjectFeedbackEvent.args.tag1 !== "agreement-lifecycle" ||
    subjectFeedbackEvent.args.tag2 !== "milestone-accepted"
  ) {
    throw new Error(
      "Pinned composition transaction did not contain the expected ERC-8004 feedback event",
    );
  }
  const [subjectState, subjectFeedback] = await Promise.all([
    agreement.currentState() as Promise<string>,
    reputation.readFeedback(
      AGENT_ID,
      SUBJECT_AGREEMENT,
      1n,
    ) as Promise<{
      value: bigint;
      valueDecimals: bigint;
      tag1: string;
      tag2: string;
      isRevoked: boolean;
    }>,
  ]);
  if (
    subjectState.toLowerCase() !== DONE_STATE.toLowerCase() ||
    subjectFeedback.value !== 1n ||
    subjectFeedback.tag1 !== "agreement-lifecycle" ||
    subjectFeedback.tag2 !== "milestone-accepted" ||
    subjectFeedback.isRevoked
  ) {
    throw new Error(
      "Pinned composition agreement state or ERC-8004 feedback readback no longer matches the validation subject",
    );
  }

  const capturedAt = new Date().toISOString();
  const requestDocument: JsonObject = {
    schema: "urn:shodai:erc8004-validation-request:1",
    capturedAt,
    network: "linea-sepolia",
    chainId: CHAIN_ID,
    agentId: AGENT_ID.toString(),
    agentWallet,
    validator: validatorAddress,
    subject: {
      transactionHash: SUBJECT_TRANSACTION,
      agreement: SUBJECT_AGREEMENT,
      assertion:
        "The referenced Agent Wallet transaction completed the delegated agreement lifecycle and emitted its ERC-8004 Reputation Registry feedback.",
    },
  };
  const requestPayload = dataUri(requestDocument);
  const responseDocument: JsonObject = {
    schema: "urn:shodai:erc8004-validation-response:1",
    requestHash: requestPayload.hash,
    validator: validatorAddress,
    response: 100,
    tag: "agreement-lifecycle",
    finding:
      "Validated against the referenced public transaction receipt and on-chain state.",
  };
  const responsePayload = dataUri(responseDocument);
  const unauthorizedPayload = dataUri({
    schema: "urn:shodai:erc8004-negative-control:1",
    capturedAt,
    control: "unauthorized-request",
    agentId: AGENT_ID.toString(),
    validator: validatorAddress,
  });
  const zeroValidatorPayload = dataUri({
    schema: "urn:shodai:erc8004-negative-control:1",
    capturedAt,
    control: "zero-validator",
    requestHash: requestPayload.hash,
  });
  const preValidatorRequests = (await validation.getValidatorRequests(
    validatorAddress,
  )) as string[];
  if (
    preAgentValidations.some(
      (hash) => hash.toLowerCase() === requestPayload.hash.toLowerCase(),
    ) ||
    preValidatorRequests.some(
      (hash) => hash.toLowerCase() === requestPayload.hash.toLowerCase(),
    )
  ) {
    throw new Error("Fresh validation request hash already exists in an index");
  }

  const originalPolicyRecord = await getAgentWalletPolicy(agentWallet);
  const originalPolicy = originalPolicyRecord.policy;
  const originalPolicyFingerprint = policyFingerprint(originalPolicy);
  const originalPolicySha256 = ethers.sha256(
    ethers.toUtf8Bytes(originalPolicy),
  );
  let finalPolicyFingerprint = "";
  let finalPolicySha256 = "";
  let policyUnchanged = false;
  let validatorBalanceAfter = validatorBalance;
  let agentWalletBalanceAfter = agentWalletBalance;
  let proof: JsonObject | undefined;
  let runError: unknown;

  try {
    const unauthorizedRequestData = validationInterface.encodeFunctionData(
      "validationRequest",
      [
        validatorAddress,
        AGENT_ID,
        unauthorizedPayload.uri,
        unauthorizedPayload.hash,
      ],
    );
    const unauthorizedTx = await validatorWallet.sendTransaction({
      to: VALIDATION_REGISTRY,
      data: unauthorizedRequestData,
      gasLimit: 500_000n,
    });
    const unauthorizedReceipt = await assertMinedStatus(
      provider,
      unauthorizedTx.hash,
      0,
    );
    await assertTransactionBinding(provider, unauthorizedReceipt, {
      from: validatorAddress,
      to: VALIDATION_REGISTRY,
      data: unauthorizedRequestData,
      value: 0n,
    });
    const unauthorizedStatusData = validationInterface.encodeFunctionData(
      "getValidationStatus",
      [unauthorizedPayload.hash],
    );
    const [
      unauthorizedAgentHashes,
      unauthorizedValidatorHashes,
      unauthorizedUnknownBinding,
    ] = await Promise.all([
      validation.getAgentValidations(AGENT_ID, {
        blockTag: unauthorizedReceipt.blockNumber,
      }) as Promise<string[]>,
      validation.getValidatorRequests(validatorAddress, {
        blockTag: unauthorizedReceipt.blockNumber,
      }) as Promise<string[]>,
      bindViewRevert(
        provider,
        VALIDATION_REGISTRY,
        unauthorizedStatusData,
        unauthorizedReceipt.blockNumber,
        "unknown",
      ),
    ]);
    if (
      unauthorizedAgentHashes.length !== preAgentValidations.length ||
      unauthorizedValidatorHashes.length !== preValidatorRequests.length ||
      unauthorizedAgentHashes.some(
        (hash) =>
          hash.toLowerCase() === unauthorizedPayload.hash.toLowerCase(),
      ) ||
      unauthorizedValidatorHashes.some(
        (hash) =>
          hash.toLowerCase() === unauthorizedPayload.hash.toLowerCase(),
      )
    ) {
      throw new Error(
        "Unauthorized request control changed a Validation Registry index",
      );
    }

    const requestData = validationInterface.encodeFunctionData(
      "validationRequest",
      [
        validatorAddress,
        AGENT_ID,
        requestPayload.uri,
        requestPayload.hash,
      ],
    );
    const requestTx = await sendAgentWalletTransaction(
      agentWallet,
      VALIDATION_REGISTRY,
      requestData,
      0n,
      "Request ERC-8004 validation of the pinned Agent Wallet agreement trace",
    );
    const requestReceipt = await assertMinedStatus(provider, requestTx.hash, 1);
    await assertTransactionBinding(provider, requestReceipt, {
      from: agentWallet,
      to: VALIDATION_REGISTRY,
      data: requestData,
      value: 0n,
    });
    const requestBlock = await provider.getBlock(requestReceipt.blockNumber);
    if (!requestBlock) {
      throw new Error(`Missing request block ${requestReceipt.blockNumber}`);
    }
    const [
      requestStatus,
      requestSummary,
      requestAgentValidations,
      requestValidatorRequests,
      requestBlockOwner,
      requestBlockAgentWallet,
      requestBlockApproved,
      requestBlockApprovedForAll,
    ] = await Promise.all([
      validation.getValidationStatus(requestPayload.hash, {
        blockTag: requestReceipt.blockNumber,
      }),
      validation.getSummary(
        AGENT_ID,
        [validatorAddress],
        "agreement-lifecycle",
        { blockTag: requestReceipt.blockNumber },
      ),
      validation.getAgentValidations(AGENT_ID, {
        blockTag: requestReceipt.blockNumber,
      }),
      validation.getValidatorRequests(validatorAddress, {
        blockTag: requestReceipt.blockNumber,
      }),
      identity.ownerOf(AGENT_ID, { blockTag: requestReceipt.blockNumber }),
      identity.getAgentWallet(AGENT_ID, {
        blockTag: requestReceipt.blockNumber,
      }),
      identity.getApproved(AGENT_ID, {
        blockTag: requestReceipt.blockNumber,
      }),
      identity.isApprovedForAll(agentWallet, validatorAddress, {
        blockTag: requestReceipt.blockNumber,
      }),
    ]);
    const requestHashOccurrences = requestAgentValidations.filter(
      (hash: string) =>
        hash.toLowerCase() === requestPayload.hash.toLowerCase(),
    ).length;
    const validatorHashOccurrences = requestValidatorRequests.filter(
      (hash: string) =>
        hash.toLowerCase() === requestPayload.hash.toLowerCase(),
    ).length;
    if (
      requestStatus.validatorAddress.toLowerCase() !==
        validatorAddress.toLowerCase() ||
      requestStatus.agentId !== AGENT_ID ||
      requestStatus.response !== 0n ||
      requestStatus.responseHash !== ethers.ZeroHash ||
      requestStatus.tag !== "" ||
      requestStatus.lastUpdate !== BigInt(requestBlock.timestamp) ||
      requestSummary.count !== 0n ||
      requestSummary.avgResponse !== 0n ||
      requestAgentValidations.length !== preAgentValidations.length + 1 ||
      requestValidatorRequests.length !== preValidatorRequests.length + 1 ||
      requestHashOccurrences !== 1 ||
      validatorHashOccurrences !== 1 ||
      requestBlockOwner.toLowerCase() !== agentWallet.toLowerCase() ||
      requestBlockAgentWallet.toLowerCase() !== agentWallet.toLowerCase() ||
      requestBlockApproved.toLowerCase() === validatorAddress.toLowerCase() ||
      requestBlockApprovedForAll
    ) {
      throw new Error(
        "Block-pinned request state did not match the pending-validation fixture",
      );
    }

    const duplicateTx = await validatorWallet.sendTransaction({
      to: VALIDATION_REGISTRY,
      data: requestData,
      gasLimit: 500_000n,
    });
    const duplicateReceipt = await assertMinedStatus(
      provider,
      duplicateTx.hash,
      0,
    );
    await assertTransactionBinding(provider, duplicateReceipt, {
      from: validatorAddress,
      to: VALIDATION_REGISTRY,
      data: requestData,
      value: 0n,
    });

    const responseData = validationInterface.encodeFunctionData(
      "validationResponse",
      [
        requestPayload.hash,
        100,
        responsePayload.uri,
        responsePayload.hash,
        "agreement-lifecycle",
      ],
    );
    const wrongValidatorTx = await sendAgentWalletTransaction(
      agentWallet,
      VALIDATION_REGISTRY,
      responseData,
      0n,
      "Negative control: submit an ERC-8004 response from the wrong validator",
    );
    const wrongValidatorReceipt = await assertMinedStatus(
      provider,
      wrongValidatorTx.hash,
      0,
    );
    await assertTransactionBinding(provider, wrongValidatorReceipt, {
      from: agentWallet,
      to: VALIDATION_REGISTRY,
      data: responseData,
      value: 0n,
    });

    const overRangeResponseData = validationInterface.encodeFunctionData(
      "validationResponse",
      [
        requestPayload.hash,
        101,
        responsePayload.uri,
        responsePayload.hash,
        "agreement-lifecycle",
      ],
    );
    const overRangeTx = await validatorWallet.sendTransaction({
      to: VALIDATION_REGISTRY,
      data: overRangeResponseData,
      gasLimit: 500_000n,
    });
    const overRangeReceipt = await assertMinedStatus(
      provider,
      overRangeTx.hash,
      0,
    );
    await assertTransactionBinding(provider, overRangeReceipt, {
      from: validatorAddress,
      to: VALIDATION_REGISTRY,
      data: overRangeResponseData,
      value: 0n,
    });

    const zeroValidatorRequestData = validationInterface.encodeFunctionData(
      "validationRequest",
      [
        ethers.ZeroAddress,
        AGENT_ID,
        zeroValidatorPayload.uri,
        zeroValidatorPayload.hash,
      ],
    );
    const zeroValidatorTx = await validatorWallet.sendTransaction({
      to: VALIDATION_REGISTRY,
      data: zeroValidatorRequestData,
      gasLimit: 500_000n,
    });
    const zeroValidatorReceipt = await assertMinedStatus(
      provider,
      zeroValidatorTx.hash,
      0,
    );
    await assertTransactionBinding(provider, zeroValidatorReceipt, {
      from: validatorAddress,
      to: VALIDATION_REGISTRY,
      data: zeroValidatorRequestData,
      value: 0n,
    });
    const zeroValidatorStatusData = validationInterface.encodeFunctionData(
      "getValidationStatus",
      [zeroValidatorPayload.hash],
    );
    const [
      postControlStatus,
      postControlSummary,
      postControlAgentHashes,
      postControlValidatorHashes,
      zeroValidatorUnknownBinding,
    ] = await Promise.all([
        validation.getValidationStatus(requestPayload.hash, {
          blockTag: zeroValidatorReceipt.blockNumber,
        }),
        validation.getSummary(
          AGENT_ID,
          [validatorAddress],
          "agreement-lifecycle",
          { blockTag: zeroValidatorReceipt.blockNumber },
        ),
        validation.getAgentValidations(AGENT_ID, {
          blockTag: zeroValidatorReceipt.blockNumber,
        }),
        validation.getValidatorRequests(validatorAddress, {
          blockTag: zeroValidatorReceipt.blockNumber,
        }),
        bindViewRevert(
          provider,
          VALIDATION_REGISTRY,
          zeroValidatorStatusData,
          zeroValidatorReceipt.blockNumber,
          "unknown",
        ),
      ]);
    if (
      postControlStatus.response !== 0n ||
      postControlStatus.responseHash !== ethers.ZeroHash ||
      postControlStatus.tag !== "" ||
      postControlStatus.lastUpdate !== requestStatus.lastUpdate ||
      postControlSummary.count !== 0n ||
      postControlSummary.avgResponse !== 0n ||
      postControlAgentHashes.length !== requestAgentValidations.length ||
      postControlValidatorHashes.length !== requestValidatorRequests.length ||
      postControlAgentHashes.some(
        (hash: string) =>
          hash.toLowerCase() === zeroValidatorPayload.hash.toLowerCase(),
      ) ||
      postControlValidatorHashes.some(
        (hash: string) =>
          hash.toLowerCase() === zeroValidatorPayload.hash.toLowerCase(),
      )
    ) {
      throw new Error("A mined rejection control changed Validation Registry state");
    }

    const responseTx = await validatorWallet.sendTransaction({
      to: VALIDATION_REGISTRY,
      data: responseData,
      gasLimit: 500_000n,
    });
    const responseReceipt = await assertMinedStatus(
      provider,
      responseTx.hash,
      1,
    );
    await assertTransactionBinding(provider, responseReceipt, {
      from: validatorAddress,
      to: VALIDATION_REGISTRY,
      data: responseData,
      value: 0n,
    });
    const responseBlock = await provider.getBlock(responseReceipt.blockNumber);
    if (!responseBlock) {
      throw new Error(`Missing response block ${responseReceipt.blockNumber}`);
    }

    const requestEvents = requestReceipt.logs
      .filter(
        (log) => log.address.toLowerCase() === VALIDATION_REGISTRY.toLowerCase(),
      )
      .map((log) => {
        try {
          return validationInterface.parseLog(log);
        } catch {
          return null;
        }
      })
      .filter((event) => event?.name === "ValidationRequest");
    const responseEvents = responseReceipt.logs
      .filter(
        (log) => log.address.toLowerCase() === VALIDATION_REGISTRY.toLowerCase(),
      )
      .map((log) => {
        try {
          return validationInterface.parseLog(log);
        } catch {
          return null;
        }
      })
      .filter((event) => event?.name === "ValidationResponse");
    if (requestEvents.length !== 1 || responseEvents.length !== 1) {
      throw new Error(
        "Expected exactly one ValidationRequest and one ValidationResponse event",
      );
    }
    const requestEvent = requestEvents[0]!;
    const responseEvent = responseEvents[0]!;

    const [
      status,
      summary,
      agentValidations,
      validatorRequests,
      unauthorizedBinding,
      duplicateBinding,
      wrongValidatorBinding,
      overRangeBinding,
      zeroValidatorBinding,
    ] = await Promise.all([
      validation.getValidationStatus(requestPayload.hash, {
        blockTag: responseReceipt.blockNumber,
      }),
      validation.getSummary(
        AGENT_ID,
        [validatorAddress],
        "agreement-lifecycle",
        { blockTag: responseReceipt.blockNumber },
      ),
      validation.getAgentValidations(AGENT_ID, {
        blockTag: responseReceipt.blockNumber,
      }),
      validation.getValidatorRequests(validatorAddress, {
        blockTag: responseReceipt.blockNumber,
      }),
      bindRevert(provider, unauthorizedReceipt, "Not authorized"),
      bindRevert(provider, duplicateReceipt, "exists"),
      bindRevert(provider, wrongValidatorReceipt, "not validator"),
      bindRevert(provider, overRangeReceipt, "resp>100"),
      bindRevert(provider, zeroValidatorReceipt, "bad validator"),
    ]);

    const finalAgentOccurrences = agentValidations.filter(
      (hash: string) =>
        hash.toLowerCase() === requestPayload.hash.toLowerCase(),
    ).length;
    const finalValidatorOccurrences = validatorRequests.filter(
      (hash: string) =>
        hash.toLowerCase() === requestPayload.hash.toLowerCase(),
    ).length;
    if (
      status.validatorAddress.toLowerCase() !==
        validatorAddress.toLowerCase() ||
      status.agentId !== AGENT_ID ||
      status.response !== 100n ||
      status.responseHash.toLowerCase() !==
        responsePayload.hash.toLowerCase() ||
      status.tag !== "agreement-lifecycle" ||
      status.lastUpdate !== BigInt(responseBlock.timestamp)
    ) {
      throw new Error("Validation status readback did not match the proof fixture");
    }
    if (summary.count !== 1n || summary.avgResponse !== 100n) {
      throw new Error("Validator-scoped summary did not return count 1 / average 100");
    }
    if (
      agentValidations.length !== preAgentValidations.length + 1 ||
      validatorRequests.length !== preValidatorRequests.length + 1 ||
      finalAgentOccurrences !== 1 ||
      finalValidatorOccurrences !== 1 ||
      agentValidations.some(
        (hash: string) =>
          hash.toLowerCase() === unauthorizedPayload.hash.toLowerCase() ||
          hash.toLowerCase() === zeroValidatorPayload.hash.toLowerCase(),
      ) ||
      validatorRequests.some(
        (hash: string) =>
          hash.toLowerCase() === unauthorizedPayload.hash.toLowerCase() ||
          hash.toLowerCase() === zeroValidatorPayload.hash.toLowerCase(),
      )
    ) {
      throw new Error("Registry indexes did not have the exact expected delta");
    }

    const secondaryValidation = new ethers.Contract(
      VALIDATION_REGISTRY,
      validationAbi,
      secondaryProvider,
    );
    const [secondaryRequestReceipt, secondaryResponseReceipt] =
      await Promise.all([
        waitForReceipt(secondaryProvider, requestReceipt.hash),
        waitForReceipt(secondaryProvider, responseReceipt.hash),
      ]);
    const [secondaryStatus, secondarySummary] = await Promise.all([
      secondaryValidation.getValidationStatus(requestPayload.hash, {
        blockTag: responseReceipt.blockNumber,
      }),
      secondaryValidation.getSummary(
        AGENT_ID,
        [validatorAddress],
        "agreement-lifecycle",
        { blockTag: responseReceipt.blockNumber },
      ),
    ]);
    if (
      secondaryRequestReceipt.status !== 1 ||
      secondaryResponseReceipt.status !== 1 ||
      secondaryRequestReceipt.blockHash !== requestReceipt.blockHash ||
      secondaryResponseReceipt.blockHash !== responseReceipt.blockHash ||
      secondaryStatus.validatorAddress.toLowerCase() !==
        validatorAddress.toLowerCase() ||
      secondaryStatus.agentId !== AGENT_ID ||
      secondaryStatus.response !== 100n ||
      secondaryStatus.responseHash.toLowerCase() !==
        responsePayload.hash.toLowerCase() ||
      secondaryStatus.tag !== "agreement-lifecycle" ||
      secondaryStatus.lastUpdate !== BigInt(responseBlock.timestamp) ||
      secondarySummary.count !== 1n ||
      secondarySummary.avgResponse !== 100n
    ) {
      throw new Error("Secondary RPC verification did not match primary evidence");
    }

    const requestArgs = requestEvent.args;
    const responseArgs = responseEvent.args;
    if (
      requestArgs.validatorAddress.toLowerCase() !==
        validatorAddress.toLowerCase() ||
      requestArgs.agentId !== AGENT_ID ||
      requestArgs.requestURI !== requestPayload.uri ||
      requestArgs.requestHash.toLowerCase() !==
        requestPayload.hash.toLowerCase() ||
      responseArgs.validatorAddress.toLowerCase() !==
        validatorAddress.toLowerCase() ||
      responseArgs.agentId !== AGENT_ID ||
      responseArgs.requestHash.toLowerCase() !==
        requestPayload.hash.toLowerCase() ||
      responseArgs.response !== 100n ||
      responseArgs.responseURI !== responsePayload.uri ||
      responseArgs.responseHash.toLowerCase() !==
        responsePayload.hash.toLowerCase() ||
      responseArgs.tag !== "agreement-lifecycle"
    ) {
      throw new Error("Validation event payloads did not match the proof fixture");
    }

    proof = {
      fixtures: {
        request: {
          document: requestDocument,
          json: requestPayload.json,
          uri: requestPayload.uri,
          hash: requestPayload.hash,
        },
        response: {
          document: responseDocument,
          json: responsePayload.json,
          uri: responsePayload.uri,
          hash: responsePayload.hash,
        },
        negativeControls: {
          unauthorizedRequest: {
            json: unauthorizedPayload.json,
            uri: unauthorizedPayload.uri,
            hash: unauthorizedPayload.hash,
          },
          zeroValidatorRequest: {
            json: zeroValidatorPayload.json,
            uri: zeroValidatorPayload.uri,
            hash: zeroValidatorPayload.hash,
          },
        },
      },
      transactions: {
        unauthorizedRequest: {
          ...(await receiptRecord(provider, unauthorizedReceipt)),
          revertBinding: unauthorizedBinding,
        },
        validationRequest: {
          ...(await receiptRecord(provider, requestReceipt)),
          walletLayer: requestTx.walletResult,
        },
        duplicateRequest: {
          ...(await receiptRecord(provider, duplicateReceipt)),
          revertBinding: duplicateBinding,
        },
        wrongValidatorResponse: {
          ...(await receiptRecord(provider, wrongValidatorReceipt)),
          walletLayer: wrongValidatorTx.walletResult,
          revertBinding: wrongValidatorBinding,
        },
        responseAbove100: {
          ...(await receiptRecord(provider, overRangeReceipt)),
          revertBinding: overRangeBinding,
        },
        zeroValidatorRequest: {
          ...(await receiptRecord(provider, zeroValidatorReceipt)),
          revertBinding: zeroValidatorBinding,
        },
        validationResponse: await receiptRecord(provider, responseReceipt),
      },
      events: {
        ValidationRequest: {
          validatorAddress: requestArgs.validatorAddress,
          agentId: requestArgs.agentId.toString(),
          requestURI: requestArgs.requestURI,
          requestHash: requestArgs.requestHash,
        },
        ValidationResponse: {
          validatorAddress: responseArgs.validatorAddress,
          agentId: responseArgs.agentId.toString(),
          requestHash: responseArgs.requestHash,
          response: responseArgs.response.toString(),
          responseURI: responseArgs.responseURI,
          responseHash: responseArgs.responseHash,
          tag: responseArgs.tag,
        },
      },
      readback: {
        pendingAtRequestBlock: {
          blockNumber: requestReceipt.blockNumber,
          blockTimestamp: requestBlock.timestamp,
          validatorAddress: requestStatus.validatorAddress,
          agentId: requestStatus.agentId.toString(),
          response: requestStatus.response.toString(),
          responseHash: requestStatus.responseHash,
          tag: requestStatus.tag,
          lastUpdate: requestStatus.lastUpdate.toString(),
          validatorScopedSummary: {
            count: requestSummary.count.toString(),
            avgResponse: requestSummary.avgResponse.toString(),
          },
          owner: requestBlockOwner,
          agentWallet: requestBlockAgentWallet,
          tokenApproved: requestBlockApproved,
          validatorApprovedForAll: requestBlockApprovedForAll,
        },
        unchangedAfterMinedControls: {
          blockNumber: zeroValidatorReceipt.blockNumber,
          response: postControlStatus.response.toString(),
          responseHash: postControlStatus.responseHash,
          tag: postControlStatus.tag,
          lastUpdate: postControlStatus.lastUpdate.toString(),
          validatorScopedSummary: {
            count: postControlSummary.count.toString(),
            avgResponse: postControlSummary.avgResponse.toString(),
          },
        },
        rejectedHashesAbsent: {
          unauthorizedRequestHash: unauthorizedPayload.hash,
          unauthorizedStatus: unauthorizedUnknownBinding,
          zeroValidatorRequestHash: zeroValidatorPayload.hash,
          zeroValidatorStatus: zeroValidatorUnknownBinding,
          absentFromAgentAndValidatorIndexes: true,
        },
        finalAtResponseBlock: {
          blockNumber: responseReceipt.blockNumber,
          blockTimestamp: responseBlock.timestamp,
          validatorAddress: status.validatorAddress,
          agentId: status.agentId.toString(),
          response: status.response.toString(),
          responseHash: status.responseHash,
          tag: status.tag,
          lastUpdate: status.lastUpdate.toString(),
          validatorScopedSummary: {
            count: summary.count.toString(),
            avgResponse: summary.avgResponse.toString(),
          },
        },
        indexes: {
          agentBefore: preAgentValidations,
          agentAfter: agentValidations,
          validatorBefore: preValidatorRequests,
          validatorAfter: validatorRequests,
          requestHashOccurrencesForAgent: finalAgentOccurrences,
          requestHashOccurrencesForValidator: finalValidatorOccurrences,
        },
        secondaryRpcCrossCheck: {
          endpointHost: secondaryUrl.hostname,
          requestReceiptBlockHash: secondaryRequestReceipt.blockHash,
          responseReceiptBlockHash: secondaryResponseReceipt.blockHash,
          status: {
            validatorAddress: secondaryStatus.validatorAddress,
            agentId: secondaryStatus.agentId.toString(),
            response: secondaryStatus.response.toString(),
            responseHash: secondaryStatus.responseHash,
            tag: secondaryStatus.tag,
            lastUpdate: secondaryStatus.lastUpdate.toString(),
          },
          summary: {
            count: secondarySummary.count.toString(),
            avgResponse: secondarySummary.avgResponse.toString(),
          },
        },
      },
    };
  } catch (error) {
    runError = error;
  } finally {
    try {
      const finalPolicy = (await getAgentWalletPolicy(agentWallet)).policy;
      finalPolicyFingerprint = policyFingerprint(finalPolicy);
      finalPolicySha256 = ethers.sha256(ethers.toUtf8Bytes(finalPolicy));
      policyUnchanged =
        finalPolicy === originalPolicy &&
        finalPolicyFingerprint === originalPolicyFingerprint &&
        finalPolicySha256 === originalPolicySha256;
      [validatorBalanceAfter, agentWalletBalanceAfter] = await Promise.all([
        provider.getBalance(validatorAddress),
        provider.getBalance(agentWallet),
      ]);
      if (!policyUnchanged) {
        throw new Error(
          "Agent Wallet policy changed during the proof; no overwrite was attempted",
        );
      }
    } catch (error) {
      if (!runError) runError = error;
    }
  }

  if (!policyUnchanged) {
    throw new Error("Agent Wallet policy was not proven unchanged", {
      cause: runError,
    });
  }
  if (runError) throw runError;
  if (!proof) throw new Error("Proof completed without an evidence payload");

  const capturedEvidenceAt = new Date().toISOString();
  const evidence = {
    schemaVersion: 1,
    capturedAt: capturedEvidenceAt,
    result: "PASS",
    network: "lineaSepolia",
    chainId: CHAIN_ID,
    purpose:
      "Close the bounded ERC-8004 Validation Registry composition gap with one real Agent Wallet request, one separately signed response from a distinct configured testnet validator EOA, exact event/state readback, and mined rejection controls.",
    source: "contracts/scripts/real-metamask-erc8004-validation-live.ts",
    sourceCommit: sourceGit.commit,
    workingTreeDirtyBeforeEvidenceWrite: sourceGit.workingTreeDirty,
    runtime: {
      node: process.version,
      ethers: ethers.version,
      hardhatNetwork: network.name,
      agentWalletCli:
        findStringByKey(
          agentWalletDoctor,
          new Set(["cliVersion", "version"]),
        ) || "not-returned-by-doctor",
    },
    actors: {
      agentWallet,
      agentId: AGENT_ID.toString(),
      validator: validatorAddress,
      validatorExpectedAddress,
      validatorRole:
        "Configured Linea Sepolia test signer; distinct from the Agent Wallet and not an approved operator for agent 2.",
      validatorIsIndependent: false,
      validatorKeyHandling:
        "Loaded by Hardhat from the existing runner environment; never printed or persisted by this runner.",
      validatorOwnerOperatorChecks: {
        owner: identityOwner,
        tokenApproved: identityApproved,
        approvedForAll: validatorApprovedForAll,
      },
    },
    registry: {
      address: VALIDATION_REGISTRY,
      url: `${EXPLORER_ADDRESS}${VALIDATION_REGISTRY}`,
      version,
      owner: registryOwner,
      identityRegistry: linkedIdentity,
      identityRegistryVersion: identityVersion,
      proxyImplementation: implementation,
      eip1967ImplementationSlot: EIP1967_IMPLEMENTATION_SLOT,
      eip1967ImplementationSlotValue: implementationSlot,
      bytecode: {
        identityRegistryHash: ethers.keccak256(identityCode),
        validationProxyHash: ethers.keccak256(proxyCode),
        validationImplementationHash: ethers.keccak256(implementationCode),
      },
      deploymentProvenance: {
        proxyCreationTransaction: await receiptRecord(
          provider,
          proxyCreationReceipt,
        ),
        implementationCreationTransaction: await receiptRecord(
          provider,
          implementationCreationReceipt,
        ),
        upgradeAndInitializeTransaction: {
          ...(await receiptRecord(provider, upgradeReceipt)),
          decodedCall: {
            method: "upgradeToAndCall(address,bytes)",
            newImplementation: decodedUpgrade.newImplementation,
            initializer: "initialize(address)",
            identityRegistry: decodedInitialize.identityRegistry,
          },
        },
      },
      sourceReferences: {
        repository: SOURCE_REPOSITORY,
        repositoryCommit: SOURCE_COMMIT,
        validationSourceLastChangedCommit: VALIDATION_SOURCE_COMMIT,
        addressConfig:
          `${SOURCE_REPOSITORY}/blob/${SOURCE_COMMIT}/scripts/addresses.ts`,
        implementationSource:
          `${SOURCE_REPOSITORY}/blob/${SOURCE_COMMIT}/contracts/ValidationRegistryUpgradeable.sol`,
        sourceToRuntimeReproduction:
          "Not performed by this runner; the live implementation address, upgrade calldata, and runtime hash are recorded separately.",
      },
    },
    validationSubject: {
      transactionHash: SUBJECT_TRANSACTION,
      transactionUrl: `${EXPLORER_TX}${SUBJECT_TRANSACTION}`,
      transactionSender: subjectReceipt.from,
      transactionTarget: subjectReceipt.to,
      agreement: SUBJECT_AGREEMENT,
      agreementState: subjectState,
      agreementStateLabel: "DONE",
      reputationRegistry: REPUTATION_REGISTRY,
      feedback: {
        agentId: subjectFeedbackEvent.args.agentId.toString(),
        clientAddress: subjectFeedbackEvent.args.clientAddress,
        feedbackIndex: subjectFeedbackEvent.args.feedbackIndex.toString(),
        value: subjectFeedbackEvent.args.value.toString(),
        valueDecimals: subjectFeedbackEvent.args.valueDecimals.toString(),
        tag1: subjectFeedbackEvent.args.tag1,
        tag2: subjectFeedbackEvent.args.tag2,
        isRevoked: subjectFeedback.isRevoked,
      },
    },
    walletPolicy: {
      walletAddress: agentWallet,
      mutationAttempted: false,
      beforeSha256: originalPolicySha256,
      afterSha256: finalPolicySha256,
      unchanged: policyUnchanged,
      contentPersisted: false,
    },
    balances: {
      validatorBeforeWei: validatorBalance.toString(),
      validatorAfterWei: validatorBalanceAfter.toString(),
      agentWalletBeforeWei: agentWalletBalance.toString(),
      agentWalletAfterWei: agentWalletBalanceAfter.toString(),
    },
    ...proof,
    runnerAssertions: {
      checks: [
        "The proxy implementation slot, owner, version, linked Identity Registry, and three runtime bytecode hashes were read from Linea Sepolia.",
        "ERC-8004 agent 2 was owned by and registered to the MetaMask Agent Wallet at proof time.",
        "The validation subject was re-checked: the pinned Agent Wallet transaction succeeded through the Delegation Manager, emitted the expected Reputation Registry feedback, and the agreement remains DONE with unrevoked feedback.",
        "The Agent Wallet mined ValidationRequest successfully and its exact indexed and non-indexed event fields match the fixture.",
        "A distinct configured testnet EOA mined ValidationResponse successfully and its exact event fields match the fixture.",
        "getValidationStatus, getSummary, getAgentValidations, and getValidatorRequests all include the expected final state.",
        "Five negative controls were mined with status 0 and rebound to their exact Error(string) reasons through block-pinned eth_call.",
        `A second public RPC (${secondaryUrl.hostname}) independently returned the same request/response block hashes and final validation state.`,
        "The runner made no Agent Wallet policy mutation and proved the policy remained byte-for-byte unchanged before emitting evidence.",
      ],
    },
    proofCeiling:
      "This evidence proves one pinned official-repository-configured Linea Sepolia Validation Registry path: the Agent Wallet-owned agent 2 requested validation; a distinct CNS-controlled configured testnet EOA responded; and the exact tested authorization, duplicate, zero-address, wrong-validator, and response-range controls reverted on-chain. It does not prove third-party validator independence, official maintainer endorsement beyond the address and source pins, economics, challenge/slashing/finality or penalty routing, audit or security status, production or mainnet readiness, demand, or token necessity.",
  };

  const outputPath = path.resolve(
    __dirname,
    `../../evidence/linea-sepolia-metamask-agent-wallet-validation-registry-2026-07-24-${requestPayload.hash.slice(2, 10)}.json`,
  );
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  console.log(JSON.stringify({ result: "PASS", outputPath, evidence }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
