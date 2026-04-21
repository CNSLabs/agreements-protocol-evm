import { expect } from "chai";
import { ethers } from "hardhat";
import { Address } from "viem";
import { AgreementEngine } from "../../../typechain-types";
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

describe("AgreementEngine (integration) - grant-simple FSM with issuer validation", () => {
  before(async () => {
    grantSimple = loadAgreement("grant-simple");
    sampleInputs = loadSampleInputs("grant-simple");
    
    // Load SDK module
    const sdkModule = await loadSDKModule();
    AgreementFactoryClass = sdkModule.AgreementFactory;
    AgreementEngineClass = sdkModule.AgreementEngine;
  });

  describe("Happy Path with Issuer Validation", () => {
    it("drives through all states with correct signers", async () => {
      const [grantor, recipient] = await ethers.getSigners();
      
      // Deploy protocol and create SDK factory
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
      
      // Create agreement using SDK
      const { address: agreementAddress } = await factory.createAgreement(grantSimple, {
        initValues: {
          grantorEthAddress: grantor.address as Address,
          recipientEthAddress: recipient.address as Address,
        }
      });
      
      // Create SDK agreement instance
      const agreement = new AgreementEngineClass(
        agreementAddress,
        grantorPublic,
        grantorWallet
      );
      
      // Submit inputs using SDK
      await agreement.submitInput(grantSimple, "grantorData", sampleInputs.grantorData);
      const state1 = await agreement.getCurrentState(grantSimple);
      expect(state1).to.equal("AWAITING_RECIPIENT_SIGNATURE");

      // Switch to recipient signer
      const agreementAsRecipient = new AgreementEngineClass(
        agreementAddress,
        recipientPublic,
        recipientWallet
      );
      await agreementAsRecipient.submitInput(grantSimple, "recipientSigning", sampleInputs.recipientSigning);
      const state2 = await agreement.getCurrentState(grantSimple);
      expect(state2).to.equal("AWAITING_GRANTOR_SIGNATURE");

      // Back to grantor
      await agreement.submitInput(grantSimple, "grantorSigning", sampleInputs.grantorSigning);
      const state3 = await agreement.getCurrentState(grantSimple);
      expect(state3).to.equal("AWAITING_PAYMENT");

      await agreement.submitInput(grantSimple, "workTokenSentTx", sampleInputs.workTokenSentTx);
      const state4 = await agreement.getCurrentState(grantSimple);
      expect(state4).to.equal("WORK_ACCEPTED_AND_PAID");
    });
  });

  describe("Rejection Path with Issuer Validation", () => {
    it("allows grantor to reject at AWAITING_GRANTOR_SIGNATURE", async () => {
      const [grantor, recipient] = await ethers.getSigners();
      
      // Deploy protocol and create SDK factory
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
      
      // Create agreement using SDK
      const { address: agreementAddress } = await factory.createAgreement(grantSimple, {
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
      
      await agreement.submitInput(grantSimple, "grantorData", sampleInputs.grantorData);
      await agreementAsRecipient.submitInput(grantSimple, "recipientSigning", sampleInputs.recipientSigning);
      await agreement.submitInput(grantSimple, "grantorRejection", sampleInputs.grantorRejection);

      const state = await agreement.getCurrentState(grantSimple);
      expect(state).to.equal("REJECTED");
    });
  });

  describe("Issuer Validation Enforcement", () => {
    it("rejects first input (grantorData) from wrong address", async () => {
      const [grantor, recipient, attacker] = await ethers.getSigners();

      // Deploy protocol and create SDK factory
      const { factory: deployedFactory } = await deployProtocol();
      const factoryAddress = await deployedFactory.getAddress();
      const { publicClient: grantorPublic, walletClient: grantorWallet } =
        await createViemClientsForSigner(grantor);
      const { publicClient: attackerPublic, walletClient: attackerWallet } =
        await createViemClientsForSigner(attacker);
      const factory = new AgreementFactoryClass(
        { factoryAddress: factoryAddress as `0x${string}` },
        { walletClient: grantorWallet, publicClient: grantorPublic }
      );
      
      // Create agreement using SDK
      const { address: agreementAddress } = await factory.createAgreement(grantSimple, {
        initValues: {
          grantorEthAddress: grantor.address as Address,
          recipientEthAddress: recipient.address as Address,
        }
      });

      // Get the actual contract for error checking
      const engine = await ethers.getContractAt("AgreementEngine", agreementAddress);
      const agreementAsAttacker = new AgreementEngineClass(
        agreementAddress,
        attackerPublic,
        attackerWallet
      );
      const agreementForState = new AgreementEngineClass(
        agreementAddress,
        grantorPublic,
        grantorWallet
      );

      // Expect revert due to sender mismatch (attacker instead of grantor)
      try {
        await agreementAsAttacker.submitInput(
          grantSimple,
          "grantorData",
          sampleInputs.grantorData
        );
        expect.fail("Expected SenderAddressMismatch but transaction succeeded");
      } catch (err: any) {
        expect(String(err)).to.include("SenderAddressMismatch");
      }

      const state = await agreementForState.getCurrentState(grantSimple);
      expect(state).to.equal("AWAITING_TEMPLATE_VARIABLES");
    });

    it("rejects recipientSigning from wrong address", async () => {
      const [grantor, recipient, wrongSigner] = await ethers.getSigners();

      // Deploy protocol and create SDK factory
      const { factory: deployedFactory } = await deployProtocol();
      const factoryAddress = await deployedFactory.getAddress();
      const { publicClient: grantorPublic, walletClient: grantorWallet } =
        await createViemClientsForSigner(grantor);
      const { publicClient: wrongPublic, walletClient: wrongWallet } =
        await createViemClientsForSigner(wrongSigner);
      const factory = new AgreementFactoryClass(
        { factoryAddress: factoryAddress as `0x${string}` },
        { walletClient: grantorWallet, publicClient: grantorPublic }
      );
      
      // Create agreement using SDK
      const { address: agreementAddress } = await factory.createAgreement(grantSimple, {
        initValues: {
          grantorEthAddress: grantor.address as Address,
          recipientEthAddress: recipient.address as Address,
        }
      });

      const engine = await ethers.getContractAt("AgreementEngine", agreementAddress);
      const agreementAsGrantor = new AgreementEngineClass(
        agreementAddress,
        grantorPublic,
        grantorWallet
      );
      const agreementAsWrongSigner = new AgreementEngineClass(
        agreementAddress,
        wrongPublic,
        wrongWallet
      );

      await agreementAsGrantor.submitInput(grantSimple, "grantorData", sampleInputs.grantorData);

      // Wrong signer tries to submit recipientSigning
      try {
        await agreementAsWrongSigner.submitInput(
          grantSimple,
          "recipientSigning",
          sampleInputs.recipientSigning
        );
        expect.fail("Expected SenderAddressMismatch but transaction succeeded");
      } catch (err: any) {
        expect(String(err)).to.include("SenderAddressMismatch");
      }

      const state = await agreementAsGrantor.getCurrentState(grantSimple);
      expect(state).to.equal("AWAITING_RECIPIENT_SIGNATURE");
    });

    it("rejects grantorSigning from wrong address", async () => {
      const [grantor, recipient, wrongSigner] = await ethers.getSigners();

      // Deploy protocol and create SDK factory
      const { factory: deployedFactory } = await deployProtocol();
      const factoryAddress = await deployedFactory.getAddress();
      const { publicClient: grantorPublic, walletClient: grantorWallet } =
        await createViemClientsForSigner(grantor);
      const { publicClient: recipientPublic, walletClient: recipientWallet } =
        await createViemClientsForSigner(recipient);
      const { publicClient: wrongPublic, walletClient: wrongWallet } =
        await createViemClientsForSigner(wrongSigner);
      const factory = new AgreementFactoryClass(
        { factoryAddress: factoryAddress as `0x${string}` },
        { walletClient: grantorWallet, publicClient: grantorPublic }
      );
      
      // Create agreement using SDK
      const { address: agreementAddress } = await factory.createAgreement(grantSimple, {
        initValues: {
          grantorEthAddress: grantor.address as Address,
          recipientEthAddress: recipient.address as Address,
        }
      });

      const engine = await ethers.getContractAt("AgreementEngine", agreementAddress);
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
      const agreementAsWrongSigner = new AgreementEngineClass(
        agreementAddress,
        wrongPublic,
        wrongWallet
      );

      await agreementAsGrantor.submitInput(grantSimple, "grantorData", sampleInputs.grantorData);
      await agreementAsRecipient.submitInput(grantSimple, "recipientSigning", sampleInputs.recipientSigning);

      try {
        await agreementAsWrongSigner.submitInput(
          grantSimple,
          "grantorSigning",
          sampleInputs.grantorSigning
        );
        expect.fail("Expected SenderAddressMismatch but transaction succeeded");
      } catch (err: any) {
        expect(String(err)).to.include("SenderAddressMismatch");
      }

      const state = await agreementAsRecipient.getCurrentState(grantSimple);
      expect(state).to.equal("AWAITING_GRANTOR_SIGNATURE");
    });

    it("rejects grantorRejection from non-grantor", async () => {
      const [grantor, recipient] = await ethers.getSigners();

      // Deploy protocol and create SDK factory
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
      
      // Create agreement using SDK
      const { address: agreementAddress } = await factory.createAgreement(grantSimple, {
        initValues: {
          grantorEthAddress: grantor.address as Address,
          recipientEthAddress: recipient.address as Address,
        }
      });

      const engine = await ethers.getContractAt("AgreementEngine", agreementAddress);
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
      await agreementAsRecipient.submitInput(grantSimple, "recipientSigning", sampleInputs.recipientSigning);

      try {
        await agreementAsRecipient.submitInput(
          grantSimple,
          "grantorRejection",
          sampleInputs.grantorRejection
        );
        expect.fail("Expected SenderAddressMismatch but transaction succeeded");
      } catch (err: any) {
        expect(String(err)).to.include("SenderAddressMismatch");
      }
    });

    it("rejects payment from non-grantor", async () => {
      const [grantor, recipient] = await ethers.getSigners();

      // Deploy protocol and create SDK factory
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
      
      // Create agreement using SDK
      const { address: agreementAddress } = await factory.createAgreement(grantSimple, {
        initValues: {
          grantorEthAddress: grantor.address as Address,
          recipientEthAddress: recipient.address as Address,
        }
      });

      const engine = await ethers.getContractAt("AgreementEngine", agreementAddress);
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
      await agreementAsRecipient.submitInput(grantSimple, "recipientSigning", sampleInputs.recipientSigning);
      await agreementAsGrantor.submitInput(grantSimple, "grantorSigning", sampleInputs.grantorSigning);

      try {
        await agreementAsRecipient.submitInput(
          grantSimple,
          "workTokenSentTx",
          sampleInputs.workTokenSentTx
        );
        expect.fail("Expected SenderAddressMismatch but transaction succeeded");
      } catch (err: any) {
        expect(String(err)).to.include("SenderAddressMismatch");
      }

      const state = await agreementAsGrantor.getCurrentState(grantSimple);
      expect(state).to.equal("AWAITING_PAYMENT");
    });
  });

  describe("Transformer Validation", () => {
    it("throws error when initValues not provided for agreement with init addresses", async () => {
      const [grantor] = await ethers.getSigners();
      const { factory: deployedFactory } = await deployProtocol();
      const factoryAddress = await deployedFactory.getAddress();
      const factory = new AgreementFactoryClass(
        { factoryAddress: factoryAddress as `0x${string}` },
        grantor
      );

      try {
        await factory.createAgreement(grantSimple);
        expect.fail("Expected error to be thrown");
      } catch (err: any) {
        expect(err.message).to.match(/requires initialization values/);
      }
    });

    it("throws error when specific init value is missing", async () => {
      const [grantor] = await ethers.getSigners();
      const { factory: deployedFactory } = await deployProtocol();
      const factoryAddress = await deployedFactory.getAddress();
      const factory = new AgreementFactoryClass(
        { factoryAddress: factoryAddress as `0x${string}` },
        grantor
      );

      const mockGrantorAddress = "0x1111111111111111111111111111111111111111" as Address;

      try {
        await factory.createAgreement(grantSimple, {
          initValues: {
            grantorEthAddress: mockGrantorAddress,
          }
        });
        expect.fail("Expected error to be thrown");
      } catch (err: any) {
        expect(err.message).to.match(/Missing initialization value for 'recipientEthAddress'/);
      }
    });
  });
});

