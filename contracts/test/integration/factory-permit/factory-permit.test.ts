/**
 * Factory create-permit round-trip: the real SDK signer against the real factory contract.
 *
 * The rewritten composable permit-create paths (`createAgreementWithPermit`, the
 * `PERMIT_AGREEMENT_TYPEHASH`, and the `bytes.concat`-of-`abi.encode`s struct-hash
 * reconstruction in `_verifyPermit` / `_hashInitArrays`) are exercised end-to-end here:
 *
 *   1. The SDK's `AgreementFactory.createPermitSignature` signs an EIP-712 permit over the
 *      composable agreement shape (doc/state + per-array hashes), using a viem WalletClient
 *      backed by the Hardhat node.
 *   2. `createAgreementWithPermit` submits it on-chain; we assert `owner == signer` and that
 *      the signer's factory nonce was consumed.
 *   3. TAMPER cases: submitting different `canonicalConds_` / `inputDefs_` / `actions_` than
 *      were signed reverts `InvalidSignature` — proof every array is genuinely bound and the
 *      SDK typed-data field order matches the contract typehash.
 */

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

// An agreement whose composable shape has non-empty inputDefs, canonicalConds, AND actions, so
// every bound array can be meaningfully tampered.
const AGREEMENT_NAME = "grant-with-feedback-auto-pay-actions";

const INIT_VALUES = {
  grantorEthAddress: "0x1111111111111111111111111111111111111111" as Address,
  recipientEthAddress: "0x2222222222222222222222222222222222222222" as Address,
  workTokenAddress: "0x3333333333333333333333333333333333333333" as Address,
  paymentAmount: "1000",
};

let agreementJson: AgreementJson;
let AgreementFactoryClass: any;
let sdkModule: any;

