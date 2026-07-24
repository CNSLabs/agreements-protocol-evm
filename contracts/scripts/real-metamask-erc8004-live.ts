// SPDX-License-Identifier: Apache-2.0
//
// Public Linea Sepolia trace for the real-contract composition proven by
// real-metamask-erc8004-composition.fork.test.ts.
//
// Required:
//   PRIVATE_KEY=<funded owner key>
//   LINEA_SEPOLIA_RPC_URL=<RPC URL>
//   DELEGATE_PRIVATE_KEY=<distinct delegate key; the script funds it if needed>
//     or DELEGATE_MODE=agent-wallet with an authenticated and initialized `mm` CLI.
//
// Run:
//   npm run trace:real-composition

import { ethers, network } from "hardhat";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  ExecutionMode,
  Implementation,
  ScopeType,
  createDelegation,
  createExecution,
  getSmartAccountsEnvironment,
  toMetaMaskSmartAccount,
} from "@metamask/smart-accounts-kit";
import { DelegationManager } from "@metamask/smart-accounts-kit/contracts";
import { hashDelegation } from "@metamask/smart-accounts-kit/utils";
import {
  type Address,
  type Hex,
  createPublicClient,
  createWalletClient,
  http,
  parseEther,
} from "viem";
import { createBundlerClient } from "viem/account-abstraction";
import { lineaSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

const IDENTITY_REGISTRY = "0x8004A818BFB912233c491871b3d84c89A494BD9e";
const REPUTATION_REGISTRY = "0x8004B663056A597Dffe9eCcC1965A193B7388713";
const SMART_ACCOUNTS_KIT_VERSION = "1.6.0";

const k = (value: string) => ethers.keccak256(ethers.toUtf8Bytes(value));
const EMPTY_PAYLOAD = ethers.AbiCoder.defaultAbiCoder().encode(
  ["tuple(bytes32,uint8,bytes)[]"],
  [[]],
);
const START = k("START");
const DONE = k("DONE");
const ADVANCE = k("advance");
const AUTHORIZED_SENDER = k("authorizedSender");
const DISABLED_DELEGATION_EVENT_TOPIC =
  "0xea589ba9473ee1fe77d352c7ed919747715a5d22931b972de9b02a907c66d5dd";
const CANNOT_USE_DISABLED_DELEGATION_SELECTOR = "0x05baa052";
const execFileAsync = promisify(execFile);

type JsonObject = Record<string, unknown>;

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

function extractRevertData(error: unknown): Hex | undefined {
  const visited = new Set<unknown>();
  let current = error;
  while (isJsonObject(current) && !visited.has(current)) {
    visited.add(current);
    const data = current.data;
    if (typeof data === "string" && /^0x[0-9a-fA-F]+$/.test(data)) {
      return data as Hex;
    }
    if (isJsonObject(data)) {
      const nestedData = data.data;
      if (
        typeof nestedData === "string" &&
        /^0x[0-9a-fA-F]+$/.test(nestedData)
      ) {
        return nestedData as Hex;
      }
    }
    current = current.cause;
  }
  return undefined;
}

function addressTopic(address: Address): Hex {
  return ethers.zeroPadValue(address, 32).toLowerCase() as Hex;
}

async function runAgentWalletCommand(args: string[]): Promise<unknown> {
  const cliBin = process.env.AGENT_WALLET_CLI_BIN || "mm";
  const nodeBin = process.env.AGENT_WALLET_NODE_BIN;
  const command = nodeBin || cliBin;
  const commandArgs = nodeBin ? [cliBin, ...args, "--json"] : [...args, "--json"];
  try {
    const result = await execFileAsync(command, commandArgs, {
      env: process.env,
      maxBuffer: 10 * 1024 * 1024,
      timeout: 11 * 60 * 1000,
    });
    const stdout = String(result.stdout).trim();
    const parsed = JSON.parse(stdout) as JsonObject;
    if (parsed.ok !== true) {
      throw new Error(`Agent Wallet command failed: ${stdout}`);
    }
    return parsed.data;
  } catch (error) {
    const detail = error as Error & { stderr?: string | Buffer; stdout?: string | Buffer };
    const output = String(detail.stderr || detail.stdout || "").trim();
    const operation = args.slice(0, 2).join(" ");
    throw new Error(
      `Agent Wallet command '${operation}' failed${output ? `: ${output}` : ""}`,
      { cause: error },
    );
  }
}

async function requireReadyAgentWallet(): Promise<void> {
  const doctor = await runAgentWalletCommand(["doctor"]);
  if (!isJsonObject(doctor) || doctor.authenticated !== true || doctor.initialized !== true) {
    throw new Error(
      "MetaMask Agent Wallet is not ready; run `mm login`, `mm init --wallet server-wallet --mode guard`, and `mm doctor` first",
    );
  }
}

async function resolveAgentWalletAddress(): Promise<Address> {
  const configured = process.env.AGENT_WALLET_ADDRESS;
  const rawAddress = configured || findStringByKey(
    await runAgentWalletCommand(["wallet", "address"]),
    new Set(["address", "evmAddress"]),
  );
  if (!rawAddress || !ethers.isAddress(rawAddress)) {
    throw new Error("MetaMask Agent Wallet did not return a valid EVM address");
  }
  return ethers.getAddress(rawAddress) as Address;
}

async function sendAgentWalletTransaction(
  to: Address,
  data: Hex,
  intent: string,
): Promise<Hex> {
  const result = await runAgentWalletCommand([
    "wallet",
    "send-transaction",
    "--chain-id",
    String(lineaSepolia.id),
    "--payload",
    JSON.stringify({ to, data, value: "0x0" }),
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
  return hash as Hex;
}

async function main() {
  const isLocalFork =
    network.name === "localhost" && process.env.HARDHAT_FORK === "true";
  if (network.name !== "lineaSepolia" && !isLocalFork) {
    throw new Error(
      "This trace requires --network lineaSepolia, or localhost with HARDHAT_FORK=true",
    );
  }
  const ownerPrivateKey = process.env.PRIVATE_KEY as Hex | undefined;
  const delegatePrivateKey = process.env.DELEGATE_PRIVATE_KEY as Hex | undefined;
  const delegateMode = process.env.DELEGATE_MODE || "private-key";
  const useAgentWallet = delegateMode === "agent-wallet";
  const agentWalletProviderLabel =
    process.env.AGENT_WALLET_PROVIDER_LABEL || "metamask-agent-wallet";
  if (!ownerPrivateKey || (!useAgentWallet && !delegatePrivateKey)) {
    throw new Error(
      "PRIVATE_KEY and either DELEGATE_PRIVATE_KEY or DELEGATE_MODE=agent-wallet are required",
    );
  }
  if (delegateMode !== "private-key" && !useAgentWallet) {
    throw new Error("DELEGATE_MODE must be 'private-key' or 'agent-wallet'");
  }
  if (!isLocalFork && agentWalletProviderLabel.startsWith("mock-")) {
    throw new Error("Mock Agent Wallet providers are restricted to the explicit localhost fork");
  }

  const ownerAccount = privateKeyToAccount(ownerPrivateKey);
  const delegateAccount = delegatePrivateKey
    ? privateKeyToAccount(delegatePrivateKey)
    : undefined;
  if (useAgentWallet) await requireReadyAgentWallet();
  const delegateAddress = useAgentWallet
    ? await resolveAgentWalletAddress()
    : delegateAccount!.address;
  if (ownerAccount.address.toLowerCase() === delegateAddress.toLowerCase()) {
    throw new Error("The delegate must identify a distinct account");
  }

  const rpcUrl = isLocalFork
    ? `http://127.0.0.1:${process.env.HARDHAT_PORT || "8545"}`
    : process.env.LINEA_SEPOLIA_RPC_URL || "https://rpc.sepolia.linea.build";
  const transport = http(rpcUrl);
  const publicClient = createPublicClient({ chain: lineaSepolia, transport });
  const ownerWallet = createWalletClient({
    account: ownerAccount,
    chain: lineaSepolia,
    transport,
  });
  const delegateWallet = delegateAccount
    ? createWalletClient({ account: delegateAccount, chain: lineaSepolia, transport })
    : undefined;
  const [hardhatOwner] = await ethers.getSigners();
  if (hardhatOwner.address.toLowerCase() !== ownerAccount.address.toLowerCase()) {
    throw new Error("Hardhat signer does not match PRIVATE_KEY");
  }

  const explorer = isLocalFork ? "" : "https://sepolia.lineascan.build/tx/";
  const environment = getSmartAccountsEnvironment(lineaSepolia.id);
  const externalAddresses = [
    environment.DelegationManager,
    environment.SimpleFactory,
    IDENTITY_REGISTRY,
    REPUTATION_REGISTRY,
  ] as Address[];
  for (const address of externalAddresses) {
    const code = await publicClient.getCode({ address });
    if (!code || code === "0x") {
      throw new Error(`Expected deployed contract at ${address}`);
    }
  }

  const smartAccount = await toMetaMaskSmartAccount({
    client: publicClient,
    implementation: Implementation.Hybrid,
    deployParams: [ownerAccount.address, [], [], []],
    deploySalt: "0x",
    signer: { account: ownerAccount },
  });
  const { factory, factoryData } = await smartAccount.getFactoryArgs();
  let smartAccountDeploymentHash: Hex | undefined;
  if (factory && factoryData) {
    smartAccountDeploymentHash = await ownerWallet.sendTransaction({
      to: factory,
      data: factoryData,
    });
    await publicClient.waitForTransactionReceipt({ hash: smartAccountDeploymentHash });
  }

  const minimumDelegateBalance = parseEther("0.005");
  const delegateBalance = await publicClient.getBalance({ address: delegateAddress });
  let delegateFundingHash: Hex | undefined;
  if (delegateBalance < minimumDelegateBalance) {
    delegateFundingHash = await ownerWallet.sendTransaction({
      to: delegateAddress,
      value: minimumDelegateBalance - delegateBalance,
    });
    await publicClient.waitForTransactionReceipt({ hash: delegateFundingHash });
  }

  const identity = await ethers.getContractAt(
    "IERC8004IdentityRegistry",
    IDENTITY_REGISTRY,
    hardhatOwner,
  );
  const reputation = await ethers.getContractAt(
    "IERC8004ReputationRegistry",
    REPUTATION_REGISTRY,
    hardhatOwner,
  );
  if ((await identity.getVersion()) !== "2.0.0" || (await reputation.getVersion()) !== "2.0.0") {
    throw new Error("The deployed ERC-8004 registries are not v2.0.0");
  }

  const register = identity.getFunction("register(string)");
  const agentUri =
    process.env.ERC8004_AGENT_URI ||
    `data:application/json,${encodeURIComponent(JSON.stringify({
      name: useAgentWallet
        ? "MetaMask Agent Wallet agreement composition trace"
        : "Agreement composition trace provider",
    }))}`;
  let agentRegistrationHash: Hex;
  if (useAgentWallet) {
    const registerCalldata = identity.interface.encodeFunctionData("register", [agentUri]) as Hex;
    agentRegistrationHash = await sendAgentWalletTransaction(
      IDENTITY_REGISTRY,
      registerCalldata,
      "Register this MetaMask Agent Wallet as the ERC-8004 identity used by the agreement composition trace",
    );
  } else {
    const registerTx = await register(agentUri);
    agentRegistrationHash = registerTx.hash as Hex;
  }
  const registrationReceipt = await publicClient.waitForTransactionReceipt({
    hash: agentRegistrationHash,
  });
  if (registrationReceipt.status !== "success") {
    throw new Error("ERC-8004 agent registration reverted");
  }
  const registeredEvent = registrationReceipt.logs.flatMap((log) => {
    try {
      const event = identity.interface.parseLog({ data: log.data, topics: [...log.topics] });
      return event?.name === "Registered" ? [event] : [];
    } catch {
      return [];
    }
  })[0];
  if (!registeredEvent) throw new Error("ERC-8004 registration did not emit Registered");
  const agentId = registeredEvent.args.agentId as bigint;
  const registeredAgentWallet = await identity.getAgentWallet(agentId);
  if (
    useAgentWallet &&
    registeredAgentWallet.toLowerCase() !== delegateAddress.toLowerCase()
  ) {
    throw new Error("ERC-8004 agent wallet does not match the MetaMask Agent Wallet delegate");
  }

  const implementation = await ethers.deployContract("AgreementEngine", hardhatOwner);
  await implementation.waitForDeployment();
  const factoryContract = await ethers.deployContract(
    "AgreementFactory",
    [await implementation.getAddress()],
    hardhatOwner,
  );
  await factoryContract.waitForDeployment();

  const feedbackData = reputation.interface.encodeFunctionData("giveFeedback", [
    agentId,
    1n,
    0,
    "agreement-lifecycle",
    "milestone-accepted",
    "a2a://agreement/milestone",
    "",
    ethers.ZeroHash,
  ]);
  const initVars = [
    {
      id: AUTHORIZED_SENDER,
      fType: 2,
      data: ethers.AbiCoder.defaultAbiCoder().encode(["address"], [smartAccount.address]),
    },
  ];
  const inputDefs = [
    {
      id: ADVANCE,
      fields: [],
      conditions: [
        { op: 16, fieldId: AUTHORIZED_SENDER, bytesArg: "0x" },
      ],
      verifierKeys: [],
    },
  ];
  const transitions = [{ fromState: START, toState: DONE, inputId: ADVANCE }];
  const actions = [
    {
      fromState: START,
      inputId: ADVANCE,
      target: REPUTATION_REGISTRY,
      value: 0,
      data: feedbackData,
    },
  ];
  const agreementAddress = await factoryContract.createAgreement.staticCall(
    "ipfs://real-composition-live-trace",
    k("real-composition-live-trace"),
    START,
    inputDefs,
    transitions,
    initVars,
    [],
    actions,
  );
  const createAgreementTx = await factoryContract.createAgreement(
    "ipfs://real-composition-live-trace",
    k("real-composition-live-trace"),
    START,
    inputDefs,
    transitions,
    initVars,
    [],
    actions,
  );
  await createAgreementTx.wait();
  const agreement = await ethers.getContractAt("AgreementEngine", agreementAddress);
  const submitCalldata = agreement.interface.encodeFunctionData("submitInput", [
    ADVANCE,
    EMPTY_PAYLOAD,
  ]) as Hex;

  const delegation = createDelegation({
    to: delegateAddress,
    from: smartAccount.address,
    environment,
    scope: {
      type: ScopeType.FunctionCall,
      targets: [agreementAddress as Address],
      selectors: ["submitInput(bytes32,bytes)"],
      exactCalldata: { calldata: submitCalldata },
    },
  });
  const signature = await smartAccount.signDelegation({ delegation });
  const signedDelegation = { ...delegation, signature };
  const redemption = DelegationManager.encode.redeemDelegations({
    delegations: [[signedDelegation]],
    modes: [ExecutionMode.SingleDefault],
    executions: [[createExecution({ target: agreementAddress as Hex, callData: submitCalldata })]],
  });

  // These are read-only simulations: they prove the delegate cannot bypass the
  // smart account and that the exact-calldata caveat rejects another method.
  let directCallRejected = false;
  try {
    await publicClient.call({
      account: delegateAddress,
      to: agreementAddress as Address,
      data: submitCalldata,
    });
  } catch {
    directCallRejected = true;
  }
  if (!directCallRejected) throw new Error("Direct delegate call unexpectedly passed");

  const wrongCalldata = agreement.interface.encodeFunctionData("currentState") as Hex;
  const wrongRedemption = DelegationManager.encode.redeemDelegations({
    delegations: [[signedDelegation]],
    modes: [ExecutionMode.SingleDefault],
    executions: [[createExecution({ target: agreementAddress as Hex, callData: wrongCalldata })]],
  });
  let wrongCalldataRejected = false;
  try {
    await publicClient.call({
      account: delegateAddress,
      to: environment.DelegationManager as Address,
      data: wrongRedemption,
    });
  } catch {
    wrongCalldataRejected = true;
  }
  if (!wrongCalldataRejected) throw new Error("Wrong calldata unexpectedly passed");

  const compositionHash = useAgentWallet
    ? await sendAgentWalletTransaction(
        environment.DelegationManager as Address,
        redemption,
        "Redeem the exact ERC-7710 delegation that advances the agreement and writes its ERC-8004 lifecycle receipt",
      )
    : await delegateWallet!.sendTransaction({
        to: environment.DelegationManager as Address,
        data: redemption,
      });
  const compositionReceipt = await publicClient.waitForTransactionReceipt({
    hash: compositionHash,
  });
  if (compositionReceipt.status !== "success") throw new Error("Composition transaction reverted");
  if (compositionReceipt.from.toLowerCase() !== delegateAddress.toLowerCase()) {
    throw new Error("Composition transaction was not sent by the configured delegate");
  }
  if ((await agreement.currentState()) !== DONE) throw new Error("Agreement did not reach DONE");

  const parsedEngineEvents = compositionReceipt.logs.flatMap((log) => {
    try {
      const event = agreement.interface.parseLog({ data: log.data, topics: [...log.topics] });
      return event ? [event] : [];
    } catch {
      return [];
    }
  });
  const parsedFeedbackEvents = compositionReceipt.logs.flatMap((log) => {
    try {
      const event = reputation.interface.parseLog({ data: log.data, topics: [...log.topics] });
      return event ? [event] : [];
    } catch {
      return [];
    }
  });
  if (!parsedEngineEvents.some((event) => event.name === "InputAccepted")) {
    throw new Error("Composition transaction did not emit InputAccepted");
  }
  if (!parsedEngineEvents.some((event) => event.name === "ActionExecuted")) {
    throw new Error("Composition transaction did not emit ActionExecuted");
  }
  const newFeedback = parsedFeedbackEvents.find((event) => event.name === "NewFeedback");
  if (!newFeedback || newFeedback.args.clientAddress !== agreementAddress) {
    throw new Error("Composition transaction did not emit the expected NewFeedback event");
  }
  if ((await reputation.getLastIndex(agentId, agreementAddress)) !== 1n) {
    throw new Error("ERC-8004 feedback was not recorded for the agreement client");
  }

  const feedback = await reputation.readFeedback(agentId, agreementAddress, 1n);
  if (
    feedback.value !== 1n ||
    feedback.tag1 !== "agreement-lifecycle" ||
    feedback.tag2 !== "milestone-accepted" ||
    feedback.isRevoked
  ) {
    throw new Error("ERC-8004 feedback readback did not match the lifecycle receipt");
  }

  let smartAccountFundingHash: Hex | undefined;
  let delegationDisableEvidence: JsonObject = {
    status: "SKIPPED",
    reason: "Set BUNDLER_RPC_URL to submit a real disableDelegation user operation",
  };
  const bundlerRpcUrl = process.env.BUNDLER_RPC_URL;
  if (bundlerRpcUrl) {
    const minimumSmartAccountBalance = parseEther("0.01");
    const smartAccountBalance = await publicClient.getBalance({
      address: smartAccount.address,
    });
    if (smartAccountBalance < minimumSmartAccountBalance) {
      smartAccountFundingHash = await ownerWallet.sendTransaction({
        to: smartAccount.address,
        value: minimumSmartAccountBalance - smartAccountBalance,
      });
      await publicClient.waitForTransactionReceipt({ hash: smartAccountFundingHash });
    }

    const disableCalldata = DelegationManager.encode.disableDelegation({
      delegation: signedDelegation,
    });
    const bundlerClient = createBundlerClient({
      account: smartAccount,
      client: publicClient,
      transport: http(bundlerRpcUrl),
    });
    const supportedEntryPoints = await bundlerClient.getSupportedEntryPoints();
    const entryPoint = environment.EntryPoint as Address;
    if (
      !supportedEntryPoints.some(
        (address) => address.toLowerCase() === entryPoint.toLowerCase(),
      )
    ) {
      throw new Error(`Bundler does not support required EntryPoint ${entryPoint}`);
    }

    const delegationHash = hashDelegation(signedDelegation);
    const disabledBefore = await DelegationManager.read.disabledDelegations({
      client: publicClient,
      contractAddress: environment.DelegationManager as Address,
      delegationHash,
    });
    if (disabledBefore) {
      throw new Error("Fresh delegation was already disabled before the user operation");
    }

    const userOperationHash = await bundlerClient.sendUserOperation({
      calls: [
        {
          to: environment.DelegationManager as Address,
          data: disableCalldata,
          value: 0n,
        },
      ],
    });
    const userOperationReceipt = await bundlerClient.waitForUserOperationReceipt({
      hash: userOperationHash,
      timeout: 5 * 60 * 1000,
    });
    if (!userOperationReceipt.success) {
      throw new Error("Delegation disable user operation reverted");
    }

    const disabled = await DelegationManager.read.disabledDelegations({
      client: publicClient,
      contractAddress: environment.DelegationManager as Address,
      delegationHash,
    });
    if (!disabled) throw new Error("Delegation Manager did not persist the disabled delegation");

    const disableTransactionReceipt = userOperationReceipt.receipt;
    const disabledDelegationEventObserved = disableTransactionReceipt.logs.some(
      (log) =>
        log.address.toLowerCase() === environment.DelegationManager.toLowerCase() &&
        log.topics[0]?.toLowerCase() === DISABLED_DELEGATION_EVENT_TOPIC &&
        log.topics[1]?.toLowerCase() === delegationHash.toLowerCase() &&
        log.topics[2]?.toLowerCase() === addressTopic(smartAccount.address) &&
        log.topics[3]?.toLowerCase() === addressTopic(delegateAddress),
    );
    if (!disabledDelegationEventObserved) {
      throw new Error("Disable transaction did not emit the exact DisabledDelegation event");
    }

    let postDisableRevertData: Hex | undefined;
    try {
      await publicClient.call({
        account: delegateAddress,
        to: environment.DelegationManager as Address,
        data: redemption,
      });
    } catch (error) {
      postDisableRevertData = extractRevertData(error);
    }
    const postDisableRevertSelector =
      postDisableRevertData?.slice(0, 10).toLowerCase();
    if (postDisableRevertSelector !== CANNOT_USE_DISABLED_DELEGATION_SELECTOR) {
      throw new Error(
        `Disabled redemption did not revert with CannotUseADisabledDelegation(); selector was ${
          postDisableRevertSelector || "unavailable"
        }`,
      );
    }
    if ((await agreement.currentState()) !== DONE) {
      throw new Error("Agreement state changed during the disabled redemption check");
    }
    const feedbackIndexAfterDisabledReuse = await reputation.getLastIndex(
      agentId,
      agreementAddress,
    );
    if (feedbackIndexAfterDisabledReuse !== 1n) {
      throw new Error("Disabled redemption check created unexpected ERC-8004 feedback");
    }

    delegationDisableEvidence = {
      status: "PASS",
      entryPoint,
      supportedEntryPoints,
      delegationHash,
      redemptionCalldataHash: ethers.keccak256(redemption),
      disabledBefore,
      disabled,
      disabledDelegationEventObserved,
      postDisableRedemptionRejected: true,
      postDisableError: "CannotUseADisabledDelegation()",
      postDisableErrorSelector: CANNOT_USE_DISABLED_DELEGATION_SELECTOR,
      agreementStateAfterDisabledReuse: DONE,
      feedbackIndexAfterDisabledReuse: feedbackIndexAfterDisabledReuse.toString(),
      userOperationHash,
      userOperationSender: userOperationReceipt.sender,
      userOperationActualGasCost: userOperationReceipt.actualGasCost.toString(),
      userOperationActualGasUsed: userOperationReceipt.actualGasUsed.toString(),
      transaction: `${explorer}${disableTransactionReceipt.transactionHash}`,
      transactionBlockNumber: disableTransactionReceipt.blockNumber.toString(),
      transactionGasUsed: disableTransactionReceipt.gasUsed.toString(),
    };
  }

  console.log(
    JSON.stringify(
      {
        result: "PASS",
        network: network.name,
        chainId: lineaSepolia.id,
        versions: {
          smartAccountsKit: SMART_ACCOUNTS_KIT_VERSION,
          erc8004IdentityRegistry: await identity.getVersion(),
          erc8004ReputationRegistry: await reputation.getVersion(),
        },
        delegateExecution: useAgentWallet
          ? agentWalletProviderLabel
          : "local-private-key",
        addresses: {
          owner: ownerAccount.address,
          delegate: delegateAddress,
          delegationManager: environment.DelegationManager,
          smartAccount: smartAccount.address,
          engineImplementation: await implementation.getAddress(),
          agreementFactory: await factoryContract.getAddress(),
          agreement: agreementAddress,
          identityRegistry: IDENTITY_REGISTRY,
          reputationRegistry: REPUTATION_REGISTRY,
          erc8004AgentId: agentId.toString(),
          erc8004AgentWallet: registeredAgentWallet,
          erc8004ClientAddress: agreementAddress,
        },
        negativeSimulations: { directCallRejected, wrongCalldataRejected },
        sameTransactionEvents: ["InputAccepted", "ActionExecuted", "NewFeedback"],
        delegationDisable: delegationDisableEvidence,
        transactions: {
          smartAccountDeployment: smartAccountDeploymentHash
            ? `${explorer}${smartAccountDeploymentHash}`
            : "already deployed",
          delegateFunding: delegateFundingHash
            ? `${explorer}${delegateFundingHash}`
            : "already funded",
          smartAccountFunding: smartAccountFundingHash
            ? `${explorer}${smartAccountFundingHash}`
            : bundlerRpcUrl
              ? "already funded"
              : "not requested",
          agentRegistration: `${explorer}${agentRegistrationHash}`,
          engineDeployment: `${explorer}${implementation.deploymentTransaction()!.hash}`,
          factoryDeployment: `${explorer}${factoryContract.deploymentTransaction()!.hash}`,
          agreementCreation: `${explorer}${createAgreementTx.hash}`,
          composition: `${explorer}${compositionHash}`,
        },
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
