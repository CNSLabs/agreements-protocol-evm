// SPDX-License-Identifier: Apache-2.0
//
// Real-contract composition proof on a pinned Linea Sepolia fork:
//
//   delegate EOA -> MetaMask DelegationManager -> MetaMask Hybrid smart account
//     -> unchanged AgreementEngine -> official ERC-8004 ReputationRegistry
//
// This test intentionally imports the production SDK/deployment manifest and
// calls the deployed singleton contracts. No Mock* contract participates.

import { expect } from "chai";
import { ethers, network } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import type { AgreementEngine } from "../typechain-types";
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
  type EIP1193RequestFn,
  type Hex,
  createPublicClient,
  createWalletClient,
  custom,
} from "viem";
import { lineaSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

const describeFork = process.env.HARDHAT_FORK === "true" ? describe : describe.skip;

const IDENTITY_REGISTRY = "0x8004A818BFB912233c491871b3d84c89A494BD9e";
const REPUTATION_REGISTRY = "0x8004B663056A597Dffe9eCcC1965A193B7388713";

// Hardhat's first two deterministic development keys. The fork harness uses
// the matching funded accounts and never sends these keys to a public network.
const OWNER_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const DELEGATE_PRIVATE_KEY =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

const k = (value: string) => ethers.keccak256(ethers.toUtf8Bytes(value));
const EMPTY_PAYLOAD = ethers.AbiCoder.defaultAbiCoder().encode(
  ["tuple(bytes32,uint8,bytes)[]"],
  [[]],
);
const FieldType = { ADDRESS: 2 };
const Op = { SENDER_EQ_VAR_ADDRESS: 16 };

const START = k("START");
const DONE = k("DONE");
const ADVANCE = k("advance");
const AUTHORIZED_SENDER = k("authorizedSender");
const FEEDBACK_TAG_1 = "agreement-lifecycle";
const FEEDBACK_TAG_2 = "milestone-accepted";

function hardhatTransport() {
  const request: EIP1193RequestFn = async ({ method, params }) =>
    network.provider.send(method, (params ?? []) as unknown[]);
  return custom({ request });
}

async function expectViemRevert(
  publicClient: ReturnType<typeof createPublicClient>,
  send: () => Promise<Hex>,
) {
  let hash: Hex;
  try {
    hash = await send();
  } catch {
    return;
  }

  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  expect(receipt.status).to.equal("reverted");
}

describeFork("real MetaMask delegation -> AgreementEngine -> ERC-8004", function () {
  this.timeout(120_000);

  async function deployFixture() {
    const [rootOwner, delegate, providerAgent] = await ethers.getSigners();
    const ownerAccount = privateKeyToAccount(OWNER_PRIVATE_KEY);
    const delegateAccount = privateKeyToAccount(DELEGATE_PRIVATE_KEY);

    expect(ownerAccount.address).to.equal(rootOwner.address);
    expect(delegateAccount.address).to.equal(delegate.address);

    const transport = hardhatTransport();
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

    const environment = getSmartAccountsEnvironment(lineaSepolia.id);
    for (const address of [
      environment.DelegationManager,
      environment.SimpleFactory,
      IDENTITY_REGISTRY,
      REPUTATION_REGISTRY,
    ]) {
      const code = await publicClient.getCode({ address: address as Address });
      expect(code).not.to.equal(undefined);
      expect(code).not.to.equal("0x");
    }

    const smartAccount = await toMetaMaskSmartAccount({
      client: publicClient,
      implementation: Implementation.Hybrid,
      deployParams: [ownerAccount.address, [], [], []],
      deploySalt: "0x",
      signer: { account: ownerAccount },
    });

    // Deploy the counterfactual account through MetaMask's real SimpleFactory.
    const { factory, factoryData } = await smartAccount.getFactoryArgs();
    if (factory && factoryData) {
      const deployHash = await ownerWallet.sendTransaction({
        to: factory,
        data: factoryData,
      });
      await publicClient.waitForTransactionReceipt({ hash: deployHash });
    }
    const smartAccountCode = await publicClient.getCode({ address: smartAccount.address });
    expect(smartAccountCode).not.to.equal(undefined);
    expect(smartAccountCode).not.to.equal("0x");

    const identity = await ethers.getContractAt(
      "IERC8004IdentityRegistry",
      IDENTITY_REGISTRY,
      providerAgent,
    );
    const reputation = await ethers.getContractAt(
      "IERC8004ReputationRegistry",
      REPUTATION_REGISTRY,
    );
    expect(await identity.getVersion()).to.equal("2.0.0");
    expect(await reputation.getVersion()).to.equal("2.0.0");

    // A distinct service-provider agent receives the objective lifecycle receipt.
    const register = identity.getFunction("register(string)");
    const agentUri = "data:application/json,{\"name\":\"Fork proof provider\"}";
    const agentId = await register.staticCall(agentUri);
    await (await register(agentUri)).wait();
    expect(await identity.getAgentWallet(agentId)).to.equal(providerAgent.address);

    const implementation = await ethers.deployContract("AgreementEngine", rootOwner);
    await implementation.waitForDeployment();
    const factoryContract = await ethers.deployContract(
      "AgreementFactory",
      [await implementation.getAddress()],
      rootOwner,
    );
    await factoryContract.waitForDeployment();

    return {
      rootOwner,
      delegate,
      providerAgent,
      publicClient,
      delegateWallet,
      environment,
      smartAccount,
      identity,
      reputation,
      agentId,
      factoryContract,
    };
  }

  async function createReceiptAgreement(
    fixture: Awaited<ReturnType<typeof deployFixture>>,
    feedbackAgentId: bigint,
  ) {
    const feedbackData = fixture.reputation.interface.encodeFunctionData("giveFeedback", [
      feedbackAgentId,
      1n,
      0,
      FEEDBACK_TAG_1,
      FEEDBACK_TAG_2,
      "a2a://agreement/milestone",
      "",
      ethers.ZeroHash,
    ]);
    const initVars = [
      {
        id: AUTHORIZED_SENDER,
        fType: FieldType.ADDRESS,
        data: ethers.AbiCoder.defaultAbiCoder().encode(
          ["address"],
          [fixture.smartAccount.address],
        ),
      },
    ];
    const inputDefs = [
      {
        id: ADVANCE,
        fields: [],
        conditions: [
          {
            op: Op.SENDER_EQ_VAR_ADDRESS,
            fieldId: AUTHORIZED_SENDER,
            bytesArg: "0x",
          },
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

    const agreementAddress = await fixture.factoryContract.createAgreement.staticCall(
      "ipfs://real-composition-proof",
      k("real-composition-proof"),
      START,
      inputDefs,
      transitions,
      initVars,
      [],
      actions,
    );
    await (
      await fixture.factoryContract.createAgreement(
        "ipfs://real-composition-proof",
        k("real-composition-proof"),
        START,
        inputDefs,
        transitions,
        initVars,
        [],
        actions,
      )
    ).wait();
    const agreement = (await ethers.getContractAt(
      "AgreementEngine",
      agreementAddress,
    )) as unknown as AgreementEngine;
    const submitCalldata = agreement.interface.encodeFunctionData("submitInput", [
      ADVANCE,
      EMPTY_PAYLOAD,
    ]) as Hex;

    const delegation = createDelegation({
      to: fixture.delegate.address as Hex,
      from: fixture.smartAccount.address,
      environment: fixture.environment,
      scope: {
        type: ScopeType.FunctionCall,
        targets: [agreementAddress as Address],
        selectors: ["submitInput(bytes32,bytes)"],
        exactCalldata: { calldata: submitCalldata },
      },
    });
    const signature = await fixture.smartAccount.signDelegation({ delegation });
    const signedDelegation = { ...delegation, signature };

    return { agreement, agreementAddress, submitCalldata, signedDelegation };
  }

  function encodeRedemption(
    fixture: Awaited<ReturnType<typeof deployFixture>>,
    signedDelegation: Awaited<ReturnType<typeof createReceiptAgreement>>["signedDelegation"],
    target: string,
    callData: Hex,
  ) {
    const execution = createExecution({ target: target as Hex, callData });
    return DelegationManager.encode.redeemDelegations({
      delegations: [[signedDelegation]],
      modes: [ExecutionMode.SingleDefault],
      executions: [[execution]],
    });
  }

  it("executes through real MetaMask contracts and emits a real ERC-8004 receipt atomically", async function () {
    const fixture = await loadFixture(deployFixture);
    const proof = await createReceiptAgreement(fixture, fixture.agentId);

    // The delegate is not the agreement's authorized sender.
    await expect(
      proof.agreement.connect(fixture.delegate).submitInput(ADVANCE, EMPTY_PAYLOAD),
    ).to.be.revertedWithCustomError(proof.agreement, "SenderAddressMismatch");

    // The exact-calldata caveat rejects a different call before the valid redemption.
    const wrongCalldata = proof.agreement.interface.encodeFunctionData("currentState") as Hex;
    const wrongRedemption = encodeRedemption(
      fixture,
      proof.signedDelegation,
      proof.agreementAddress,
      wrongCalldata,
    );
    await expectViemRevert(fixture.publicClient, () =>
      fixture.delegateWallet.sendTransaction({
        to: fixture.environment.DelegationManager as Address,
        data: wrongRedemption,
      }),
    );
    expect(await proof.agreement.currentState()).to.equal(START);

    const redemption = encodeRedemption(
      fixture,
      proof.signedDelegation,
      proof.agreementAddress,
      proof.submitCalldata,
    );
    const hash = await fixture.delegateWallet.sendTransaction({
      to: fixture.environment.DelegationManager as Address,
      data: redemption,
    });
    await fixture.publicClient.waitForTransactionReceipt({ hash });
    const receipt = await ethers.provider.getTransactionReceipt(hash);
    expect(receipt).not.to.equal(null);
    expect(await proof.agreement.currentState()).to.equal(DONE);

    const engineEvents = receipt!.logs
      .map((log) => {
        try {
          return proof.agreement.interface.parseLog(log);
        } catch {
          return null;
        }
      })
      .filter((event) => event !== null);
    const feedbackEvents = receipt!.logs
      .map((log) => {
        try {
          return fixture.reputation.interface.parseLog(log);
        } catch {
          return null;
        }
      })
      .filter((event) => event !== null);

    expect(engineEvents.some((event) => event!.name === "InputAccepted")).to.equal(true);
    expect(engineEvents.some((event) => event!.name === "ActionExecuted")).to.equal(true);
    const feedbackEvent = feedbackEvents.find((event) => event!.name === "NewFeedback");
    expect(feedbackEvent).not.to.equal(undefined);
    expect(feedbackEvent!.args.agentId).to.equal(fixture.agentId);
    expect(feedbackEvent!.args.clientAddress).to.equal(proof.agreementAddress);
    expect(feedbackEvent!.args.tag1).to.equal(FEEDBACK_TAG_1);
    expect(feedbackEvent!.args.tag2).to.equal(FEEDBACK_TAG_2);

    expect(
      await fixture.reputation.getLastIndex(fixture.agentId, proof.agreementAddress),
    ).to.equal(1n);
    const feedback = await fixture.reputation.readFeedback(
      fixture.agentId,
      proof.agreementAddress,
      1n,
    );
    expect(feedback.value).to.equal(1n);
    expect(feedback.valueDecimals).to.equal(0n);
    expect(feedback.tag1).to.equal(FEEDBACK_TAG_1);
    expect(feedback.tag2).to.equal(FEEDBACK_TAG_2);
    expect(feedback.isRevoked).to.equal(false);

    console.log(`      [real composition tx] ${hash}`);
    console.log(`      [MetaMask smart account] ${fixture.smartAccount.address}`);
    console.log(`      [agreement / ERC-8004 client] ${proof.agreementAddress}`);
    console.log(`      [ERC-8004 agentId] ${fixture.agentId}`);
  });

  it("rolls the agreement transition back when real ERC-8004 feedback rejects", async function () {
    const fixture = await loadFixture(deployFixture);
    const nonexistentAgentId = (1n << 255n) - 1n;
    const proof = await createReceiptAgreement(fixture, nonexistentAgentId);
    const redemption = encodeRedemption(
      fixture,
      proof.signedDelegation,
      proof.agreementAddress,
      proof.submitCalldata,
    );

    await expectViemRevert(fixture.publicClient, () =>
      fixture.delegateWallet.sendTransaction({
        to: fixture.environment.DelegationManager as Address,
        data: redemption,
      }),
    );
    expect(await proof.agreement.currentState()).to.equal(START);
    expect(
      await fixture.reputation.getLastIndex(nonexistentAgentId, proof.agreementAddress),
    ).to.equal(0n);
  });
});