describe("AgreementFactory (integration) - create-permit round-trip via the real SDK signer", () => {
  before(async () => {
    agreementJson = loadAgreement(AGREEMENT_NAME);
    sdkModule = await loadSDKModule();
    AgreementFactoryClass = sdkModule.AgreementFactory;
  });

  /** Build the composable on-chain params exactly as the SDK does for the permit. */
  function buildParams() {
    const onchain = sdkModule.transformAgreementToOnChainParams(
      agreementJson,
      undefined,
      INIT_VALUES
    );
    return sdkModule.desugarToComposable(onchain);
  }

  it("signs with the SDK, creates via permit, and consumes the signer nonce", async () => {
    const [submitter, signer] = await ethers.getSigners();
    const { factory: deployedFactory } = await deployProtocol();
    const factoryAddress = (await deployedFactory.getAddress()) as `0x${string}`;

    // The signer authorizes; the submitter relays. Two distinct accounts prove the permit
    // grant (owner = signer, not the relaying msg.sender).
    const { publicClient: signerPublic, walletClient: signerWallet } =
      await createViemClientsForSigner(signer);
    const { publicClient: submitterPublic, walletClient: submitterWallet } =
      await createViemClientsForSigner(submitter);

    const signerFactory = new AgreementFactoryClass(
      { factoryAddress },
      { walletClient: signerWallet, publicClient: signerPublic }
    );

    const nonceBefore = await deployedFactory.nonces(signer.address);

    const deadline = Math.floor(Date.now() / 1000) + 3600;
    const { signature, signerAddress } = await signerFactory.createPermitSignature(
      signerWallet,
      agreementJson,
      deadline,
      { initValues: INIT_VALUES }
    );
    expect(signerAddress.toLowerCase()).to.equal(signer.address.toLowerCase());

    // The submitter relays the permit-create.
    const submitterFactory = new AgreementFactoryClass(
      { factoryAddress },
      { walletClient: submitterWallet, publicClient: submitterPublic }
    );
    const { address: agreementAddress } = await submitterFactory.createAgreementWithPermit(
      signer.address as `0x${string}`,
      agreementJson,
      deadline,
      signature,
      { initValues: INIT_VALUES }
    );

    // owner is the SIGNER (the authorizing identity), not the relaying submitter.
    const engine = await ethers.getContractAt("AgreementEngine", agreementAddress);
    expect(await engine.owner()).to.equal(signer.address);
    expect(signer.address).to.not.equal(submitter.address);

    // The signer's factory nonce was consumed (replay protection).
    expect(await deployedFactory.nonces(signer.address)).to.equal(nonceBefore + 1n);
  });

  describe("tamper: a bound array different from what was signed reverts InvalidSignature", () => {
    // Sign a permit once, then call the raw factory with the ORIGINAL signature but a mutated
    // array. Each case proves that array is part of the struct hash (genuinely bound).
    let factoryContract: any;
    let signerAddr: string;
    let signature: { v: number; r: string; s: string };
    let deadline: number;
    let params: any;

    before(async () => {
      const [, signer] = await ethers.getSigners();
      const { factory } = await deployProtocol();
      factoryContract = factory;
      signerAddr = signer.address;

      const { publicClient, walletClient } = await createViemClientsForSigner(signer);
      const sdkFactory = new AgreementFactoryClass(
        { factoryAddress: (await factory.getAddress()) as `0x${string}` },
        { walletClient, publicClient }
      );

      deadline = Math.floor(Date.now() / 1000) + 3600;
      const res = await sdkFactory.createPermitSignature(
        walletClient,
        agreementJson,
        deadline,
        { initValues: INIT_VALUES }
      );
      signature = res.signature;
      params = buildParams();
    });

    /** Submit createAgreementWithPermit with the given (possibly mutated) arrays. */
    function submitWith(overrides: Partial<Record<string, unknown>>) {
      const p = { ...params, ...overrides };
      return factoryContract.createAgreementWithPermit(
        signerAddr,
        p.docUri,
        p.docHash,
        p.initialState,
        p.inputDefs,
        p.transitions,
        p.initVars,
        p.actions,
        p.canonicalConds,
        p.verifiers,
        BigInt(deadline),
        signature.v,
        signature.r,
        signature.s
      );
    }

    it("the untouched arrays succeed (sanity: the signature is otherwise valid)", async () => {
      await expect(submitWith({})).to.not.be.reverted;
    });

    it("tampering canonicalConds_ reverts InvalidSignature", async () => {
      expect(params.canonicalConds.length).to.be.greaterThan(0);
      // Flip the inputId of the first canonical-condition entry.
      const tampered = params.canonicalConds.map((c: any, i: number) =>
        i === 0 ? { ...c, inputId: "0x" + "ab".repeat(32) } : c
      );
      await expect(submitWith({ canonicalConds: tampered })).to.be.revertedWithCustomError(
        factoryContract,
        "InvalidSignature"
      );
    });

    it("tampering inputDefs_ reverts InvalidSignature", async () => {
      expect(params.inputDefs.length).to.be.greaterThan(0);
      // Flip a persist flag on the first field of the first input def.
      const tampered = params.inputDefs.map((d: any, i: number) =>
        i === 0
          ? {
              ...d,
              fields: d.fields.map((f: any, j: number) =>
                j === 0 ? { ...f, persist: !f.persist } : f
              ),
            }
          : d
      );
      await expect(submitWith({ inputDefs: tampered })).to.be.revertedWithCustomError(
        factoryContract,
        "InvalidSignature"
      );
    });

    it("tampering actions_ reverts InvalidSignature", async () => {
      expect(params.actions.length).to.be.greaterThan(0);
      // Flip the fromState of the first action.
      const tampered = params.actions.map((a: any, i: number) =>
        i === 0 ? { ...a, fromState: "0x" + "cd".repeat(32) } : a
      );
      await expect(submitWith({ actions: tampered })).to.be.revertedWithCustomError(
        factoryContract,
        "InvalidSignature"
      );
    });
  });
});
