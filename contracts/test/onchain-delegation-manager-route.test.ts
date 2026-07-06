// SPDX-License-Identifier: Apache-2.0
//
// v3 — the ERC-7710 DelegationManager route (composition de-risking trace).
//
// Design-doc v3 open question: "when a delegate redeems a delegation that calls submitInput, who is
// msg.sender to the engine, and does SENDER_IN_ALLOWED / SENDER_EQ match a contract sender?" This trace
// answers it empirically with a faithful MODEL of MetaMask's DelegationManager + DeleGator:
//
//   agent (delegate) --redeemDelegation--> DelegationManager --verify sig+caveats+revocation-->
//     DeleGator account --execute--> AgreementEngine.submitInput   (engine sees msg.sender = account)
//
// The engine is UNCHANGED: the agreement binds SENDER_EQ_VAR_ADDRESS to the delegator's account, and the
// DelegationManager gates who may cause that account to act. The agent cannot act directly.

import { expect } from "chai";
import { ethers } from "hardhat";
import { AgreementEngine, MockDelegationManager, MockDelegatorAccount } from "../typechain-types";

const k = (s: string) => ethers.keccak256(ethers.toUtf8Bytes(s));
const EMPTY_PAYLOAD = ethers.AbiCoder.defaultAbiCoder().encode(["tuple(bytes32,uint8,bytes)[]"], [[]]);
const FieldType = { UINT256: 0, STRING: 1, ADDRESS: 2, BOOL: 3, BYTES32: 4 };
const Op = { SENDER_EQ_VAR_ADDRESS: 16 };

describe("on-chain authority via DelegationManager route (v3)", function () {
  const START = k("START");
  const DONE = k("DONE");
  const ADVANCE = k("advance");
  const AUTHORIZED_SENDER = k("authorizedSender");

  async function deploy() {
    const [deployer, rootOwner, agent, outsider] = await ethers.getSigners();

    const impl = await ethers.deployContract("AgreementEngine");
    await impl.waitForDeployment();
    const factory = await ethers.deployContract("AgreementFactory", [await impl.getAddress()]);
    await factory.waitForDeployment();

    const dm = (await ethers.deployContract("MockDelegationManager")) as unknown as MockDelegationManager;
    await dm.waitForDeployment();

    // The delegator's smart account (owned by rootOwner, driven by the DelegationManager).
    const account = (await ethers.deployContract("MockDelegatorAccount", [
      rootOwner.address,
      await dm.getAddress(),
    ])) as unknown as MockDelegatorAccount;
    await account.waitForDeployment();
    const accountAddr = await account.getAddress();

    // Agreement: START --advance--> DONE, where `advance` requires msg.sender == the account (the var).
    const initVars = [
      { id: AUTHORIZED_SENDER, fType: FieldType.ADDRESS, data: ethers.AbiCoder.defaultAbiCoder().encode(["address"], [accountAddr]) },
    ];
    const inputDefs = [
      { id: ADVANCE, fields: [], conditions: [{ op: Op.SENDER_EQ_VAR_ADDRESS, fieldId: AUTHORIZED_SENDER, bytesArg: "0x" }], verifierKeys: [] },
    ];
    const transitions = [{ fromState: START, toState: DONE, inputId: ADVANCE }];

    const agreementAddress = await factory.createAgreement.staticCall(
      "ipfs://v3-trace", k("doc"), START, inputDefs, transitions, initVars, [], []
    );
    await factory.createAgreement("ipfs://v3-trace", k("doc"), START, inputDefs, transitions, initVars, [], []);
    const agreement = (await ethers.getContractAt("AgreementEngine", agreementAddress)) as unknown as AgreementEngine;

    const submitCalldata = agreement.interface.encodeFunctionData("submitInput", [ADVANCE, EMPTY_PAYLOAD]);
    const submitSelector = agreement.interface.getFunction("submitInput").selector;

    const delegation = {
      delegate: agent.address,
      delegator: rootOwner.address,
      allowedTarget: agreementAddress,
      allowedSelector: submitSelector,
      salt: 1n,
    };
    const net = await ethers.provider.getNetwork();
    const domain = { name: "ShodaiDelegationManager", version: "1", chainId: net.chainId, verifyingContract: await dm.getAddress() };
    const types = {
      Delegation: [
        { name: "delegate", type: "address" },
        { name: "delegator", type: "address" },
        { name: "allowedTarget", type: "address" },
        { name: "allowedSelector", type: "bytes4" },
        { name: "salt", type: "uint256" },
      ],
    };
    const sig = await rootOwner.signTypedData(domain, types, delegation);

    return { deployer, rootOwner, agent, outsider, dm, account, accountAddr, agreement, agreementAddress, submitCalldata, delegation, sig };
  }

  it("REVERTS the agent's DIRECT submitInput — the agent is not the authorized sender (the account is)", async function () {
    const { agreement, agent } = await deploy();
    await expect(agreement.connect(agent).submitInput(ADVANCE, EMPTY_PAYLOAD)).to.be.revertedWithCustomError(
      agreement,
      "SenderAddressMismatch"
    );
    expect(await agreement.currentState()).to.equal(START);
  });

  it("PASSES via redemption — the engine sees msg.sender = the delegator account (composition answered)", async function () {
    const { dm, agent, account, accountAddr, agreement, delegation, sig, submitCalldata } = await deploy();
    const tx = await dm.connect(agent).redeemDelegation(delegation, sig, await account.getAddress(), submitCalldata);
    const receipt = await tx.wait();

    // The engine advanced — proving the SENDER_EQ_VAR (== account) passed, i.e. msg.sender to the engine
    // WAS the delegator account, not the redeeming agent.
    expect(await agreement.currentState()).to.equal(DONE);
    await expect(tx).to.emit(agreement, "InputAccepted");
    await expect(tx).to.emit(dm, "Redeemed").withArgs(await dm.hashDelegation(delegation), agent.address, accountAddr, await agreement.getAddress());
    console.log(`      [gas] redeemDelegation → account.execute → submitInput: ${receipt?.gasUsed} gas`);
  });

  it("REVERTS a redemption after the delegation is disabled (on-chain off-switch)", async function () {
    const { dm, rootOwner, agent, account, delegation, sig, submitCalldata, agreement } = await deploy();
    await dm.connect(rootOwner).disable(delegation);
    await expect(
      dm.connect(agent).redeemDelegation(delegation, sig, await account.getAddress(), submitCalldata)
    ).to.be.revertedWithCustomError(dm, "DelegationDisabled");
    expect(await agreement.currentState()).to.equal(START);
  });

  it("REVERTS when a non-delegate tries to redeem", async function () {
    const { dm, outsider, account, delegation, sig, submitCalldata } = await deploy();
    await expect(
      dm.connect(outsider).redeemDelegation(delegation, sig, await account.getAddress(), submitCalldata)
    ).to.be.revertedWithCustomError(dm, "NotDelegate");
  });

  it("REVERTS a caveat violation — a call whose selector the delegation did not authorize", async function () {
    const { dm, agent, account, agreement, delegation, sig } = await deploy();
    // A different method (currentState) → different selector → caveat rejects before execution.
    const otherCalldata = agreement.interface.encodeFunctionData("currentState");
    await expect(
      dm.connect(agent).redeemDelegation(delegation, sig, await account.getAddress(), otherCalldata)
    ).to.be.revertedWithCustomError(dm, "SelectorNotAllowed");
  });
});
