// SPDX-License-Identifier: Apache-2.0

import { expect } from "chai";
import { ethers } from "hardhat";
import { Address } from "viem";
import {
  loadAgreement,
  loadSampleInputs,
  deployProtocol,
  loadSDKModule,
  createViemClientsForSigner,
} from "../test-helpers";
import type { AgreementJson } from "../../../../sdk/src/types";

let grantWithFeedback: AgreementJson;
let sampleInputs: Record<string, Record<string, unknown>>;
let AgreementFactoryClass: any;
let AgreementEngineClass: any;

describe("AgreementEngine (integration) - grant-with-feedback FSM", () => {
  before(async () => {
    grantWithFeedback = loadAgreement("grant-with-feedback");
    sampleInputs = loadSampleInputs("grant-with-feedback");
    
    const sdkModule = await loadSDKModule();
    AgreementFactoryClass = sdkModule.AgreementFactory;
    AgreementEngineClass = sdkModule.AgreementEngine;
  });

  describe("Happy Path - Full Work Submission Flow", () => {
    it("drives through all states: signing -> work submission -> review -> payment", async () => {
      const [grantor, recipient] = await ethers.getSigners();
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

      const { address: agreementAddress } = await factory.createAgreement(grantWithFeedback, {
        initValues: {
          grantorEthAddress: grantor.address as Address,
          recipientEthAddress: recipient.address as Address,
        }
      });

      const agreement = new AgreementEngineClass(
        agreementAddress,
        grantorPublic,
        grantorWallet
      );
      const agreementAsRecipient = new AgreementEngineClass(
        agreementAddress,
        recipientPublic,
        recipientWallet
      );

      await agreement.submitInput(grantWithFeedback, "grantorData", sampleInputs.grantorData);
      expect(await agreement.getCurrentState(grantWithFeedback)).to.equal("AWAITING_RECIPIENT_SIGNATURE");

      await agreementAsRecipient.submitInput(grantWithFeedback, "recipientSigning", sampleInputs.recipientSigning);
      expect(await agreement.getCurrentState(grantWithFeedback)).to.equal("AWAITING_GRANTOR_SIGNATURE");

      await agreement.submitInput(grantWithFeedback, "grantorSigning", sampleInputs.grantorSigning);
      expect(await agreement.getCurrentState(grantWithFeedback)).to.equal("AWAITING_WORK_SUBMISSION");

      await agreementAsRecipient.submitInput(grantWithFeedback, "workSubmission", sampleInputs.workSubmission);
      expect(await agreement.getCurrentState(grantWithFeedback)).to.equal("WORK_IN_REVIEW");

      await agreement.submitInput(grantWithFeedback, "workAccepted", sampleInputs.workAccepted);
      expect(await agreement.getCurrentState(grantWithFeedback)).to.equal("AWAITING_PAYMENT");

      await agreement.submitInput(grantWithFeedback, "workTokenSentTx", sampleInputs.workTokenSentTx);
      expect(await agreement.getCurrentState(grantWithFeedback)).to.equal("WORK_ACCEPTED_AND_PAID");
    });
  });

  describe("Work Feedback Loop", () => {
    it("allows grantor to request work resubmission", async () => {
      const [grantor, recipient] = await ethers.getSigners();
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

      const { address: agreementAddress } = await factory.createAgreement(grantWithFeedback, {
        initValues: {
          grantorEthAddress: grantor.address as Address,
          recipientEthAddress: recipient.address as Address,
        }
      });

      const agreement = new AgreementEngineClass(
        agreementAddress,
        grantorPublic,
        grantorWallet
      );
      const agreementAsRecipient = new AgreementEngineClass(
        agreementAddress,
        recipientPublic,
        recipientWallet
      );

      await agreement.submitInput(grantWithFeedback, "grantorData", sampleInputs.grantorData);
      await agreementAsRecipient.submitInput(grantWithFeedback, "recipientSigning", sampleInputs.recipientSigning);
      await agreement.submitInput(grantWithFeedback, "grantorSigning", sampleInputs.grantorSigning);
      await agreementAsRecipient.submitInput(grantWithFeedback, "workSubmission", sampleInputs.workSubmission);
      expect(await agreement.getCurrentState(grantWithFeedback)).to.equal("WORK_IN_REVIEW");

      await agreement.submitInput(grantWithFeedback, "workResubmissionRequested", sampleInputs.workResubmissionRequested);
      expect(await agreement.getCurrentState(grantWithFeedback)).to.equal("AWAITING_WORK_SUBMISSION");

      await agreementAsRecipient.submitInput(grantWithFeedback, "workSubmission", {
        submissionHash: "0xsecondsubmission",
        submissionUrl: "https://github.com/example/v2",
      });
      expect(await agreement.getCurrentState(grantWithFeedback)).to.equal("WORK_IN_REVIEW");

      await agreement.submitInput(grantWithFeedback, "workAccepted", sampleInputs.workAccepted);
      expect(await agreement.getCurrentState(grantWithFeedback)).to.equal("AWAITING_PAYMENT");
    });

    it("allows grantor to reject work (returns to work submission)", async () => {
      const [grantor, recipient] = await ethers.getSigners();
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

      const { address: agreementAddress } = await factory.createAgreement(grantWithFeedback, {
        initValues: {
          grantorEthAddress: grantor.address as Address,
          recipientEthAddress: recipient.address as Address,
        }
      });

      const agreement = new AgreementEngineClass(
        agreementAddress,
        grantorPublic,
        grantorWallet
      );
      const agreementAsRecipient = new AgreementEngineClass(
        agreementAddress,
        recipientPublic,
        recipientWallet
      );

      await agreement.submitInput(grantWithFeedback, "grantorData", sampleInputs.grantorData);
      await agreementAsRecipient.submitInput(grantWithFeedback, "recipientSigning", sampleInputs.recipientSigning);
      await agreement.submitInput(grantWithFeedback, "grantorSigning", sampleInputs.grantorSigning);
      await agreementAsRecipient.submitInput(grantWithFeedback, "workSubmission", sampleInputs.workSubmission);

      await agreement.submitInput(grantWithFeedback, "workRejected", sampleInputs.workRejected);
      expect(await agreement.getCurrentState(grantWithFeedback)).to.equal("AWAITING_WORK_SUBMISSION");
    });
  });

  describe("Rejection Path", () => {
    it("allows grantor to reject agreement at signing stage", async () => {
      const [grantor, recipient] = await ethers.getSigners();
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

      const { address: agreementAddress } = await factory.createAgreement(grantWithFeedback, {
        initValues: {
          grantorEthAddress: grantor.address as Address,
          recipientEthAddress: recipient.address as Address,
        }
      });

      const agreement = new AgreementEngineClass(
        agreementAddress,
        grantorPublic,
        grantorWallet
      );
      const agreementAsRecipient = new AgreementEngineClass(
        agreementAddress,
        recipientPublic,
        recipientWallet
      );

      await agreement.submitInput(grantWithFeedback, "grantorData", sampleInputs.grantorData);
      await agreementAsRecipient.submitInput(grantWithFeedback, "recipientSigning", sampleInputs.recipientSigning);
      await agreement.submitInput(grantWithFeedback, "grantorRejection", sampleInputs.grantorRejection);

      expect(await agreement.getCurrentState(grantWithFeedback)).to.equal("REJECTED");
    });
  });

  describe("Issuer Validation Enforcement", () => {
    it("rejects workSubmission from wrong address (grantor instead of recipient)", async () => {
      const [grantor, recipient] = await ethers.getSigners();
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

      const { address: agreementAddress } = await factory.createAgreement(grantWithFeedback, {
        initValues: {
          grantorEthAddress: grantor.address as Address,
          recipientEthAddress: recipient.address as Address,
        }
      });

      const agreement = new AgreementEngineClass(
        agreementAddress,
        grantorPublic,
        grantorWallet
      );
      const agreementAsRecipient = new AgreementEngineClass(
        agreementAddress,
        recipientPublic,
        recipientWallet
      );
      const agreementForState = new AgreementEngineClass(
        agreementAddress,
        grantorPublic,
        grantorWallet
      );

      await agreement.submitInput(grantWithFeedback, "grantorData", sampleInputs.grantorData);
      await agreementAsRecipient.submitInput(grantWithFeedback, "recipientSigning", sampleInputs.recipientSigning);
      await agreement.submitInput(grantWithFeedback, "grantorSigning", sampleInputs.grantorSigning);

      try {
        await agreement.submitInput(grantWithFeedback, "workSubmission", sampleInputs.workSubmission);
        expect.fail("Expected the submission to revert (wrong sender) but it succeeded");
      } catch (error: any) {
        // Parity is relaxed to revert semantics (the engine still REJECTS the wrong
        // sender), not revert form: the canonical engine reverts ComparisonFailed()
        // (AUTH_SIGNER EQ failed) rather than the legacy SenderAddressMismatch. Error
        // identity is intentionally out of the parity contract.
        expect(error.message).to.include("ComparisonFailed");
      }

      expect(await agreementForState.getCurrentState(grantWithFeedback)).to.equal("AWAITING_WORK_SUBMISSION");
    });

    it("rejects workAccepted from wrong address (recipient instead of grantor)", async () => {
      const [grantor, recipient] = await ethers.getSigners();
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

      const { address: agreementAddress } = await factory.createAgreement(grantWithFeedback, {
        initValues: {
          grantorEthAddress: grantor.address as Address,
          recipientEthAddress: recipient.address as Address,
        }
      });

      const agreement = new AgreementEngineClass(
        agreementAddress,
        grantorPublic,
        grantorWallet
      );
      const agreementAsRecipient = new AgreementEngineClass(
        agreementAddress,
        recipientPublic,
        recipientWallet
      );
      const agreementForState = new AgreementEngineClass(
        agreementAddress,
        grantorPublic,
        grantorWallet
      );

      await agreement.submitInput(grantWithFeedback, "grantorData", sampleInputs.grantorData);
      await agreementAsRecipient.submitInput(grantWithFeedback, "recipientSigning", sampleInputs.recipientSigning);
      await agreement.submitInput(grantWithFeedback, "grantorSigning", sampleInputs.grantorSigning);
      await agreementAsRecipient.submitInput(grantWithFeedback, "workSubmission", sampleInputs.workSubmission);

      try {
        await agreementAsRecipient.submitInput(grantWithFeedback, "workAccepted", sampleInputs.workAccepted);
        expect.fail("Expected the submission to revert (wrong sender) but it succeeded");
      } catch (error: any) {
        // Parity is relaxed to revert semantics (the engine still REJECTS the wrong
        // sender), not revert form: the canonical engine reverts ComparisonFailed()
        // (AUTH_SIGNER EQ failed) rather than the legacy SenderAddressMismatch. Error
        // identity is intentionally out of the parity contract.
        expect(error.message).to.include("ComparisonFailed");
      }

      expect(await agreementForState.getCurrentState(grantWithFeedback)).to.equal("WORK_IN_REVIEW");
    });

    it("rejects workResubmissionRequested from wrong address", async () => {
      const [grantor, recipient] = await ethers.getSigners();
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

      const { address: agreementAddress } = await factory.createAgreement(grantWithFeedback, {
        initValues: {
          grantorEthAddress: grantor.address as Address,
          recipientEthAddress: recipient.address as Address,
        }
      });

      const agreement = new AgreementEngineClass(
        agreementAddress,
        grantorPublic,
        grantorWallet
      );
      const agreementAsRecipient = new AgreementEngineClass(
        agreementAddress,
        recipientPublic,
        recipientWallet
      );

      await agreement.submitInput(grantWithFeedback, "grantorData", sampleInputs.grantorData);
      await agreementAsRecipient.submitInput(grantWithFeedback, "recipientSigning", sampleInputs.recipientSigning);
      await agreement.submitInput(grantWithFeedback, "grantorSigning", sampleInputs.grantorSigning);
      await agreementAsRecipient.submitInput(grantWithFeedback, "workSubmission", sampleInputs.workSubmission);

      try {
        await agreementAsRecipient.submitInput(grantWithFeedback, "workResubmissionRequested", sampleInputs.workResubmissionRequested);
        expect.fail("Expected the submission to revert (wrong sender) but it succeeded");
      } catch (error: any) {
        // Parity is relaxed to revert semantics (the engine still REJECTS the wrong
        // sender), not revert form: the canonical engine reverts ComparisonFailed()
        // (AUTH_SIGNER EQ failed) rather than the legacy SenderAddressMismatch. Error
        // identity is intentionally out of the parity contract.
        expect(error.message).to.include("ComparisonFailed");
      }
    });

    it("rejects workRejected from wrong address", async () => {
      const [grantor, recipient] = await ethers.getSigners();
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

      const { address: agreementAddress } = await factory.createAgreement(grantWithFeedback, {
        initValues: {
          grantorEthAddress: grantor.address as Address,
          recipientEthAddress: recipient.address as Address,
        }
      });

      const agreement = new AgreementEngineClass(
        agreementAddress,
        grantorPublic,
        grantorWallet
      );
      const agreementAsRecipient = new AgreementEngineClass(
        agreementAddress,
        recipientPublic,
        recipientWallet
      );

      await agreement.submitInput(grantWithFeedback, "grantorData", sampleInputs.grantorData);
      await agreementAsRecipient.submitInput(grantWithFeedback, "recipientSigning", sampleInputs.recipientSigning);
      await agreement.submitInput(grantWithFeedback, "grantorSigning", sampleInputs.grantorSigning);
      await agreementAsRecipient.submitInput(grantWithFeedback, "workSubmission", sampleInputs.workSubmission);

      try {
        await agreementAsRecipient.submitInput(grantWithFeedback, "workRejected", sampleInputs.workRejected);
        expect.fail("Expected the submission to revert (wrong sender) but it succeeded");
      } catch (error: any) {
        // Parity is relaxed to revert semantics (the engine still REJECTS the wrong
        // sender), not revert form: the canonical engine reverts ComparisonFailed()
        // (AUTH_SIGNER EQ failed) rather than the legacy SenderAddressMismatch. Error
        // identity is intentionally out of the parity contract.
        expect(error.message).to.include("ComparisonFailed");
      }
    });

    it("rejects payment from non-grantor", async () => {
      const [grantor, recipient] = await ethers.getSigners();
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

      const { address: agreementAddress } = await factory.createAgreement(grantWithFeedback, {
        initValues: {
          grantorEthAddress: grantor.address as Address,
          recipientEthAddress: recipient.address as Address,
        }
      });

      const agreement = new AgreementEngineClass(
        agreementAddress,
        grantorPublic,
        grantorWallet
      );
      const agreementAsRecipient = new AgreementEngineClass(
        agreementAddress,
        recipientPublic,
        recipientWallet
      );
      const agreementForState = new AgreementEngineClass(
        agreementAddress,
        grantorPublic,
        grantorWallet
      );

      await agreement.submitInput(grantWithFeedback, "grantorData", sampleInputs.grantorData);
      await agreementAsRecipient.submitInput(grantWithFeedback, "recipientSigning", sampleInputs.recipientSigning);
      await agreement.submitInput(grantWithFeedback, "grantorSigning", sampleInputs.grantorSigning);
      await agreementAsRecipient.submitInput(grantWithFeedback, "workSubmission", sampleInputs.workSubmission);
      await agreement.submitInput(grantWithFeedback, "workAccepted", sampleInputs.workAccepted);

      try {
        await agreementAsRecipient.submitInput(grantWithFeedback, "workTokenSentTx", sampleInputs.workTokenSentTx);
        expect.fail("Expected the submission to revert (wrong sender) but it succeeded");
      } catch (error: any) {
        // Parity is relaxed to revert semantics (the engine still REJECTS the wrong
        // sender), not revert form: the canonical engine reverts ComparisonFailed()
        // (AUTH_SIGNER EQ failed) rather than the legacy SenderAddressMismatch. Error
        // identity is intentionally out of the parity contract.
        expect(error.message).to.include("ComparisonFailed");
      }

      expect(await agreementForState.getCurrentState(grantWithFeedback)).to.equal("AWAITING_PAYMENT");
    });
  });
});
