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

let manifesto: AgreementJson;
let sampleInputs: Record<string, Record<string, unknown>>;
let AgreementFactoryClass: any;
let AgreementEngineClass: any;

describe("AgreementEngine (integration) - Manifesto FSM", () => {
  before(async () => {
    manifesto = loadAgreement("manifesto");
    sampleInputs = loadSampleInputs("manifesto");
    
    const sdkModule = await loadSDKModule();
    AgreementFactoryClass = sdkModule.AgreementFactory;
    AgreementEngineClass = sdkModule.AgreementEngine;
  });

  describe("Signing Flow", () => {
    it("allows multiple users to sign the manifesto", async () => {
      const [controller, signer1, signer2] = await ethers.getSigners();
      const { factory: deployedFactory } = await deployProtocol();
      const factoryAddress = await deployedFactory.getAddress();

      const { publicClient: controllerPublic, walletClient: controllerWallet } =
        await createViemClientsForSigner(controller);
      const { publicClient: signer1Public, walletClient: signer1Wallet } =
        await createViemClientsForSigner(signer1);
      const { publicClient: signer2Public, walletClient: signer2Wallet } =
        await createViemClientsForSigner(signer2);

      const factory = new AgreementFactoryClass(
        { factoryAddress: factoryAddress as `0x${string}` },
        { walletClient: controllerWallet, publicClient: controllerPublic }
      );

      const { address: agreementAddress } = await factory.createAgreement(manifesto, {
        initValues: {
          controller: controller.address as Address,
        }
      });

      const agreement = new AgreementEngineClass(
        agreementAddress,
        controllerPublic,
        controllerWallet
      );
      const agreementAsSigner1 = new AgreementEngineClass(
        agreementAddress,
        signer1Public,
        signer1Wallet
      );
      const agreementAsSigner2 = new AgreementEngineClass(
        agreementAddress,
        signer2Public,
        signer2Wallet
      );

      expect(await agreement.getCurrentState(manifesto)).to.equal("ACTIVE");

      await agreementAsSigner1.submitInput(manifesto, "signManifesto", {
        signerName: "Alice Johnson",
        signerAddress: signer1.address,
      });
      expect(await agreement.getCurrentState(manifesto)).to.equal("ACTIVE");

      await agreementAsSigner2.submitInput(manifesto, "signManifesto", {
        signerName: "Bob Smith",
        signerAddress: signer2.address,
      });
      expect(await agreement.getCurrentState(manifesto)).to.equal("ACTIVE");
    });

    it("allows controller to sign as well", async () => {
      const [controller] = await ethers.getSigners();
      const { factory: deployedFactory } = await deployProtocol();
      const factoryAddress = await deployedFactory.getAddress();
      const { publicClient: controllerPublic, walletClient: controllerWallet } =
        await createViemClientsForSigner(controller);
      const factory = new AgreementFactoryClass(
        { factoryAddress: factoryAddress as `0x${string}` },
        { walletClient: controllerWallet, publicClient: controllerPublic }
      );

      const { address: agreementAddress } = await factory.createAgreement(manifesto, {
        initValues: {
          controller: controller.address as Address,
        }
      });

      const agreement = new AgreementEngineClass(
        agreementAddress,
        controllerPublic,
        controllerWallet
      );

      await agreement.submitInput(manifesto, "signManifesto", {
        signerName: "Controller Name",
        signerAddress: controller.address,
      });
      expect(await agreement.getCurrentState(manifesto)).to.equal("ACTIVE");
    });
  });

  describe("Activation/Deactivation Flow", () => {
    it("allows controller to deactivate and reactivate", async () => {
      const [controller] = await ethers.getSigners();
      const { factory: deployedFactory } = await deployProtocol();
      const factoryAddress = await deployedFactory.getAddress();

      const { publicClient: controllerPublic, walletClient: controllerWallet } =
        await createViemClientsForSigner(controller);
      const factory = new AgreementFactoryClass(
        { factoryAddress: factoryAddress as `0x${string}` },
        { walletClient: controllerWallet, publicClient: controllerPublic }
      );

      const { address: agreementAddress } = await factory.createAgreement(manifesto, {
        initValues: {
          controller: controller.address as Address,
        }
      });

      const agreement = new AgreementEngineClass(
        agreementAddress,
        controllerPublic,
        controllerWallet
      );

      expect(await agreement.getCurrentState(manifesto)).to.equal("ACTIVE");

      await agreement.submitInput(manifesto, "deactivate", sampleInputs.deactivate);
      expect(await agreement.getCurrentState(manifesto)).to.equal("INACTIVE");

      await agreement.submitInput(manifesto, "activate", sampleInputs.activate);
      expect(await agreement.getCurrentState(manifesto)).to.equal("ACTIVE");
    });

    it("prevents signing when inactive", async () => {
      const [controller, signer] = await ethers.getSigners();
      const { factory: deployedFactory } = await deployProtocol();
      const factoryAddress = await deployedFactory.getAddress();
      const { publicClient: controllerPublic, walletClient: controllerWallet } =
        await createViemClientsForSigner(controller);
      const { publicClient: signerPublic, walletClient: signerWallet } =
        await createViemClientsForSigner(signer);
      const factory = new AgreementFactoryClass(
        { factoryAddress: factoryAddress as `0x${string}` },
        { walletClient: controllerWallet, publicClient: controllerPublic }
      );

      const { address: agreementAddress } = await factory.createAgreement(manifesto, {
        initValues: {
          controller: controller.address as Address,
        }
      });

      const agreement = new AgreementEngineClass(
        agreementAddress,
        controllerPublic,
        controllerWallet
      );
      const agreementAsSigner = new AgreementEngineClass(
        agreementAddress,
        signerPublic,
        signerWallet
      );

      await agreement.submitInput(manifesto, "deactivate", sampleInputs.deactivate);

      try {
        await agreementAsSigner.submitInput(manifesto, "signManifesto", {
          signerName: "Wannabe Signer",
          signerAddress: signer.address,
        });
        expect.fail("Expected transaction to revert with 'No valid transition'");
      } catch (error: any) {
        expect(error.message).to.include("No valid transition");
      }

      expect(await agreement.getCurrentState(manifesto)).to.equal("INACTIVE");
    });
  });

  describe("Issuer Validation Enforcement", () => {
    it("rejects deactivate from non-controller", async () => {
      const [controller, attacker] = await ethers.getSigners();
      const { factory: deployedFactory } = await deployProtocol();
      const factoryAddress = await deployedFactory.getAddress();
      const { publicClient: controllerPublic, walletClient: controllerWallet } =
        await createViemClientsForSigner(controller);
      const { publicClient: attackerPublic, walletClient: attackerWallet } =
        await createViemClientsForSigner(attacker);
      const factory = new AgreementFactoryClass(
        { factoryAddress: factoryAddress as `0x${string}` },
        { walletClient: controllerWallet, publicClient: controllerPublic }
      );

      const { address: agreementAddress } = await factory.createAgreement(manifesto, {
        initValues: {
          controller: controller.address as Address,
        }
      });

      const agreementAsAttacker = new AgreementEngineClass(
        agreementAddress,
        attackerPublic,
        attackerWallet
      );
      const agreement = new AgreementEngineClass(
        agreementAddress,
        controllerPublic,
        controllerWallet
      );

      try {
        await agreementAsAttacker.submitInput(manifesto, "deactivate", sampleInputs.deactivate);
        expect.fail("Expected transaction to revert with SenderAddressMismatch");
      } catch (error: any) {
        expect(error.message).to.include("SenderAddressMismatch");
      }

      expect(await agreement.getCurrentState(manifesto)).to.equal("ACTIVE");
    });

    it("rejects activate from non-controller", async () => {
      const [controller, attacker] = await ethers.getSigners();
      const { factory: deployedFactory } = await deployProtocol();
      const factoryAddress = await deployedFactory.getAddress();
      const { publicClient: controllerPublic, walletClient: controllerWallet } =
        await createViemClientsForSigner(controller);
      const { publicClient: attackerPublic, walletClient: attackerWallet } =
        await createViemClientsForSigner(attacker);
      const factory = new AgreementFactoryClass(
        { factoryAddress: factoryAddress as `0x${string}` },
        { walletClient: controllerWallet, publicClient: controllerPublic }
      );

      const { address: agreementAddress } = await factory.createAgreement(manifesto, {
        initValues: {
          controller: controller.address as Address,
        }
      });

      const agreement = new AgreementEngineClass(
        agreementAddress,
        controllerPublic,
        controllerWallet
      );
      const agreementAsAttacker = new AgreementEngineClass(
        agreementAddress,
        attackerPublic,
        attackerWallet
      );

      await agreement.submitInput(manifesto, "deactivate", sampleInputs.deactivate);

      try {
        await agreementAsAttacker.submitInput(manifesto, "activate", sampleInputs.activate);
        expect.fail("Expected transaction to revert with SenderAddressMismatch");
      } catch (error: any) {
        expect(error.message).to.include("SenderAddressMismatch");
      }

      expect(await agreement.getCurrentState(manifesto)).to.equal("INACTIVE");
    });

    it("allows anyone to sign (no issuer restriction on signManifesto)", async () => {
      const [controller, randomSigner1, randomSigner2, randomSigner3] = await ethers.getSigners();
      const { factory: deployedFactory } = await deployProtocol();
      const factoryAddress = await deployedFactory.getAddress();
      const { publicClient: controllerPublic, walletClient: controllerWallet } =
        await createViemClientsForSigner(controller);
      const { publicClient: signer1Public, walletClient: signer1Wallet } =
        await createViemClientsForSigner(randomSigner1);
      const { publicClient: signer2Public, walletClient: signer2Wallet } =
        await createViemClientsForSigner(randomSigner2);
      const { publicClient: signer3Public, walletClient: signer3Wallet } =
        await createViemClientsForSigner(randomSigner3);
      const factory = new AgreementFactoryClass(
        { factoryAddress: factoryAddress as `0x${string}` },
        { walletClient: controllerWallet, publicClient: controllerPublic }
      );

      const { address: agreementAddress } = await factory.createAgreement(manifesto, {
        initValues: {
          controller: controller.address as Address,
        }
      });

      const agreement = new AgreementEngineClass(
        agreementAddress,
        controllerPublic,
        controllerWallet
      );
      const agreementAsSigner1 = new AgreementEngineClass(
        agreementAddress,
        signer1Public,
        signer1Wallet
      );
      const agreementAsSigner2 = new AgreementEngineClass(
        agreementAddress,
        signer2Public,
        signer2Wallet
      );
      const agreementAsSigner3 = new AgreementEngineClass(
        agreementAddress,
        signer3Public,
        signer3Wallet
      );

      await agreementAsSigner1.submitInput(manifesto, "signManifesto", {
        signerName: "Random 1",
        signerAddress: randomSigner1.address,
      });

      await agreementAsSigner2.submitInput(manifesto, "signManifesto", {
        signerName: "Random 2",
        signerAddress: randomSigner2.address,
      });

      await agreementAsSigner3.submitInput(manifesto, "signManifesto", {
        signerName: "Random 3",
        signerAddress: randomSigner3.address,
      });

      expect(await agreement.getCurrentState(manifesto)).to.equal("ACTIVE");
    });
  });

  describe("Transformer Validation", () => {
    it("throws error when initValues not provided for agreement with init addresses", async () => {
      const [controller] = await ethers.getSigners();
      const { factory: deployedFactory } = await deployProtocol();
      const factoryAddress = await deployedFactory.getAddress();
      const { publicClient: controllerPublic, walletClient: controllerWallet } =
        await createViemClientsForSigner(controller);
      const factory = new AgreementFactoryClass(
        { factoryAddress: factoryAddress as `0x${string}` },
        { walletClient: controllerWallet, publicClient: controllerPublic }
      );

      try {
        await factory.createAgreement(manifesto);
        expect.fail("Expected error to be thrown");
      } catch (err: any) {
        expect(err.message).to.match(/requires initialization values/);
      }
    });
  });
});
