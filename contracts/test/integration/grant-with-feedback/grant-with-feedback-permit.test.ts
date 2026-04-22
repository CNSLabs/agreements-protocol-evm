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

describe("AgreementEngine (integration) - grant-with-feedback FSM with Permits", () => {
  before(async () => {
    grantWithFeedback = loadAgreement("grant-with-feedback");
    sampleInputs = loadSampleInputs("grant-with-feedback");
    
    const sdkModule = await loadSDKModule();
    AgreementFactoryClass = sdkModule.AgreementFactory;
    AgreementEngineClass = sdkModule.AgreementEngine;
  });

  // Helper function to create a permit signature for recipient inputs
  async function createRecipientPermit(
    agreementAddress: string,
    recipient: any, // Recipient signer
    inputId: string,
    data: Record<string, unknown>,
    deadline: number = Math.floor(Date.now() / 1000) + 3600 // 1 hour default
  ) {
    // Create viem clients for the recipient
    const { publicClient, walletClient } = await createViemClientsForSigner(recipient);

    // Read-only agreement instance for nonce/domain + recipient wallet for signing
    const agreementReadOnly = new AgreementEngineClass(
      agreementAddress,
      publicClient,
      walletClient
    );

    return await agreementReadOnly.createPermitSignature(
      walletClient,
      grantWithFeedback,
      inputId,
      data,
      deadline
    );
  }

  describe("Happy Path - Full Work Submission Flow with Permits", () => {
    it("drives through all states using permits for recipient inputs", async () => {
      const [grantor, recipient] = await ethers.getSigners();
      const { factory: deployedFactory } = await deployProtocol();
      const factoryAddress = await deployedFactory.getAddress();
      const { publicClient: grantorPublic, walletClient: grantorWallet } =
        await createViemClientsForSigner(grantor);
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

      // Grantor uses signer
      const agreement = new AgreementEngineClass(
        agreementAddress,
        grantorPublic,
        grantorWallet
      );

      // Grantor submits their own input
      await agreement.submitInput(grantWithFeedback, "grantorData", sampleInputs.grantorData);
      expect(await agreement.getCurrentState(grantWithFeedback)).to.equal("AWAITING_RECIPIENT_SIGNATURE");

      // Recipient creates permit for recipientSigning
      const deadline1 = Math.floor(Date.now() / 1000) + 3600;
      const recipientSigningPermit = await createRecipientPermit(
        agreementAddress,
        recipient,
        "recipientSigning",
        sampleInputs.recipientSigning,
        deadline1
      );

      // Grantor submits recipient's input using permit
      await agreement.submitInputWithPermit(
        recipientSigningPermit.signerAddress,
        grantWithFeedback,
        "recipientSigning",
        sampleInputs.recipientSigning,
        deadline1,
        recipientSigningPermit.signature
      );
      expect(await agreement.getCurrentState(grantWithFeedback)).to.equal("AWAITING_GRANTOR_SIGNATURE");

      // Grantor submits their own input
      await agreement.submitInput(grantWithFeedback, "grantorSigning", sampleInputs.grantorSigning);
      expect(await agreement.getCurrentState(grantWithFeedback)).to.equal("AWAITING_WORK_SUBMISSION");

      // Recipient creates permit for workSubmission
      const deadline2 = Math.floor(Date.now() / 1000) + 3600;
      const workSubmissionPermit = await createRecipientPermit(
        agreementAddress,
        recipient,
        "workSubmission",
        sampleInputs.workSubmission,
        deadline2
      );

      // Grantor submits recipient's input using permit
      await agreement.submitInputWithPermit(
        workSubmissionPermit.signerAddress,
        grantWithFeedback,
        "workSubmission",
        sampleInputs.workSubmission,
        deadline2,
        workSubmissionPermit.signature
      );
      expect(await agreement.getCurrentState(grantWithFeedback)).to.equal("WORK_IN_REVIEW");

      // Grantor submits their own inputs
      await agreement.submitInput(grantWithFeedback, "workAccepted", sampleInputs.workAccepted);
      expect(await agreement.getCurrentState(grantWithFeedback)).to.equal("AWAITING_PAYMENT");

      await agreement.submitInput(grantWithFeedback, "workTokenSentTx", sampleInputs.workTokenSentTx);
      expect(await agreement.getCurrentState(grantWithFeedback)).to.equal("WORK_ACCEPTED_AND_PAID");
    });
  });

  describe("Work Feedback Loop with Permits", () => {
    it("allows grantor to request work resubmission (recipient uses permit for resubmission)", async () => {
      const [grantor, recipient] = await ethers.getSigners();
      const { factory: deployedFactory } = await deployProtocol();
      const factoryAddress = await deployedFactory.getAddress();
      const { publicClient: grantorPublic, walletClient: grantorWallet } =
        await createViemClientsForSigner(grantor);
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

      // Initial flow
      await agreement.submitInput(grantWithFeedback, "grantorData", sampleInputs.grantorData);
      
      const deadline1 = Math.floor(Date.now() / 1000) + 3600;
      const recipientSigningPermit = await createRecipientPermit(
        agreementAddress,
        recipient,
        "recipientSigning",
        sampleInputs.recipientSigning,
        deadline1
      );
      await agreement.submitInputWithPermit(
        recipientSigningPermit.signerAddress,
        grantWithFeedback,
        "recipientSigning",
        sampleInputs.recipientSigning,
        deadline1,
        recipientSigningPermit.signature
      );
      
      await agreement.submitInput(grantWithFeedback, "grantorSigning", sampleInputs.grantorSigning);
      
      const deadline2 = Math.floor(Date.now() / 1000) + 3600;
      const workSubmissionPermit = await createRecipientPermit(
        agreementAddress,
        recipient,
        "workSubmission",
        sampleInputs.workSubmission,
        deadline2
      );
      await agreement.submitInputWithPermit(
        workSubmissionPermit.signerAddress,
        grantWithFeedback,
        "workSubmission",
        sampleInputs.workSubmission,
        deadline2,
        workSubmissionPermit.signature
      );
      expect(await agreement.getCurrentState(grantWithFeedback)).to.equal("WORK_IN_REVIEW");

      // Grantor requests resubmission
      await agreement.submitInput(grantWithFeedback, "workResubmissionRequested", sampleInputs.workResubmissionRequested);
      expect(await agreement.getCurrentState(grantWithFeedback)).to.equal("AWAITING_WORK_SUBMISSION");

      // Recipient creates permit for resubmission (nonce has incremented, so this will get the new nonce)
      const deadline3 = Math.floor(Date.now() / 1000) + 3600;
      const resubmissionPermit = await createRecipientPermit(
        agreementAddress,
        recipient,
        "workSubmission",
        {
          submissionHash: "0xsecondsubmission",
          submissionUrl: "https://github.com/example/v2",
        },
        deadline3
      );

      // Grantor submits resubmission using permit
      await agreement.submitInputWithPermit(
        resubmissionPermit.signerAddress,
        grantWithFeedback,
        "workSubmission",
        {
          submissionHash: "0xsecondsubmission",
          submissionUrl: "https://github.com/example/v2",
        },
        deadline3,
        resubmissionPermit.signature
      );
      expect(await agreement.getCurrentState(grantWithFeedback)).to.equal("WORK_IN_REVIEW");

      await agreement.submitInput(grantWithFeedback, "workAccepted", sampleInputs.workAccepted);
      expect(await agreement.getCurrentState(grantWithFeedback)).to.equal("AWAITING_PAYMENT");
    });

    it("allows grantor to reject work (recipient can resubmit with permit)", async () => {
      const [grantor, recipient] = await ethers.getSigners();
      const { factory: deployedFactory } = await deployProtocol();
      const factoryAddress = await deployedFactory.getAddress();
      const { publicClient: grantorPublic, walletClient: grantorWallet } =
        await createViemClientsForSigner(grantor);
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

      await agreement.submitInput(grantWithFeedback, "grantorData", sampleInputs.grantorData);
      
      const deadline1 = Math.floor(Date.now() / 1000) + 3600;
      const recipientSigningPermit = await createRecipientPermit(
        agreementAddress,
        recipient,
        "recipientSigning",
        sampleInputs.recipientSigning,
        deadline1
      );
      await agreement.submitInputWithPermit(
        recipientSigningPermit.signerAddress,
        grantWithFeedback,
        "recipientSigning",
        sampleInputs.recipientSigning,
        deadline1,
        recipientSigningPermit.signature
      );
      
      await agreement.submitInput(grantWithFeedback, "grantorSigning", sampleInputs.grantorSigning);
      
      const deadline2 = Math.floor(Date.now() / 1000) + 3600;
      const workSubmissionPermit = await createRecipientPermit(
        agreementAddress,
        recipient,
        "workSubmission",
        sampleInputs.workSubmission,
        deadline2
      );
      await agreement.submitInputWithPermit(
        workSubmissionPermit.signerAddress,
        grantWithFeedback,
        "workSubmission",
        sampleInputs.workSubmission,
        deadline2,
        workSubmissionPermit.signature
      );

      // Grantor rejects work
      await agreement.submitInput(grantWithFeedback, "workRejected", sampleInputs.workRejected);
      expect(await agreement.getCurrentState(grantWithFeedback)).to.equal("AWAITING_WORK_SUBMISSION");
    });
  });

  describe("Rejection Path with Permits", () => {
    it("allows grantor to reject agreement at signing stage (after recipient permit)", async () => {
      const [grantor, recipient] = await ethers.getSigners();
      const { factory: deployedFactory } = await deployProtocol();
      const factoryAddress = await deployedFactory.getAddress();
      const { publicClient: grantorPublic, walletClient: grantorWallet } =
        await createViemClientsForSigner(grantor);
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

      await agreement.submitInput(grantWithFeedback, "grantorData", sampleInputs.grantorData);
      
      const deadline = Math.floor(Date.now() / 1000) + 3600;
      const recipientSigningPermit = await createRecipientPermit(
        agreementAddress,
        recipient,
        "recipientSigning",
        sampleInputs.recipientSigning,
        deadline
      );
      await agreement.submitInputWithPermit(
        recipientSigningPermit.signerAddress,
        grantWithFeedback,
        "recipientSigning",
        sampleInputs.recipientSigning,
        deadline,
        recipientSigningPermit.signature
      );
      
      await agreement.submitInput(grantWithFeedback, "grantorRejection", sampleInputs.grantorRejection);

      expect(await agreement.getCurrentState(grantWithFeedback)).to.equal("REJECTED");
    });
  });

  describe("Permit Validation", () => {
    it("rejects permit with expired deadline", async () => {
      const [grantor, recipient] = await ethers.getSigners();
      const { factory: deployedFactory } = await deployProtocol();
      const factoryAddress = await deployedFactory.getAddress();
      const { publicClient: grantorPublic, walletClient: grantorWallet } =
        await createViemClientsForSigner(grantor);
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

      await agreement.submitInput(grantWithFeedback, "grantorData", sampleInputs.grantorData);

      // Get current block timestamp and create permit with expired deadline
      const currentBlock = await ethers.provider.getBlock("latest");
      const expiredDeadline = currentBlock!.timestamp - 100; // 100 seconds in the past
      
      const expiredPermit = await createRecipientPermit(
        agreementAddress,
        recipient,
        "recipientSigning",
        sampleInputs.recipientSigning,
        expiredDeadline
      );

      try {
        await agreement.submitInputWithPermit(
          expiredPermit.signerAddress,
          grantWithFeedback,
          "recipientSigning",
          sampleInputs.recipientSigning,
          expiredDeadline,
          expiredPermit.signature
        );
        expect.fail("Expected transaction to revert with PermitExpired");
      } catch (error: any) {
        expect(error.message).to.include("PermitExpired");
      }
    });

    it("rejects permit with mismatched payload", async () => {
      const [grantor, recipient] = await ethers.getSigners();
      const { factory: deployedFactory } = await deployProtocol();
      const factoryAddress = await deployedFactory.getAddress();
      const { publicClient: grantorPublic, walletClient: grantorWallet } =
        await createViemClientsForSigner(grantor);
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

      await agreement.submitInput(grantWithFeedback, "grantorData", sampleInputs.grantorData);

      // Create permit for one set of data
      const deadline = Math.floor(Date.now() / 1000) + 3600;
      const permit = await createRecipientPermit(
        agreementAddress,
        recipient,
        "recipientSigning",
        sampleInputs.recipientSigning,
        deadline
      );

      // Try to submit with different data (should fail signature verification)
      try {
        await agreement.submitInputWithPermit(
          permit.signerAddress,
          grantWithFeedback,
          "recipientSigning",
          { recipientName: "Different Name", recipientSignature: "Different Signature" }, // Different data
          deadline,
          permit.signature
        );
        expect.fail("Expected transaction to revert with InvalidSignature");
      } catch (error: any) {
        expect(error.message).to.include("InvalidSignature");
      }
    });

    it("rejects permit with wrong signer address", async () => {
      const [grantor, recipient, wrongSigner] = await ethers.getSigners();
      const { factory: deployedFactory } = await deployProtocol();
      const factoryAddress = await deployedFactory.getAddress();
      const { publicClient: grantorPublic, walletClient: grantorWallet } =
        await createViemClientsForSigner(grantor);
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

      await agreement.submitInput(grantWithFeedback, "grantorData", sampleInputs.grantorData);

      // Create permit signed by recipient
      const deadline = Math.floor(Date.now() / 1000) + 3600;
      const permit = await createRecipientPermit(
        agreementAddress,
        recipient,
        "recipientSigning",
        sampleInputs.recipientSigning,
        deadline
      );

      // Try to submit claiming wrong signer address
      try {
        await agreement.submitInputWithPermit(
          wrongSigner.address as `0x${string}`, // Wrong signer
          grantWithFeedback,
          "recipientSigning",
          sampleInputs.recipientSigning,
          deadline,
          permit.signature
        );
        expect.fail("Expected transaction to revert with InvalidSignature");
      } catch (error: any) {
        expect(error.message).to.include("InvalidSignature");
      }
    });

    it("prevents replay attacks with nonce", async () => {
      const [grantor, recipient] = await ethers.getSigners();
      const { factory: deployedFactory } = await deployProtocol();
      const factoryAddress = await deployedFactory.getAddress();
      const { publicClient: grantorPublic, walletClient: grantorWallet } =
        await createViemClientsForSigner(grantor);
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

      await agreement.submitInput(grantWithFeedback, "grantorData", sampleInputs.grantorData);

      // Create permit
      const deadline = Math.floor(Date.now() / 1000) + 3600;
      const permit = await createRecipientPermit(
        agreementAddress,
        recipient,
        "recipientSigning",
        sampleInputs.recipientSigning,
        deadline
      );

      // Submit permit successfully
      await agreement.submitInputWithPermit(
        permit.signerAddress,
        grantWithFeedback,
        "recipientSigning",
        sampleInputs.recipientSigning,
        deadline,
        permit.signature
      );

      // Try to submit the same permit again (should fail - nonce was incremented)
      try {
        await agreement.submitInputWithPermit(
          permit.signerAddress,
          grantWithFeedback,
          "recipientSigning",
          sampleInputs.recipientSigning,
          deadline,
          permit.signature
        );
        expect.fail("Expected transaction to revert with InvalidSignature");
      } catch (error: any) {
        expect(error.message).to.include("InvalidSignature");
      }
    });
  });
});
