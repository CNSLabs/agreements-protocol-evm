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

let purchaseOrder: AgreementJson;
let sampleInputs: Record<string, Record<string, unknown>>;
let AgreementFactoryClass: any;
let AgreementEngineClass: any;

describe(
  "AgreementEngine (integration/purchase-order-auto-pay-actions) - on-chain action",
  () => {
    before(async () => {
      purchaseOrder = loadAgreement("purchase-order-auto-pay-actions");
      sampleInputs = loadSampleInputs("purchase-order-auto-pay-actions");

      const sdkModule = await loadSDKModule();
      AgreementFactoryClass = sdkModule.AgreementFactory;
      AgreementEngineClass = sdkModule.AgreementEngine;
    });

    it("happy path: payee signature executes ERC-20 transferFrom and reaches PAYMENT_COMPLETE", async () => {
      const [payer, payee] = await ethers.getSigners();

      const token = (await ethers.deployContract("TestERC20", [
        "WorkToken",
        "WORK",
      ])) as unknown as TestERC20;
      await token.waitForDeployment();

      const amount = 100n;

      const { factory: deployedFactory } = await deployProtocol();
      const factoryAddress = await deployedFactory.getAddress();
      const { publicClient: payerPublic, walletClient: payerWallet } =
        await createViemClientsForSigner(payer);
      const { publicClient: payeePublic, walletClient: payeeWallet } =
        await createViemClientsForSigner(payee);

      const factory = new AgreementFactoryClass(
        { factoryAddress: factoryAddress as `0x${string}` },
        { walletClient: payerWallet, publicClient: payerPublic }
      );

      const { address: agreementAddress } = await factory.createAgreement(purchaseOrder, {
        initValues: {
          payerEthAddress: payer.address as Address,
          payerName: "ACME Corporation",
          payeeEthAddress: payee.address as Address,
          payeeName: "Widgets LLC",
          workTokenAddress: await token.getAddress(),
          paymentAmount: amount,
        },
      });

      const agreementAsPayer = new AgreementEngineClass(
        agreementAddress,
        payerPublic,
        payerWallet
      );
      const agreementAsPayee = new AgreementEngineClass(
        agreementAddress,
        payeePublic,
        payeeWallet
      );

      // Drive to PENDING_PAYEE_SIGNATURE
      await agreementAsPayer.submitInput(
        purchaseOrder,
        "templateVariables",
        sampleInputs.templateVariables
      );
      expect(await agreementAsPayer.getCurrentState(purchaseOrder)).to.equal(
        "PENDING_PAYER_SIGNATURE"
      );

      await agreementAsPayer.submitInput(
        purchaseOrder,
        "payerSigning",
        sampleInputs.payerSigning
      );
      expect(await agreementAsPayer.getCurrentState(purchaseOrder)).to.equal(
        "PENDING_PAYEE_SIGNATURE"
      );

      // Fund payer + approve agreement to pull tokens
      await (await token.mint(payer.address, 1000n)).wait();
      await (await token.connect(payer).approve(agreementAddress, amount)).wait();

      const payeeBalBefore = await token.balanceOf(payee.address);

      // Payee signature triggers the on-chain action (transferFrom) atomically
      await agreementAsPayee.submitInput(
        purchaseOrder,
        "payeeSigning",
        sampleInputs.payeeSigning
      );

      expect(await agreementAsPayer.getCurrentState(purchaseOrder)).to.equal("PAYMENT_COMPLETE");
      const payeeBalAfter = await token.balanceOf(payee.address);
      expect(payeeBalAfter - payeeBalBefore).to.equal(amount);
    });

    it("rejection path: payeeRejection reaches AGREEMENT_TERMINATED_WITHOUT_PAYMENT and does not transfer tokens", async () => {
      const [payer, payee] = await ethers.getSigners();

      const token = (await ethers.deployContract("TestERC20", [
        "WorkToken",
        "WORK",
      ])) as unknown as TestERC20;
      await token.waitForDeployment();

      const amount = 100n;

      const { factory: deployedFactory } = await deployProtocol();
      const factoryAddress = await deployedFactory.getAddress();
      const { publicClient: payerPublic, walletClient: payerWallet } =
        await createViemClientsForSigner(payer);
      const { publicClient: payeePublic, walletClient: payeeWallet } =
        await createViemClientsForSigner(payee);

      const factory = new AgreementFactoryClass(
        { factoryAddress: factoryAddress as `0x${string}` },
        { walletClient: payerWallet, publicClient: payerPublic }
      );

      const { address: agreementAddress } = await factory.createAgreement(purchaseOrder, {
        initValues: {
          payerEthAddress: payer.address as Address,
          payerName: "ACME Corporation",
          payeeEthAddress: payee.address as Address,
          payeeName: "Widgets LLC",
          workTokenAddress: await token.getAddress(),
          paymentAmount: amount,
        },
      });

      const agreementAsPayer = new AgreementEngineClass(
        agreementAddress,
        payerPublic,
        payerWallet
      );
      const agreementAsPayee = new AgreementEngineClass(
        agreementAddress,
        payeePublic,
        payeeWallet
      );

      await agreementAsPayer.submitInput(
        purchaseOrder,
        "templateVariables",
        sampleInputs.templateVariables
      );
      await agreementAsPayer.submitInput(
        purchaseOrder,
        "payerSigning",
        sampleInputs.payerSigning
      );
      expect(await agreementAsPayer.getCurrentState(purchaseOrder)).to.equal(
        "PENDING_PAYEE_SIGNATURE"
      );

      await (await token.mint(payer.address, 1000n)).wait();
      await (await token.connect(payer).approve(agreementAddress, amount)).wait();

      const payeeBalBefore = await token.balanceOf(payee.address);

      await agreementAsPayee.submitInput(
        purchaseOrder,
        "payeeRejection",
        sampleInputs.payeeRejection
      );

      expect(await agreementAsPayer.getCurrentState(purchaseOrder)).to.equal(
        "AGREEMENT_TERMINATED_WITHOUT_PAYMENT"
      );
      const payeeBalAfter = await token.balanceOf(payee.address);
      expect(payeeBalAfter - payeeBalBefore).to.equal(0n);
    });

    it("enforces issuer conditions (wrong signer cannot submit payerSigning)", async () => {
      const [payer, payee] = await ethers.getSigners();

      const { factory: deployedFactory } = await deployProtocol();
      const factoryAddress = await deployedFactory.getAddress();
      const { publicClient: payerPublic, walletClient: payerWallet } =
        await createViemClientsForSigner(payer);
      const { publicClient: payeePublic, walletClient: payeeWallet } =
        await createViemClientsForSigner(payee);

      const factory = new AgreementFactoryClass(
        { factoryAddress: factoryAddress as `0x${string}` },
        { walletClient: payerWallet, publicClient: payerPublic }
      );

      // Token fields are required init vars for this agreement.
      const token = (await ethers.deployContract("TestERC20", [
        "WorkToken",
        "WORK",
      ])) as unknown as TestERC20;
      await token.waitForDeployment();

      const { address: agreementAddress } = await factory.createAgreement(purchaseOrder, {
        initValues: {
          payerEthAddress: payer.address as Address,
          payerName: "ACME Corporation",
          payeeEthAddress: payee.address as Address,
          payeeName: "Widgets LLC",
          workTokenAddress: await token.getAddress(),
          paymentAmount: 100n,
        },
      });

      const agreementAsPayer = new AgreementEngineClass(
        agreementAddress,
        payerPublic,
        payerWallet
      );
      const agreementAsPayee = new AgreementEngineClass(
        agreementAddress,
        payeePublic,
        payeeWallet
      );

      await agreementAsPayer.submitInput(
        purchaseOrder,
        "templateVariables",
        sampleInputs.templateVariables
      );
      expect(await agreementAsPayer.getCurrentState(purchaseOrder)).to.equal(
        "PENDING_PAYER_SIGNATURE"
      );

      try {
        await agreementAsPayee.submitInput(
          purchaseOrder,
          "payerSigning",
          sampleInputs.payerSigning
        );
        expect.fail("Expected transaction to revert with SenderAddressMismatch");
      } catch (error: any) {
        expect(error.message).to.include("SenderAddressMismatch");
      }

      expect(await agreementAsPayer.getCurrentState(purchaseOrder)).to.equal(
        "PENDING_PAYER_SIGNATURE"
      );
    });

    it("reverts atomically if transferFrom fails (no allowance) and state does not advance", async () => {
      const [payer, payee] = await ethers.getSigners();

      const token = (await ethers.deployContract("TestERC20", [
        "WorkToken",
        "WORK",
      ])) as unknown as TestERC20;
      await token.waitForDeployment();

      const amount = 100n;

      const { factory: deployedFactory } = await deployProtocol();
      const factoryAddress = await deployedFactory.getAddress();
      const { publicClient: payerPublic, walletClient: payerWallet } =
        await createViemClientsForSigner(payer);
      const { publicClient: payeePublic, walletClient: payeeWallet } =
        await createViemClientsForSigner(payee);

      const factory = new AgreementFactoryClass(
        { factoryAddress: factoryAddress as `0x${string}` },
        { walletClient: payerWallet, publicClient: payerPublic }
      );

      const { address: agreementAddress } = await factory.createAgreement(purchaseOrder, {
        initValues: {
          payerEthAddress: payer.address as Address,
          payerName: "ACME Corporation",
          payeeEthAddress: payee.address as Address,
          payeeName: "Widgets LLC",
          workTokenAddress: await token.getAddress(),
          paymentAmount: amount,
        },
      });

      const agreementAsPayer = new AgreementEngineClass(
        agreementAddress,
        payerPublic,
        payerWallet
      );
      const agreementAsPayee = new AgreementEngineClass(
        agreementAddress,
        payeePublic,
        payeeWallet
      );

      await agreementAsPayer.submitInput(
        purchaseOrder,
        "templateVariables",
        sampleInputs.templateVariables
      );
      await agreementAsPayer.submitInput(
        purchaseOrder,
        "payerSigning",
        sampleInputs.payerSigning
      );
      expect(await agreementAsPayer.getCurrentState(purchaseOrder)).to.equal(
        "PENDING_PAYEE_SIGNATURE"
      );

      // Fund payer but DO NOT approve agreement
      await (await token.mint(payer.address, 1000n)).wait();

      try {
        await agreementAsPayee.submitInput(
          purchaseOrder,
          "payeeSigning",
          sampleInputs.payeeSigning
        );
        expect.fail("Expected transaction to revert with ActionCallFailed");
      } catch (error: any) {
        expect(error.message).to.include("ActionCallFailed");
      }

      // Must remain in PENDING_PAYEE_SIGNATURE due to atomic revert
      expect(await agreementAsPayer.getCurrentState(purchaseOrder)).to.equal(
        "PENDING_PAYEE_SIGNATURE"
      );
    });
  }
);

