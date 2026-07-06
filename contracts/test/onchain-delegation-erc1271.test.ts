// SPDX-License-Identifier: Apache-2.0
//
// v3 + ERC-1271 — the delegation is signed by a SMART ACCOUNT, not an EOA (closes the D-0039 gap for
// the signing leg). The DelegationManager validates via OZ SignatureChecker, which does ecrecover for
// EOAs and an ERC-1271 `isValidSignature` staticcall for contract signers. So a Safe/4337-style
// delegator (the persona that actually holds funds) can grant a delegation the engine enforces.

import { expect } from "chai";
import { ethers } from "hardhat";
import { AgreementEngine, MockDelegationManager, MockDelegatorAccount, MockErc1271Signer } from "../typechain-types";

const k = (s: string) => ethers.keccak256(ethers.toUtf8Bytes(s));
const EMPTY_PAYLOAD = ethers.AbiCoder.defaultAbiCoder().encode(["tuple(bytes32,uint8,bytes)[]"], [[]]);
const FieldType = { ADDRESS: 2 };
const Op = { SENDER_EQ_VAR_ADDRESS: 16 };

describe("on-chain authority via DelegationManager — SMART-ACCOUNT (ERC-1271) delegator", function () {
  const START = k("START");
  const DONE = k("DONE");
  const ADVANCE = k("advance");
  const AUTHORIZED_SENDER = k("authorizedSender");

  async function deploy() {
    const [, ownerEoa, agent, other] = await ethers.getSigners();

    const impl = await ethers.deployContract("AgreementEngine");
    await impl.waitForDeployment();
    const factory = await ethers.deployContract("AgreementFactory", [await impl.getAddress()]);
    await factory.waitForDeployment();
    const dm = (await ethers.deployContract("MockDelegationManager")) as unknown as MockDelegationManager;
    await dm.waitForDeployment();

    // The DELEGATOR is a SMART ACCOUNT (ERC-1271), owned by ownerEoa — not an EOA.
    const smartDelegator = (await ethers.deployContract("MockErc1271Signer", [ownerEoa.address])) as unknown as MockErc1271Signer;
    await smartDelegator.waitForDeployment();
    const smartDelegatorAddr = await smartDelegator.getAddress();

    // The executing account is owned by the smart-account delegator.
    const account = (await ethers.deployContract("MockDelegatorAccount", [
      smartDelegatorAddr,
      await dm.getAddress(),
    ])) as unknown as MockDelegatorAccount;
    await account.waitForDeployment();
    const accountAddr = await account.getAddress();

    const initVars = [
      { id: AUTHORIZED_SENDER, fType: FieldType.ADDRESS, data: ethers.AbiCoder.defaultAbiCoder().encode(["address"], [accountAddr]) },
    ];
    const inputDefs = [
      { id: ADVANCE, fields: [], conditions: [{ op: Op.SENDER_EQ_VAR_ADDRESS, fieldId: AUTHORIZED_SENDER, bytesArg: "0x" }], verifierKeys: [] },
    ];
    const transitions = [{ fromState: START, toState: DONE, inputId: ADVANCE }];
    const agreementAddress = await factory.createAgreement.staticCall(
      "ipfs://erc1271", k("doc"), START, inputDefs, transitions, initVars, [], []
    );
    await factory.createAgreement("ipfs://erc1271", k("doc"), START, inputDefs, transitions, initVars, [], []);
    const agreement = (await ethers.getContractAt("AgreementEngine", agreementAddress)) as unknown as AgreementEngine;

    const submitCalldata = agreement.interface.encodeFunctionData("submitInput", [ADVANCE, EMPTY_PAYLOAD]);
    const delegation = {
      delegate: agent.address,
      delegator: smartDelegatorAddr, // a CONTRACT
      allowedTarget: agreementAddress,
      allowedSelector: agreement.interface.getFunction("submitInput").selector,
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
    // The smart account's OWNER EOA signs; ERC-1271 validates it on behalf of the contract delegator.
    const ownerSig = await ownerEoa.signTypedData(domain, types, delegation);
    const otherSig = await other.signTypedData(domain, types, delegation); // not the owner

    return { agent, account, agreement, dm, delegation, ownerSig, otherSig, submitCalldata };
  }

  it("PASSES with a smart-account (ERC-1271) delegator — owner signature validated via isValidSignature", async function () {
    const { agent, account, agreement, dm, delegation, ownerSig, submitCalldata } = await deploy();
    await dm.connect(agent).redeemDelegation(delegation, ownerSig, await account.getAddress(), submitCalldata);
    expect(await agreement.currentState()).to.equal(DONE);
  });

  it("REVERTS when the signature is not from the smart account's owner (ERC-1271 rejects)", async function () {
    const { agent, account, dm, delegation, otherSig, submitCalldata } = await deploy();
    await expect(
      dm.connect(agent).redeemDelegation(delegation, otherSig, await account.getAddress(), submitCalldata)
    ).to.be.revertedWithCustomError(dm, "BadSignature");
  });
});
