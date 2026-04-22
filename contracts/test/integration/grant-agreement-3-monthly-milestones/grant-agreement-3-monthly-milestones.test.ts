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

let intuitionGrantSigned: AgreementJson;
let sampleInputs: Record<string, Record<string, unknown>>;
let AgreementFactoryClass: any;
let AgreementEngineClass: any;

async function completeSignatures(
  agreement: any,
  agreementAsGrantee: any
): Promise<void> {
  expect(await agreement.getCurrentState(intuitionGrantSigned)).to.equal(
    "PENDING_GRANTEE_SIGNATURE"
  );
  await agreementAsGrantee.submitInput(
    intuitionGrantSigned,
    "granteeSigning",
    sampleInputs.granteeSigning
  );
  expect(await agreement.getCurrentState(intuitionGrantSigned)).to.equal(
    "PENDING_GRANTOR_SIGNATURE"
  );
  await agreement.submitInput(
    intuitionGrantSigned,
    "grantorSigning",
    sampleInputs.grantorSigning
  );
  expect(await agreement.getCurrentState(intuitionGrantSigned)).to.equal(
    "MONTH_1_KPI_SUBMISSION"
  );
}

function buildInitValues(grantor: any, grantee: any): Record<string, unknown> {
  return {
    effectiveDate: "2026-02-03T00:00:00Z",
    projectName: "Milestone Grant Pilot",
    granteeLegalName: "Example Grantee LLC",
    granteeCountry: "USA",
    granteeWalletAddress: grantee.address as Address,
    granteeEmail: "grantee@example.com",
    totalGrantAmount: 3000n,
    installmentAmount: 1000n,
    month1KpiSection:
      "### Month 1 KPIs\n- KPI 1: Complete 3 PRs\n- KPI 2: Improve onboarding docs",
    month2KpiSection:
      "### Month 2 KPIs\n- KPI 1: Deliver feature X\n- KPI 2: Engage community",
    month3KpiSection:
      "### Month 3 KPIs\n- KPI 1: Performance improvements\n- KPI 2: Maintainability",
    grantorWalletAddress: grantor.address as Address,
  };
}

function extractContentVariables(content: string): string[] {
  const matches = content.matchAll(/\$\{variables\.([A-Za-z0-9_]+)\}/g);
  return Array.from(matches, (match) => match[1]);
}

