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

let mou: AgreementJson;
let sampleInputs: Record<string, Record<string, unknown>>;
let AgreementFactoryClass: any;
let AgreementEngineClass: any;

describe("AgreementEngine (integration) - MOU FSM", () => {
  before(async () => {
    mou = loadAgreement("mou");
    sampleInputs = loadSampleInputs("mou");
    
    const sdkModule = await loadSDKModule();
    AgreementFactoryClass = sdkModule.AgreementFactory;
    AgreementEngineClass = sdkModule.AgreementEngine;
  });

  describe("Happy Path", () => {
    it("drives through all states: partyA signs -> partyB signs -> accepted", async () => {
      const [partyA, partyB] = await ethers.getSigners();
      const { factory: deployedFactory } = await deployProtocol();
      const factoryAddress = await deployedFactory.getAddress();
      const { publicClient: partyAPublic, walletClient: partyAWallet } =
        await createViemClientsForSigner(partyA);
      const { publicClient: partyBPublic, walletClient: partyBWallet } =
        await createViemClientsForSigner(partyB);
      const factory = new AgreementFactoryClass(
        { factoryAddress: factoryAddress as `0x${string}` },
        { walletClient: partyAWallet, publicClient: partyAPublic }
      );

      const { address: agreementAddress } = await factory.createAgreement(mou, {
        initValues: {
          partyAEthAddress: partyA.address as Address,
          partyBEthAddress: partyB.address as Address,
        }
      });

      const agreement = new AgreementEngineClass(
        agreementAddress,
        partyAPublic,
        partyAWallet
      );
      const agreementAsPartyB = new AgreementEngineClass(
        agreementAddress,
        partyBPublic,
        partyBWallet
      );

      await agreement.submitInput(mou, "partyAData", sampleInputs.partyAData);
      expect(await agreement.getCurrentState(mou)).to.equal("PENDING_PARTY_B_SIGNATURE");

      await agreementAsPartyB.submitInput(mou, "partyBData", sampleInputs.partyBData);
      expect(await agreement.getCurrentState(mou)).to.equal("PENDING_ACCEPTANCE");

      await agreement.submitInput(mou, "accepted", sampleInputs.accepted);
      expect(await agreement.getCurrentState(mou)).to.equal("ACCEPTED");
    });
  });

  describe("Rejection Path", () => {
    it("allows partyA to reject after partyB signs", async () => {
      const [partyA, partyB] = await ethers.getSigners();
      const { factory: deployedFactory } = await deployProtocol();
      const factoryAddress = await deployedFactory.getAddress();
      const { publicClient: partyAPublic, walletClient: partyAWallet } =
        await createViemClientsForSigner(partyA);
      const { publicClient: partyBPublic, walletClient: partyBWallet } =
        await createViemClientsForSigner(partyB);
      const factory = new AgreementFactoryClass(
        { factoryAddress: factoryAddress as `0x${string}` },
        { walletClient: partyAWallet, publicClient: partyAPublic }
      );

      const { address: agreementAddress } = await factory.createAgreement(mou, {
        initValues: {
          partyAEthAddress: partyA.address as Address,
          partyBEthAddress: partyB.address as Address,
        }
      });

      const agreement = new AgreementEngineClass(
        agreementAddress,
        partyAPublic,
        partyAWallet
      );
      const agreementAsPartyB = new AgreementEngineClass(
        agreementAddress,
        partyBPublic,
        partyBWallet
      );

      await agreement.submitInput(mou, "partyAData", sampleInputs.partyAData);
      await agreementAsPartyB.submitInput(mou, "partyBData", sampleInputs.partyBData);
      await agreement.submitInput(mou, "rejected", sampleInputs.rejected);

      expect(await agreement.getCurrentState(mou)).to.equal("REJECTED");
    });
  });

  describe("Issuer Validation Enforcement", () => {
    it("rejects partyAData from wrong address (partyB instead of partyA)", async () => {
      const [partyA, partyB] = await ethers.getSigners();
      const { factory: deployedFactory } = await deployProtocol();
      const factoryAddress = await deployedFactory.getAddress();
      const { publicClient: partyAPublic, walletClient: partyAWallet } =
        await createViemClientsForSigner(partyA);
      const { publicClient: partyBPublic, walletClient: partyBWallet } =
        await createViemClientsForSigner(partyB);
      const factory = new AgreementFactoryClass(
        { factoryAddress: factoryAddress as `0x${string}` },
        { walletClient: partyAWallet, publicClient: partyAPublic }
      );

      const { address: agreementAddress } = await factory.createAgreement(mou, {
        initValues: {
          partyAEthAddress: partyA.address as Address,
          partyBEthAddress: partyB.address as Address,
        }
      });

      const agreementAsPartyB = new AgreementEngineClass(
        agreementAddress,
        partyBPublic,
        partyBWallet
      );
      const agreement = new AgreementEngineClass(
        agreementAddress,
        partyAPublic,
        partyAWallet
      );

      try {
        await agreementAsPartyB.submitInput(mou, "partyAData", sampleInputs.partyAData);
        expect.fail("Expected transaction to revert with SenderAddressMismatch");
      } catch (error: any) {
        expect(error.message).to.include("SenderAddressMismatch");
      }

      expect(await agreement.getCurrentState(mou)).to.equal("PENDING_PARTY_A_SIGNATURE");
    });

    it("rejects partyBData from wrong address (partyA instead of partyB)", async () => {
      const [partyA, partyB] = await ethers.getSigners();
      const { factory: deployedFactory } = await deployProtocol();
      const factoryAddress = await deployedFactory.getAddress();
      const { publicClient: partyAPublic, walletClient: partyAWallet } =
        await createViemClientsForSigner(partyA);
      const { publicClient: partyBPublic, walletClient: partyBWallet } =
        await createViemClientsForSigner(partyB);
      const factory = new AgreementFactoryClass(
        { factoryAddress: factoryAddress as `0x${string}` },
        { walletClient: partyAWallet, publicClient: partyAPublic }
      );

      const { address: agreementAddress } = await factory.createAgreement(mou, {
        initValues: {
          partyAEthAddress: partyA.address as Address,
          partyBEthAddress: partyB.address as Address,
        }
      });

      const agreement = new AgreementEngineClass(
        agreementAddress,
        partyAPublic,
        partyAWallet
      );
      const agreementForState = new AgreementEngineClass(
        agreementAddress,
        partyAPublic,
        partyAWallet
      );

      await agreement.submitInput(mou, "partyAData", sampleInputs.partyAData);

      try {
        await agreement.submitInput(mou, "partyBData", sampleInputs.partyBData);
        expect.fail("Expected transaction to revert with SenderAddressMismatch");
      } catch (error: any) {
        expect(error.message).to.include("SenderAddressMismatch");
      }

      expect(await agreementForState.getCurrentState(mou)).to.equal("PENDING_PARTY_B_SIGNATURE");
    });

    it("rejects acceptance from wrong address (partyB instead of partyA)", async () => {
      const [partyA, partyB] = await ethers.getSigners();
      const { factory: deployedFactory } = await deployProtocol();
      const factoryAddress = await deployedFactory.getAddress();
      const { publicClient: partyAPublic, walletClient: partyAWallet } =
        await createViemClientsForSigner(partyA);
      const { publicClient: partyBPublic, walletClient: partyBWallet } =
        await createViemClientsForSigner(partyB);
      const factory = new AgreementFactoryClass(
        { factoryAddress: factoryAddress as `0x${string}` },
        { walletClient: partyAWallet, publicClient: partyAPublic }
      );

      const { address: agreementAddress } = await factory.createAgreement(mou, {
        initValues: {
          partyAEthAddress: partyA.address as Address,
          partyBEthAddress: partyB.address as Address,
        }
      });

      const agreement = new AgreementEngineClass(
        agreementAddress,
        partyAPublic,
        partyAWallet
      );
      const agreementAsPartyB = new AgreementEngineClass(
        agreementAddress,
        partyBPublic,
        partyBWallet
      );
      const agreementForState = new AgreementEngineClass(
        agreementAddress,
        partyAPublic,
        partyAWallet
      );

      await agreement.submitInput(mou, "partyAData", sampleInputs.partyAData);
      await agreementAsPartyB.submitInput(mou, "partyBData", sampleInputs.partyBData);

      try {
        await agreementAsPartyB.submitInput(mou, "accepted", sampleInputs.accepted);
        expect.fail("Expected transaction to revert with SenderAddressMismatch");
      } catch (error: any) {
        expect(error.message).to.include("SenderAddressMismatch");
      }

      expect(await agreementForState.getCurrentState(mou)).to.equal("PENDING_ACCEPTANCE");
    });

    it("rejects rejection from wrong address (partyB instead of partyA)", async () => {
      const [partyA, partyB] = await ethers.getSigners();
      const { factory: deployedFactory } = await deployProtocol();
      const factoryAddress = await deployedFactory.getAddress();
      const { publicClient: partyAPublic, walletClient: partyAWallet } =
        await createViemClientsForSigner(partyA);
      const { publicClient: partyBPublic, walletClient: partyBWallet } =
        await createViemClientsForSigner(partyB);
      const factory = new AgreementFactoryClass(
        { factoryAddress: factoryAddress as `0x${string}` },
        { walletClient: partyAWallet, publicClient: partyAPublic }
      );

      const { address: agreementAddress } = await factory.createAgreement(mou, {
        initValues: {
          partyAEthAddress: partyA.address as Address,
          partyBEthAddress: partyB.address as Address,
        }
      });

      const agreement = new AgreementEngineClass(
        agreementAddress,
        partyAPublic,
        partyAWallet
      );
      const agreementAsPartyB = new AgreementEngineClass(
        agreementAddress,
        partyBPublic,
        partyBWallet
      );
      const agreementForState = new AgreementEngineClass(
        agreementAddress,
        partyAPublic,
        partyAWallet
      );

      await agreement.submitInput(mou, "partyAData", sampleInputs.partyAData);
      await agreementAsPartyB.submitInput(mou, "partyBData", sampleInputs.partyBData);

      try {
        await agreementAsPartyB.submitInput(mou, "rejected", sampleInputs.rejected);
        expect.fail("Expected transaction to revert with SenderAddressMismatch");
      } catch (error: any) {
        expect(error.message).to.include("SenderAddressMismatch");
      }

      expect(await agreementForState.getCurrentState(mou)).to.equal("PENDING_ACCEPTANCE");
    });
  });

  describe("Transformer Validation", () => {
    it("throws error when initValues not provided for agreement with init addresses", async () => {
      const [partyA] = await ethers.getSigners();
      const { factory: deployedFactory } = await deployProtocol();
      const factoryAddress = await deployedFactory.getAddress();
      const { publicClient: partyAPublic, walletClient: partyAWallet } =
        await createViemClientsForSigner(partyA);
      const factory = new AgreementFactoryClass(
        { factoryAddress: factoryAddress as `0x${string}` },
        { walletClient: partyAWallet, publicClient: partyAPublic }
      );

      try {
        await factory.createAgreement(mou);
        expect.fail("Expected error to be thrown");
      } catch (err: any) {
        expect(err.message).to.match(/requires initialization values/);
      }
    });

    it("throws error when specific init value is missing", async () => {
      const [partyA] = await ethers.getSigners();
      const { factory: deployedFactory } = await deployProtocol();
      const factoryAddress = await deployedFactory.getAddress();
      const { publicClient: partyAPublic, walletClient: partyAWallet } =
        await createViemClientsForSigner(partyA);
      const factory = new AgreementFactoryClass(
        { factoryAddress: factoryAddress as `0x${string}` },
        { walletClient: partyAWallet, publicClient: partyAPublic }
      );

      const mockPartyAAddress = "0x1111111111111111111111111111111111111111" as Address;

      try {
        await factory.createAgreement(mou, {
          initValues: {
            partyAEthAddress: mockPartyAAddress,
          }
        });
        expect.fail("Expected error to be thrown");
      } catch (err: any) {
        expect(err.message).to.match(/Missing initialization value for 'partyBEthAddress'/);
      }
    });
  });
});
