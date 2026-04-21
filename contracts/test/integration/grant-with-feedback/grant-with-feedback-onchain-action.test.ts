import { expect } from "chai";
import { ethers } from "hardhat";
import { Address } from "viem";
import type { TestERC20 } from "../../../typechain-types";
import {
  loadAgreement,
  loadSampleInputs,
  deployProtocol,
  loadSDKModule,
  createViemClientsForSigner,
} from "../test-helpers";
import type { AgreementJson } from "../../../../sdk/src/types";

let grantSimple: AgreementJson;
let sampleInputs: Record<string, Record<string, unknown>>;
let AgreementFactoryClass: any;
let AgreementEngineClass: any;

describe("AgreementEngine (integration/grant-with-feedback) - on-chain action (happy path)", () => {
  before(async () => {
    grantSimple = loadAgreement("grant-with-feedback-auto-pay-actions");
    sampleInputs = loadSampleInputs("grant-with-feedback-auto-pay-actions");

    const sdkModule = await loadSDKModule();
    AgreementFactoryClass = sdkModule.AgreementFactory;
    AgreementEngineClass = sdkModule.AgreementEngine;
  });

  it("executes an ERC-20 transferFrom action atomically with the payment transition", async () => {
    const [grantor, recipient] = await ethers.getSigners();

    // Token address is part of init values for this agreement variant.
    // In a real deployment this would be a known ERC-20 (e.g., USDC).
    const token = (await ethers.deployContract("TestERC20", [
      "WorkToken",
      "WORK",
    ])) as unknown as TestERC20;
    await token.waitForDeployment();
    const amount = 100n;

    // Deploy protocol and create agreement via SDK
    const { factory: deployedFactory } = await deployProtocol();
    const factoryAddress = await deployedFactory.getAddress();
    const { publicClient: grantorPublic, walletClient: grantorWallet } =
      await createViemClientsForSigner(grantor);
    const { publicClient: recipientPublic, walletClient: recipientWallet } =
      await createViemClientsForSigner(recipient);

    const factory = new AgreementFactoryClass(
      { factoryAddress: factoryAddress as `0x${string}` },
      { walletClient: grantorWallet, publicClient: grantorPublic }
    );

    const { address: agreementAddress } = await factory.createAgreement(grantSimple, {
      initValues: {
        grantorEthAddress: grantor.address as Address,
        recipientEthAddress: recipient.address as Address,
        workTokenAddress: await token.getAddress(),
        paymentAmount: amount,
      },
    });

    // Drive agreement to WORK_IN_REVIEW
    const agreementAsGrantor = new AgreementEngineClass(
      agreementAddress,
      grantorPublic,
      grantorWallet
    );
    const agreementAsRecipient = new AgreementEngineClass(
      agreementAddress,
      recipientPublic,
      recipientWallet
    );

    await agreementAsGrantor.submitInput(grantSimple, "grantorData", sampleInputs.grantorData);
    await agreementAsRecipient.submitInput(
      grantSimple,
      "recipientSigning",
      sampleInputs.recipientSigning
    );
    await agreementAsGrantor.submitInput(
      grantSimple,
      "grantorSigning",
      sampleInputs.grantorSigning
    );
    // --- Funding phase (right after both parties sign, before work is completed) ---
    await (await token.mint(grantor.address, 1000n)).wait();

    // Approve AgreementEngine (spender) to pull tokens
    await (await token.connect(grantor).approve(agreementAddress, amount)).wait();

    // --- Work & review phase ---
    await agreementAsRecipient.submitInput(
      grantSimple,
      "workSubmission",
      sampleInputs.workSubmission
    );
    expect(await agreementAsGrantor.getCurrentState(grantSimple)).to.equal("WORK_IN_REVIEW");

    const recipientBalBefore = await token.balanceOf(recipient.address);

    // Accepting the work now triggers the on-chain action (installed at initialization)
    // and transitions atomically to PAID.
    await agreementAsGrantor.submitInput(grantSimple, "workAccepted", sampleInputs.workAccepted);

    expect(await agreementAsGrantor.getCurrentState(grantSimple)).to.equal("WORK_ACCEPTED_AND_PAID");
    const recipientBalAfter = await token.balanceOf(recipient.address);
    expect(recipientBalAfter - recipientBalBefore).to.equal(amount);
  });
});