describe(
  "AgreementEngine (integration) - Grant Agreement - 3 Monthly Milestones FSM",
  () => {
  before(async () => {
    intuitionGrantSigned = loadAgreement(
      "grant-agreement-3-monthly-milestones"
    );
    sampleInputs = loadSampleInputs("grant-agreement-3-monthly-milestones");
    
    const sdkModule = await loadSDKModule();
    AgreementFactoryClass = sdkModule.AgreementFactory;
    AgreementEngineClass = sdkModule.AgreementEngine;
  });

  describe("Template variable usage", () => {
    it("matches defined variables with content placeholders", () => {
      const content = intuitionGrantSigned.content?.data;
      expect(content).to.be.a("string");

      const usedVariables = new Set(
        extractContentVariables(content as string)
      );
      const definedVariables = new Set(
        Object.keys(intuitionGrantSigned.variables || {})
      );

      expect(Array.from(usedVariables)).to.have.members(
        Array.from(definedVariables)
      );
      expect(Array.from(definedVariables)).to.have.members(
        Array.from(usedVariables)
      );
    });
  });

  describe("Happy Path - Complete 3-Month Grant Flow", () => {
    it("drives through all 3 months with approvals to COMPLETE state", async () => {
      const [grantor, grantee] = await ethers.getSigners();
      const { factory: deployedFactory } = await deployProtocol();
      const factoryAddress = await deployedFactory.getAddress();
      const { publicClient: grantorPublic, walletClient: grantorWallet } =
        await createViemClientsForSigner(grantor);
      const { publicClient: granteePublic, walletClient: granteeWallet } =
        await createViemClientsForSigner(grantee);
      const factory = new AgreementFactoryClass(
        { factoryAddress: factoryAddress as `0x${string}` },
        { walletClient: grantorWallet, publicClient: grantorPublic }
      );

      const { address: agreementAddress } = await factory.createAgreement(
        intuitionGrantSigned,
        {
          initValues: buildInitValues(grantor, grantee),
        }
      );

      const agreement = new AgreementEngineClass(
        agreementAddress,
        grantorPublic,
        grantorWallet
      );
      const agreementAsGrantee = new AgreementEngineClass(
        agreementAddress,
        granteePublic,
        granteeWallet
      );

      await completeSignatures(agreement, agreementAsGrantee);

      // Month 1: Submit work
      await agreementAsGrantee.submitInput(intuitionGrantSigned, "m1WorkSubmission", sampleInputs.m1WorkSubmission);
      expect(await agreement.getCurrentState(intuitionGrantSigned)).to.equal("MONTH_1_KPI_REVIEW");

      // Month 1: Approve
      await agreement.submitInput(intuitionGrantSigned, "m1ApproveSubmission", sampleInputs.m1ApproveSubmission);
      expect(await agreement.getCurrentState(intuitionGrantSigned)).to.equal("MONTH_2_KPI_SUBMISSION");

      // Month 2: Submit work
      await agreementAsGrantee.submitInput(intuitionGrantSigned, "m2WorkSubmission", sampleInputs.m2WorkSubmission);
      expect(await agreement.getCurrentState(intuitionGrantSigned)).to.equal("MONTH_2_KPI_REVIEW");

      // Month 2: Approve
      await agreement.submitInput(intuitionGrantSigned, "m2ApproveSubmission", sampleInputs.m2ApproveSubmission);
      expect(await agreement.getCurrentState(intuitionGrantSigned)).to.equal("MONTH_3_KPI_SUBMISSION");

      // Month 3: Submit work
      await agreementAsGrantee.submitInput(intuitionGrantSigned, "m3WorkSubmission", sampleInputs.m3WorkSubmission);
      expect(await agreement.getCurrentState(intuitionGrantSigned)).to.equal("MONTH_3_KPI_REVIEW");

      // Month 3: Approve - reaches COMPLETE
      await agreement.submitInput(intuitionGrantSigned, "m3ApproveSubmission", sampleInputs.m3ApproveSubmission);
      expect(await agreement.getCurrentState(intuitionGrantSigned)).to.equal("COMPLETE");
    });
  });

  describe("Month 1 - Rejection and Resubmission Flow", () => {
    it("allows grantor to reject Month 1 submission and grantee to resubmit", async () => {
      const [grantor, grantee] = await ethers.getSigners();
      const { factory: deployedFactory } = await deployProtocol();
      const factoryAddress = await deployedFactory.getAddress();
      const { publicClient: grantorPublic, walletClient: grantorWallet } =
        await createViemClientsForSigner(grantor);
      const { publicClient: granteePublic, walletClient: granteeWallet } =
        await createViemClientsForSigner(grantee);
      const factory = new AgreementFactoryClass(
        { factoryAddress: factoryAddress as `0x${string}` },
        { walletClient: grantorWallet, publicClient: grantorPublic }
      );

      const { address: agreementAddress } = await factory.createAgreement(
        intuitionGrantSigned,
        {
          initValues: buildInitValues(grantor, grantee),
        }
      );

      const agreement = new AgreementEngineClass(
        agreementAddress,
        grantorPublic,
        grantorWallet
      );
      const agreementAsGrantee = new AgreementEngineClass(
        agreementAddress,
        granteePublic,
        granteeWallet
      );

      await completeSignatures(agreement, agreementAsGrantee);

      // Month 1: Submit work
      await agreementAsGrantee.submitInput(intuitionGrantSigned, "m1WorkSubmission", sampleInputs.m1WorkSubmission);
      expect(await agreement.getCurrentState(intuitionGrantSigned)).to.equal("MONTH_1_KPI_REVIEW");

      // Month 1: Reject
      await agreement.submitInput(intuitionGrantSigned, "m1RejectSubmission", sampleInputs.m1RejectSubmission);
      expect(await agreement.getCurrentState(intuitionGrantSigned)).to.equal("MONTH_1_KPI_SUBMISSION");

      // Month 1: Resubmit with improvements
      await agreementAsGrantee.submitInput(intuitionGrantSigned, "m1WorkSubmission", {
        submissionContent: "Month 1 KPI Resubmission: Added all implementation links and updated documentation per feedback. References: PR-123, PR-124, PR-125"
      });
      expect(await agreement.getCurrentState(intuitionGrantSigned)).to.equal("MONTH_1_KPI_REVIEW");

      // Month 1: Approve after resubmission
      await agreement.submitInput(intuitionGrantSigned, "m1ApproveSubmission", sampleInputs.m1ApproveSubmission);
      expect(await agreement.getCurrentState(intuitionGrantSigned)).to.equal("MONTH_2_KPI_SUBMISSION");
    });
  });

  describe("Month 2 - Rejection and Resubmission Flow", () => {
    it("allows grantor to reject Month 2 submission and grantee to resubmit", async () => {
      const [grantor, grantee] = await ethers.getSigners();
      const { factory: deployedFactory } = await deployProtocol();
      const factoryAddress = await deployedFactory.getAddress();
      const { publicClient: grantorPublic, walletClient: grantorWallet } =
        await createViemClientsForSigner(grantor);
      const { publicClient: granteePublic, walletClient: granteeWallet } =
        await createViemClientsForSigner(grantee);
      const factory = new AgreementFactoryClass(
        { factoryAddress: factoryAddress as `0x${string}` },
        { walletClient: grantorWallet, publicClient: grantorPublic }
      );

      const { address: agreementAddress } = await factory.createAgreement(
        intuitionGrantSigned,
        {
          initValues: buildInitValues(grantor, grantee),
        }
      );

      const agreement = new AgreementEngineClass(
        agreementAddress,
        grantorPublic,
        grantorWallet
      );
      const agreementAsGrantee = new AgreementEngineClass(
        agreementAddress,
        granteePublic,
        granteeWallet
      );

      await completeSignatures(agreement, agreementAsGrantee);

      // Complete Month 1
      await agreementAsGrantee.submitInput(intuitionGrantSigned, "m1WorkSubmission", sampleInputs.m1WorkSubmission);
      await agreement.submitInput(intuitionGrantSigned, "m1ApproveSubmission", sampleInputs.m1ApproveSubmission);
      expect(await agreement.getCurrentState(intuitionGrantSigned)).to.equal("MONTH_2_KPI_SUBMISSION");

      // Month 2: Submit work
      await agreementAsGrantee.submitInput(intuitionGrantSigned, "m2WorkSubmission", sampleInputs.m2WorkSubmission);
      expect(await agreement.getCurrentState(intuitionGrantSigned)).to.equal("MONTH_2_KPI_REVIEW");

      // Month 2: Reject
      await agreement.submitInput(intuitionGrantSigned, "m2RejectSubmission", sampleInputs.m2RejectSubmission);
      expect(await agreement.getCurrentState(intuitionGrantSigned)).to.equal("MONTH_2_KPI_SUBMISSION");

      // Month 2: Resubmit
      await agreementAsGrantee.submitInput(intuitionGrantSigned, "m2WorkSubmission", {
        submissionContent: "Month 2 KPI Resubmission: Added comprehensive test coverage and documented community engagement metrics."
      });
      expect(await agreement.getCurrentState(intuitionGrantSigned)).to.equal("MONTH_2_KPI_REVIEW");

      // Month 2: Approve
      await agreement.submitInput(intuitionGrantSigned, "m2ApproveSubmission", sampleInputs.m2ApproveSubmission);
      expect(await agreement.getCurrentState(intuitionGrantSigned)).to.equal("MONTH_3_KPI_SUBMISSION");
    });
  });

  describe("Month 3 - Rejection and Resubmission Flow", () => {
    it("allows grantor to reject Month 3 submission and grantee to resubmit", async () => {
      const [grantor, grantee] = await ethers.getSigners();
      const { factory: deployedFactory } = await deployProtocol();
      const factoryAddress = await deployedFactory.getAddress();
      const { publicClient: grantorPublic, walletClient: grantorWallet } =
        await createViemClientsForSigner(grantor);
      const { publicClient: granteePublic, walletClient: granteeWallet } =
        await createViemClientsForSigner(grantee);
      const factory = new AgreementFactoryClass(
        { factoryAddress: factoryAddress as `0x${string}` },
        { walletClient: grantorWallet, publicClient: grantorPublic }
      );

      const { address: agreementAddress } = await factory.createAgreement(
        intuitionGrantSigned,
        {
          initValues: buildInitValues(grantor, grantee),
        }
      );

      const agreement = new AgreementEngineClass(
        agreementAddress,
        grantorPublic,
        grantorWallet
      );
      const agreementAsGrantee = new AgreementEngineClass(
        agreementAddress,
        granteePublic,
        granteeWallet
      );

      await completeSignatures(agreement, agreementAsGrantee);

      // Complete Month 1 and 2
      await agreementAsGrantee.submitInput(intuitionGrantSigned, "m1WorkSubmission", sampleInputs.m1WorkSubmission);
      await agreement.submitInput(intuitionGrantSigned, "m1ApproveSubmission", sampleInputs.m1ApproveSubmission);
      await agreementAsGrantee.submitInput(intuitionGrantSigned, "m2WorkSubmission", sampleInputs.m2WorkSubmission);
      await agreement.submitInput(intuitionGrantSigned, "m2ApproveSubmission", sampleInputs.m2ApproveSubmission);
      expect(await agreement.getCurrentState(intuitionGrantSigned)).to.equal("MONTH_3_KPI_SUBMISSION");

      // Month 3: Submit work
      await agreementAsGrantee.submitInput(intuitionGrantSigned, "m3WorkSubmission", sampleInputs.m3WorkSubmission);
      expect(await agreement.getCurrentState(intuitionGrantSigned)).to.equal("MONTH_3_KPI_REVIEW");

      // Month 3: Reject
      await agreement.submitInput(intuitionGrantSigned, "m3RejectSubmission", sampleInputs.m3RejectSubmission);
      expect(await agreement.getCurrentState(intuitionGrantSigned)).to.equal("MONTH_3_KPI_SUBMISSION");

      // Month 3: Resubmit
      await agreementAsGrantee.submitInput(intuitionGrantSigned, "m3WorkSubmission", {
        submissionContent: "Month 3 KPI Resubmission: Added comprehensive performance benchmarks and addressed all code review comments."
      });
      expect(await agreement.getCurrentState(intuitionGrantSigned)).to.equal("MONTH_3_KPI_REVIEW");

      // Month 3: Approve - reaches COMPLETE
      await agreement.submitInput(intuitionGrantSigned, "m3ApproveSubmission", sampleInputs.m3ApproveSubmission);
      expect(await agreement.getCurrentState(intuitionGrantSigned)).to.equal("COMPLETE");
    });
  });

  describe("Termination Paths", () => {
    it("allows grantor to terminate during Month 1 submission", async () => {
      const [grantor, grantee] = await ethers.getSigners();
      const { factory: deployedFactory } = await deployProtocol();
      const factoryAddress = await deployedFactory.getAddress();
      const { publicClient: grantorPublic, walletClient: grantorWallet } =
        await createViemClientsForSigner(grantor);
      const { publicClient: granteePublic, walletClient: granteeWallet } =
        await createViemClientsForSigner(grantee);
      const factory = new AgreementFactoryClass(
        { factoryAddress: factoryAddress as `0x${string}` },
        { walletClient: grantorWallet, publicClient: grantorPublic }
      );

      const { address: agreementAddress } = await factory.createAgreement(
        intuitionGrantSigned,
        {
          initValues: buildInitValues(grantor, grantee),
        }
      );

      const agreement = new AgreementEngineClass(
        agreementAddress,
        grantorPublic,
        grantorWallet
      );
      const agreementAsGrantee = new AgreementEngineClass(
        agreementAddress,
        granteePublic,
        granteeWallet
      );

      await completeSignatures(agreement, agreementAsGrantee);

      await agreement.submitInput(intuitionGrantSigned, "m1TerminateAgreement", sampleInputs.m1TerminateAgreement);
      expect(await agreement.getCurrentState(intuitionGrantSigned)).to.equal("AGREEMENT_TERMINATED");
    });

    it("allows grantor to terminate during Month 1 review", async () => {
      const [grantor, grantee] = await ethers.getSigners();
      const { factory: deployedFactory } = await deployProtocol();
      const factoryAddress = await deployedFactory.getAddress();
      const { publicClient: grantorPublic, walletClient: grantorWallet } =
        await createViemClientsForSigner(grantor);
      const { publicClient: granteePublic, walletClient: granteeWallet } =
        await createViemClientsForSigner(grantee);
      const factory = new AgreementFactoryClass(
        { factoryAddress: factoryAddress as `0x${string}` },
        { walletClient: grantorWallet, publicClient: grantorPublic }
      );

      const { address: agreementAddress } = await factory.createAgreement(
        intuitionGrantSigned,
        {
          initValues: buildInitValues(grantor, grantee),
        }
      );

      const agreement = new AgreementEngineClass(
        agreementAddress,
        grantorPublic,
        grantorWallet
      );
      const agreementAsGrantee = new AgreementEngineClass(
        agreementAddress,
        granteePublic,
        granteeWallet
      );

      await completeSignatures(agreement, agreementAsGrantee);

      await agreementAsGrantee.submitInput(intuitionGrantSigned, "m1WorkSubmission", sampleInputs.m1WorkSubmission);
      expect(await agreement.getCurrentState(intuitionGrantSigned)).to.equal("MONTH_1_KPI_REVIEW");

      await agreement.submitInput(intuitionGrantSigned, "m1TerminateAgreement", sampleInputs.m1TerminateAgreement);
      expect(await agreement.getCurrentState(intuitionGrantSigned)).to.equal("AGREEMENT_TERMINATED");
    });

    it("allows grantor to terminate during Month 2 submission", async () => {
      const [grantor, grantee] = await ethers.getSigners();
      const { factory: deployedFactory } = await deployProtocol();
      const factoryAddress = await deployedFactory.getAddress();
      const { publicClient: grantorPublic, walletClient: grantorWallet } =
        await createViemClientsForSigner(grantor);
      const { publicClient: granteePublic, walletClient: granteeWallet } =
        await createViemClientsForSigner(grantee);
      const factory = new AgreementFactoryClass(
        { factoryAddress: factoryAddress as `0x${string}` },
        { walletClient: grantorWallet, publicClient: grantorPublic }
      );

      const { address: agreementAddress } = await factory.createAgreement(
        intuitionGrantSigned,
        {
          initValues: buildInitValues(grantor, grantee),
        }
      );

      const agreement = new AgreementEngineClass(
        agreementAddress,
        grantorPublic,
        grantorWallet
      );
      const agreementAsGrantee = new AgreementEngineClass(
        agreementAddress,
        granteePublic,
        granteeWallet
      );

      await completeSignatures(agreement, agreementAsGrantee);

      // Complete Month 1
      await agreementAsGrantee.submitInput(intuitionGrantSigned, "m1WorkSubmission", sampleInputs.m1WorkSubmission);
      await agreement.submitInput(intuitionGrantSigned, "m1ApproveSubmission", sampleInputs.m1ApproveSubmission);
      expect(await agreement.getCurrentState(intuitionGrantSigned)).to.equal("MONTH_2_KPI_SUBMISSION");

      await agreement.submitInput(intuitionGrantSigned, "m2TerminateAgreement", sampleInputs.m2TerminateAgreement);
      expect(await agreement.getCurrentState(intuitionGrantSigned)).to.equal("AGREEMENT_TERMINATED");
    });

    it("allows grantor to terminate during Month 3 review", async () => {
      const [grantor, grantee] = await ethers.getSigners();
      const { factory: deployedFactory } = await deployProtocol();
      const factoryAddress = await deployedFactory.getAddress();
      const { publicClient: grantorPublic, walletClient: grantorWallet } =
        await createViemClientsForSigner(grantor);
      const { publicClient: granteePublic, walletClient: granteeWallet } =
        await createViemClientsForSigner(grantee);
      const factory = new AgreementFactoryClass(
        { factoryAddress: factoryAddress as `0x${string}` },
        { walletClient: grantorWallet, publicClient: grantorPublic }
      );

      const { address: agreementAddress } = await factory.createAgreement(
        intuitionGrantSigned,
        {
          initValues: buildInitValues(grantor, grantee),
        }
      );

      const agreement = new AgreementEngineClass(
        agreementAddress,
        grantorPublic,
        grantorWallet
      );
      const agreementAsGrantee = new AgreementEngineClass(
        agreementAddress,
        granteePublic,
        granteeWallet
      );

      await completeSignatures(agreement, agreementAsGrantee);

      // Complete Month 1 and 2
      await agreementAsGrantee.submitInput(intuitionGrantSigned, "m1WorkSubmission", sampleInputs.m1WorkSubmission);
      await agreement.submitInput(intuitionGrantSigned, "m1ApproveSubmission", sampleInputs.m1ApproveSubmission);
      await agreementAsGrantee.submitInput(intuitionGrantSigned, "m2WorkSubmission", sampleInputs.m2WorkSubmission);
      await agreement.submitInput(intuitionGrantSigned, "m2ApproveSubmission", sampleInputs.m2ApproveSubmission);
      await agreementAsGrantee.submitInput(intuitionGrantSigned, "m3WorkSubmission", sampleInputs.m3WorkSubmission);
      expect(await agreement.getCurrentState(intuitionGrantSigned)).to.equal("MONTH_3_KPI_REVIEW");

      await agreement.submitInput(intuitionGrantSigned, "m3TerminateAgreement", sampleInputs.m3TerminateAgreement);
      expect(await agreement.getCurrentState(intuitionGrantSigned)).to.equal("AGREEMENT_TERMINATED");
    });
  });

  describe("Signer Validation Enforcement", () => {
    it("rejects grantee signature from wrong address (grantor instead of grantee)", async () => {
      const [grantor, grantee] = await ethers.getSigners();
      const { factory: deployedFactory } = await deployProtocol();
      const factoryAddress = await deployedFactory.getAddress();
      const { publicClient: grantorPublic, walletClient: grantorWallet } =
        await createViemClientsForSigner(grantor);
      const { publicClient: granteePublic, walletClient: granteeWallet } =
        await createViemClientsForSigner(grantee);
      const factory = new AgreementFactoryClass(
        { factoryAddress: factoryAddress as `0x${string}` },
        { walletClient: grantorWallet, publicClient: grantorPublic }
      );

      const { address: agreementAddress } = await factory.createAgreement(
        intuitionGrantSigned,
        {
          initValues: buildInitValues(grantor, grantee),
        }
      );

      const agreement = new AgreementEngineClass(
        agreementAddress,
        grantorPublic,
        grantorWallet
      );

      try {
        await agreement.submitInput(intuitionGrantSigned, "granteeSigning", sampleInputs.granteeSigning);
        expect.fail("Expected transaction to revert with SenderAddressMismatch");
      } catch (error: any) {
        expect(error.message).to.include("SenderAddressMismatch");
      }

      expect(await agreement.getCurrentState(intuitionGrantSigned)).to.equal("PENDING_GRANTEE_SIGNATURE");
    });

    it("rejects grantor signature from wrong address (grantee instead of grantor)", async () => {
      const [grantor, grantee] = await ethers.getSigners();
      const { factory: deployedFactory } = await deployProtocol();
      const factoryAddress = await deployedFactory.getAddress();
      const { publicClient: grantorPublic, walletClient: grantorWallet } =
        await createViemClientsForSigner(grantor);
      const { publicClient: granteePublic, walletClient: granteeWallet } =
        await createViemClientsForSigner(grantee);
      const factory = new AgreementFactoryClass(
        { factoryAddress: factoryAddress as `0x${string}` },
        { walletClient: grantorWallet, publicClient: grantorPublic }
      );

      const { address: agreementAddress } = await factory.createAgreement(
        intuitionGrantSigned,
        {
          initValues: buildInitValues(grantor, grantee),
        }
      );

      const agreement = new AgreementEngineClass(
        agreementAddress,
        grantorPublic,
        grantorWallet
      );
      const agreementAsGrantee = new AgreementEngineClass(
        agreementAddress,
        granteePublic,
        granteeWallet
      );

      await agreementAsGrantee.submitInput(intuitionGrantSigned, "granteeSigning", sampleInputs.granteeSigning);
      expect(await agreement.getCurrentState(intuitionGrantSigned)).to.equal("PENDING_GRANTOR_SIGNATURE");

      try {
        await agreementAsGrantee.submitInput(intuitionGrantSigned, "grantorSigning", sampleInputs.grantorSigning);
        expect.fail("Expected transaction to revert with SenderAddressMismatch");
      } catch (error: any) {
        expect(error.message).to.include("SenderAddressMismatch");
      }

      expect(await agreement.getCurrentState(intuitionGrantSigned)).to.equal("PENDING_GRANTOR_SIGNATURE");
    });

    it("rejects Month 1 work submission from wrong address (grantor instead of grantee)", async () => {
      const [grantor, grantee] = await ethers.getSigners();
      const { factory: deployedFactory } = await deployProtocol();
      const factoryAddress = await deployedFactory.getAddress();
      const { publicClient: grantorPublic, walletClient: grantorWallet } =
        await createViemClientsForSigner(grantor);
      const { publicClient: granteePublic, walletClient: granteeWallet } =
        await createViemClientsForSigner(grantee);
      const factory = new AgreementFactoryClass(
        { factoryAddress: factoryAddress as `0x${string}` },
        { walletClient: grantorWallet, publicClient: grantorPublic }
      );

      const { address: agreementAddress } = await factory.createAgreement(
        intuitionGrantSigned,
        {
          initValues: buildInitValues(grantor, grantee),
        }
      );

      const agreement = new AgreementEngineClass(
        agreementAddress,
        grantorPublic,
        grantorWallet
      );
      const agreementAsGrantee = new AgreementEngineClass(
        agreementAddress,
        granteePublic,
        granteeWallet
      );

      await completeSignatures(agreement, agreementAsGrantee);

      try {
        await agreement.submitInput(intuitionGrantSigned, "m1WorkSubmission", sampleInputs.m1WorkSubmission);
        expect.fail("Expected transaction to revert with SenderAddressMismatch");
      } catch (error: any) {
        expect(error.message).to.include("SenderAddressMismatch");
      }

      expect(await agreement.getCurrentState(intuitionGrantSigned)).to.equal("MONTH_1_KPI_SUBMISSION");
    });

    it("rejects Month 1 approval from wrong address (grantee instead of grantor)", async () => {
      const [grantor, grantee] = await ethers.getSigners();
      const { factory: deployedFactory } = await deployProtocol();
      const factoryAddress = await deployedFactory.getAddress();
      const { publicClient: grantorPublic, walletClient: grantorWallet } =
        await createViemClientsForSigner(grantor);
      const { publicClient: granteePublic, walletClient: granteeWallet } =
        await createViemClientsForSigner(grantee);
      const factory = new AgreementFactoryClass(
        { factoryAddress: factoryAddress as `0x${string}` },
        { walletClient: grantorWallet, publicClient: grantorPublic }
      );

      const { address: agreementAddress } = await factory.createAgreement(
        intuitionGrantSigned,
        {
          initValues: buildInitValues(grantor, grantee),
        }
      );

      const agreement = new AgreementEngineClass(
        agreementAddress,
        grantorPublic,
        grantorWallet
      );
      const agreementAsGrantee = new AgreementEngineClass(
        agreementAddress,
        granteePublic,
        granteeWallet
      );

      await completeSignatures(agreement, agreementAsGrantee);

      await agreementAsGrantee.submitInput(intuitionGrantSigned, "m1WorkSubmission", sampleInputs.m1WorkSubmission);
      expect(await agreement.getCurrentState(intuitionGrantSigned)).to.equal("MONTH_1_KPI_REVIEW");

      try {
        await agreementAsGrantee.submitInput(intuitionGrantSigned, "m1ApproveSubmission", sampleInputs.m1ApproveSubmission);
        expect.fail("Expected transaction to revert with SenderAddressMismatch");
      } catch (error: any) {
        expect(error.message).to.include("SenderAddressMismatch");
      }

      expect(await agreement.getCurrentState(intuitionGrantSigned)).to.equal("MONTH_1_KPI_REVIEW");
    });

    it("rejects Month 2 rejection from wrong address", async () => {
      const [grantor, grantee] = await ethers.getSigners();
      const { factory: deployedFactory } = await deployProtocol();
      const factoryAddress = await deployedFactory.getAddress();
      const { publicClient: grantorPublic, walletClient: grantorWallet } =
        await createViemClientsForSigner(grantor);
      const { publicClient: granteePublic, walletClient: granteeWallet } =
        await createViemClientsForSigner(grantee);
      const factory = new AgreementFactoryClass(
        { factoryAddress: factoryAddress as `0x${string}` },
        { walletClient: grantorWallet, publicClient: grantorPublic }
      );

      const { address: agreementAddress } = await factory.createAgreement(
        intuitionGrantSigned,
        {
          initValues: buildInitValues(grantor, grantee),
        }
      );

      const agreement = new AgreementEngineClass(
        agreementAddress,
        grantorPublic,
        grantorWallet
      );
      const agreementAsGrantee = new AgreementEngineClass(
        agreementAddress,
        granteePublic,
        granteeWallet
      );

      await completeSignatures(agreement, agreementAsGrantee);

      // Complete Month 1
      await agreementAsGrantee.submitInput(intuitionGrantSigned, "m1WorkSubmission", sampleInputs.m1WorkSubmission);
      await agreement.submitInput(intuitionGrantSigned, "m1ApproveSubmission", sampleInputs.m1ApproveSubmission);
      await agreementAsGrantee.submitInput(intuitionGrantSigned, "m2WorkSubmission", sampleInputs.m2WorkSubmission);
      expect(await agreement.getCurrentState(intuitionGrantSigned)).to.equal("MONTH_2_KPI_REVIEW");

      try {
        await agreementAsGrantee.submitInput(intuitionGrantSigned, "m2RejectSubmission", sampleInputs.m2RejectSubmission);
        expect.fail("Expected transaction to revert with SenderAddressMismatch");
      } catch (error: any) {
        expect(error.message).to.include("SenderAddressMismatch");
      }

      expect(await agreement.getCurrentState(intuitionGrantSigned)).to.equal("MONTH_2_KPI_REVIEW");
    });

    it("rejects termination from wrong address (grantee instead of grantor)", async () => {
      const [grantor, grantee] = await ethers.getSigners();
      const { factory: deployedFactory } = await deployProtocol();
      const factoryAddress = await deployedFactory.getAddress();
      const { publicClient: grantorPublic, walletClient: grantorWallet } =
        await createViemClientsForSigner(grantor);
      const { publicClient: granteePublic, walletClient: granteeWallet } =
        await createViemClientsForSigner(grantee);
      const factory = new AgreementFactoryClass(
        { factoryAddress: factoryAddress as `0x${string}` },
        { walletClient: grantorWallet, publicClient: grantorPublic }
      );

      const { address: agreementAddress } = await factory.createAgreement(
        intuitionGrantSigned,
        {
          initValues: buildInitValues(grantor, grantee),
        }
      );

      const agreement = new AgreementEngineClass(
        agreementAddress,
        grantorPublic,
        grantorWallet
      );
      const agreementAsGrantee = new AgreementEngineClass(
        agreementAddress,
        granteePublic,
        granteeWallet
      );

      await completeSignatures(agreement, agreementAsGrantee);

      try {
        await agreementAsGrantee.submitInput(intuitionGrantSigned, "m1TerminateAgreement", sampleInputs.m1TerminateAgreement);
        expect.fail("Expected transaction to revert with SenderAddressMismatch");
      } catch (error: any) {
        expect(error.message).to.include("SenderAddressMismatch");
      }

      expect(await agreement.getCurrentState(intuitionGrantSigned)).to.equal("MONTH_1_KPI_SUBMISSION");
    });
  });

  describe("Multiple Rejection Cycles", () => {
    it("allows multiple rejection and resubmission cycles in Month 1", async () => {
      const [grantor, grantee] = await ethers.getSigners();
      const { factory: deployedFactory } = await deployProtocol();
      const factoryAddress = await deployedFactory.getAddress();
      const { publicClient: grantorPublic, walletClient: grantorWallet } =
        await createViemClientsForSigner(grantor);
      const { publicClient: granteePublic, walletClient: granteeWallet } =
        await createViemClientsForSigner(grantee);
      const factory = new AgreementFactoryClass(
        { factoryAddress: factoryAddress as `0x${string}` },
        { walletClient: grantorWallet, publicClient: grantorPublic }
      );

      const { address: agreementAddress } = await factory.createAgreement(
        intuitionGrantSigned,
        {
          initValues: buildInitValues(grantor, grantee),
        }
      );

      const agreement = new AgreementEngineClass(
        agreementAddress,
        grantorPublic,
        grantorWallet
      );
      const agreementAsGrantee = new AgreementEngineClass(
        agreementAddress,
        granteePublic,
        granteeWallet
      );

      await completeSignatures(agreement, agreementAsGrantee);

      // First submission
      await agreementAsGrantee.submitInput(intuitionGrantSigned, "m1WorkSubmission", sampleInputs.m1WorkSubmission);
      expect(await agreement.getCurrentState(intuitionGrantSigned)).to.equal("MONTH_1_KPI_REVIEW");

      // First rejection
      await agreement.submitInput(intuitionGrantSigned, "m1RejectSubmission", sampleInputs.m1RejectSubmission);
      expect(await agreement.getCurrentState(intuitionGrantSigned)).to.equal("MONTH_1_KPI_SUBMISSION");

      // Second submission
      await agreementAsGrantee.submitInput(intuitionGrantSigned, "m1WorkSubmission", {
        submissionContent: "Month 1 second attempt"
      });
      expect(await agreement.getCurrentState(intuitionGrantSigned)).to.equal("MONTH_1_KPI_REVIEW");

      // Second rejection
      await agreement.submitInput(intuitionGrantSigned, "m1RejectSubmission", {
        feedback: "Still needs more work",
        isApproved: false
      });
      expect(await agreement.getCurrentState(intuitionGrantSigned)).to.equal("MONTH_1_KPI_SUBMISSION");

      // Third submission
      await agreementAsGrantee.submitInput(intuitionGrantSigned, "m1WorkSubmission", {
        submissionContent: "Month 1 final attempt with all requirements"
      });
      expect(await agreement.getCurrentState(intuitionGrantSigned)).to.equal("MONTH_1_KPI_REVIEW");

      // Final approval
      await agreement.submitInput(intuitionGrantSigned, "m1ApproveSubmission", sampleInputs.m1ApproveSubmission);
      expect(await agreement.getCurrentState(intuitionGrantSigned)).to.equal("MONTH_2_KPI_SUBMISSION");
    });
  });
});
