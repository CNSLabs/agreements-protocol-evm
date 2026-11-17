// SPDX-License-Identifier: Apache-2.0

import { expect } from "chai";
import { ethers } from "hardhat";
import { Address } from "viem";
import {
  loadAgreement,
  deployProtocol,
  loadSDKModule,
  createViemClientsForSigner,
} from "../test-helpers";
import type { AgreementJson } from "../../../../sdk/src/types";

let grantSimple: AgreementJson;
let AgreementFactoryClass: any;
let AgreementEngineClass: any;

describe("AgreementFactory (integration) - creation permits and deterministic addresses", () => {
  before(async () => {
    grantSimple = loadAgreement("grant-simple");

    const sdkModule = await loadSDKModule();
    AgreementFactoryClass = sdkModule.AgreementFactory;
    AgreementEngineClass = sdkModule.AgreementEngine;
  });

  // One SDK factory per account: the grantor signs permits, the relayer submits them.
  async function setup() {
    const [grantor, recipient, relayer, other] = await ethers.getSigners();
    const { factory: deployedFactory } = await deployProtocol();
    const factoryAddress = (await deployedFactory.getAddress()) as `0x${string}`;

    const sdkFactoryFor = async (signer: any) => {
      const { publicClient, walletClient } = await createViemClientsForSigner(signer);
      return {
        publicClient,
        walletClient,
        factory: new AgreementFactoryClass({ factoryAddress }, { walletClient, publicClient }),
      };
    };

    const latestBlock = await ethers.provider.getBlock("latest");
    return {
      grantor,
      recipient,
      relayer,
      other,
      asGrantor: await sdkFactoryFor(grantor),
      asRelayer: await sdkFactoryFor(relayer),
      asOther: await sdkFactoryFor(other),
      deadline: latestBlock!.timestamp + 3600,
      options: {
        initValues: {
          grantorEthAddress: grantor.address as Address,
          recipientEthAddress: recipient.address as Address,
        },
      },
    };
  }

  const saltFor = (label: string) => ethers.id(label) as `0x${string}`;

  async function ownerOf(agreementAddress: string, publicClient: any): Promise<string> {
    return await new AgreementEngineClass(agreementAddress, publicClient).getOwner();
  }

  describe("createAgreementWithPermit", () => {
    it("a relayer creates the agreement the signer permitted, owned by the signer", async () => {
      const { grantor, asGrantor, asRelayer, deadline, options } = await setup();

      const permit = await asGrantor.factory.createPermitSignature(
        asGrantor.walletClient,
        grantSimple,
        deadline,
        options
      );
      expect(permit.signerAddress).to.equal(grantor.address);
      // One opaque 65-byte signature, not split v/r/s components.
      expect(permit.signature).to.match(/^0x[0-9a-f]{130}$/);

      const nonceBefore = await asGrantor.factory.getNonce(permit.signerAddress);
      const { address } = await asRelayer.factory.createAgreementWithPermit(
        permit.signerAddress,
        grantSimple,
        deadline,
        permit.signature,
        options
      );

      expect(await ownerOf(address, asRelayer.publicClient)).to.equal(grantor.address);
      expect(await asGrantor.factory.getNonce(permit.signerAddress)).to.equal(nonceBefore + 1n);
    });

    it("rejects a permit presented for an account that did not sign it", async () => {
      const { other, asGrantor, asRelayer, deadline, options } = await setup();

      const permit = await asGrantor.factory.createPermitSignature(
        asGrantor.walletClient,
        grantSimple,
        deadline,
        options
      );

      try {
        await asRelayer.factory.createAgreementWithPermit(
          other.address as `0x${string}`,
          grantSimple,
          deadline,
          permit.signature,
          options
        );
        expect.fail("Expected transaction to revert with InvalidSignature");
      } catch (error: any) {
        expect(error.message).to.include("InvalidSignature");
      }
    });
  });

  describe("deterministic addresses", () => {
    it("predictAddress is scoped to the creator", async () => {
      const { grantor, other, asGrantor, options } = await setup();
      const salt = saltFor("scoped-to-creator");

      const forGrantor = await asGrantor.factory.predictAddress(grantor.address, salt, grantSimple, options);
      const forOther = await asGrantor.factory.predictAddress(other.address, salt, grantSimple, options);

      expect(forGrantor).to.not.equal(forOther);
    });

    it("predictAddress is bound to the agreement's contents", async () => {
      const { grantor, other, asGrantor, options } = await setup();
      const salt = saltFor("bound-to-contents");

      const agreed = await asGrantor.factory.predictAddress(grantor.address, salt, grantSimple, options);
      const otherRecipient = await asGrantor.factory.predictAddress(grantor.address, salt, grantSimple, {
        initValues: { ...options.initValues, recipientEthAddress: other.address as Address },
      });
      const otherDocument = await asGrantor.factory.predictAddress(grantor.address, salt, grantSimple, {
        ...options,
        docUri: "ipfs://another-document",
      });

      expect(new Set([agreed, otherRecipient, otherDocument]).size).to.equal(3);
    });

    it("createAgreementDeterministic deploys at the caller's predicted address", async () => {
      const { grantor, other, asGrantor, asOther, options } = await setup();
      const salt = saltFor("direct-deterministic");

      const predicted = await asGrantor.factory.predictAddress(grantor.address, salt, grantSimple, options);
      const { address } = await asGrantor.factory.createAgreementDeterministic(
        grantSimple,
        salt,
        options
      );
      expect(address).to.equal(predicted);
      expect(await ownerOf(address, asGrantor.publicClient)).to.equal(grantor.address);

      // Another account using the same salt gets its own address, so it can
      // neither take nor block the grantor's.
      const predictedForOther = await asOther.factory.predictAddress(other.address, salt, grantSimple, options);
      const { address: otherAddress } = await asOther.factory.createAgreementDeterministic(
        grantSimple,
        salt,
        options
      );
      expect(otherAddress).to.equal(predictedForOther);
      expect(otherAddress).to.not.equal(address);

      // The same account and salt with different terms lands at a third address.
      const otherTerms = {
        initValues: { ...options.initValues, recipientEthAddress: other.address as Address },
      };
      const predictedForOtherTerms = await asGrantor.factory.predictAddress(grantor.address, salt, grantSimple, otherTerms);
      const { address: otherTermsAddress } = await asGrantor.factory.createAgreementDeterministic(
        grantSimple,
        salt,
        otherTerms
      );
      expect(otherTermsAddress).to.equal(predictedForOtherTerms);
      expect(otherTermsAddress).to.not.equal(address);
    });
  });

  describe("createAgreementDeterministicWithPermit", () => {
    it("a relayer deploys at the signer's predicted address, owned by the signer", async () => {
      const { grantor, asGrantor, asRelayer, deadline, options } = await setup();
      const salt = saltFor("permit-deterministic");

      const permit = await asGrantor.factory.createDeterministicPermitSignature(
        asGrantor.walletClient,
        grantSimple,
        salt,
        deadline,
        options
      );
      expect(permit.signerAddress).to.equal(grantor.address);
      expect(permit.signature).to.match(/^0x[0-9a-f]{130}$/);

      const predicted = await asRelayer.factory.predictAddress(permit.signerAddress, salt, grantSimple, options);
      const { address } = await asRelayer.factory.createAgreementDeterministicWithPermit(
        permit.signerAddress,
        salt,
        grantSimple,
        deadline,
        permit.signature,
        options
      );

      expect(address).to.equal(predicted);
      expect(await ownerOf(address, asRelayer.publicClient)).to.equal(grantor.address);
    });

    it("rejects a deterministic permit submitted with a different salt", async () => {
      const { asGrantor, asRelayer, deadline, options } = await setup();

      const permit = await asGrantor.factory.createDeterministicPermitSignature(
        asGrantor.walletClient,
        grantSimple,
        saltFor("signed-salt"),
        deadline,
        options
      );

      try {
        await asRelayer.factory.createAgreementDeterministicWithPermit(
          permit.signerAddress,
          saltFor("relayer-salt"),
          grantSimple,
          deadline,
          permit.signature,
          options
        );
        expect.fail("Expected transaction to revert with InvalidSignature");
      } catch (error: any) {
        expect(error.message).to.include("InvalidSignature");
      }
    });

    it("rejects a non-deterministic creation permit on the deterministic path", async () => {
      const { asGrantor, asRelayer, deadline, options } = await setup();

      const permit = await asGrantor.factory.createPermitSignature(
        asGrantor.walletClient,
        grantSimple,
        deadline,
        options
      );

      try {
        await asRelayer.factory.createAgreementDeterministicWithPermit(
          permit.signerAddress,
          saltFor("wrong-permit-type"),
          grantSimple,
          deadline,
          permit.signature,
          options
        );
        expect.fail("Expected transaction to revert with InvalidSignature");
      } catch (error: any) {
        expect(error.message).to.include("InvalidSignature");
      }
    });
  });
});
