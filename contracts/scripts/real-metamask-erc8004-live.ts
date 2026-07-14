// SPDX-License-Identifier: Apache-2.0
//
// Public Linea Sepolia trace for the real-contract composition proven by
// real-metamask-erc8004-composition.fork.test.ts.
//
// Required:
//   PRIVATE_KEY=<funded owner key>
//   DELEGATE_PRIVATE_KEY=<distinct delegate key; the script funds it if needed>
//   LINEA_SEPOLIA_RPC_URL=<RPC URL>
//
// Run:
//   npm run trace:real-composition

import { ethers, network } from "hardhat";
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
import {
  type Address,
  type Hex,
  createPublicClient,
  createWalletClient,
  http,
  parseEther,
} from "viem";
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
  if (!ownerPrivateKey || !delegatePrivateKey) {
    throw new Error("PRIVATE_KEY and DELEGATE_PRIVATE_KEY are required");
  }

  const ownerAccount = privateKeyToAccount(ownerPrivateKey);
  const delegateAccount = privateKeyToAccount(delegatePrivateKey);
  if (ownerAccount.address.toLowerCase() === delegateAccount.address.toLowerCase()) {
    throw new Error("DELEGATE_PRIVATE_KEY must identify a distinct account");
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
  const delegateWallet = createWalletClient({
    account: delegateAccount,
    chain: lineaSepolia,
    transport,
  });
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
  const delegateBalance = await publicClient.getBalance({ address: delegateAccount.address });
  let delegateFundingHash: Hex | undefined;
  if (delegateBalance < minimumDelegateBalance) {
    delegateFundingHash = await ownerWallet.sendTransaction({
      to: delegateAccount.address,
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
    "data:application/json,{\"name\":\"Agreement composition trace provider\"}";
  const agentId = await register.staticCall(agentUri);
  const registerTx = await register(agentUri);
  await registerTx.wait();

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
    to: delegateAccount.address,
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
      account: delegateAccount.address,
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
      account: delegateAccount.address,
      to: environment.DelegationManager as Address,
      data: wrongRedemption,
    });
  } catch {
    wrongCalldataRejected = true;
  }
  if (!wrongCalldataRejected) throw new Error("Wrong calldata unexpectedly passed");

  const compositionHash = await delegateWallet.sendTransaction({
    to: environment.DelegationManager as Address,
    data: redemption,
  });
  const compositionReceipt = await publicClient.waitForTransactionReceipt({
    hash: compositionHash,
  });
  if (compositionReceipt.status !== "success") throw new Error("Composition transaction reverted");
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
        addresses: {
          owner: ownerAccount.address,
          delegate: delegateAccount.address,
          delegationManager: environment.DelegationManager,
          smartAccount: smartAccount.address,
          engineImplementation: await implementation.getAddress(),
          agreementFactory: await factoryContract.getAddress(),
          agreement: agreementAddress,
          identityRegistry: IDENTITY_REGISTRY,
          reputationRegistry: REPUTATION_REGISTRY,
          erc8004AgentId: agentId.toString(),
          erc8004ClientAddress: agreementAddress,
        },
        negativeSimulations: { directCallRejected, wrongCalldataRejected },
        sameTransactionEvents: ["InputAccepted", "ActionExecuted", "NewFeedback"],
        transactions: {
          smartAccountDeployment: smartAccountDeploymentHash
            ? `${explorer}${smartAccountDeploymentHash}`
            : "already deployed",
          delegateFunding: delegateFundingHash
            ? `${explorer}${delegateFundingHash}`
            : "already funded",
          agentRegistration: `${explorer}${registerTx.hash}`,
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
