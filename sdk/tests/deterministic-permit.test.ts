// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, jest } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import type { Hex } from "viem";
import { AgreementFactory } from "../src/AgreementFactory";
import {
  compileAgreementPackage,
  type AgreementPackage,
} from "../src/package-compiler";

const fixturePath = path.resolve(
  __dirname,
  "fixtures/canonical-package-v0-reference-package.json",
);
const referencePackage = JSON.parse(
  fs.readFileSync(fixturePath, "utf8"),
) as AgreementPackage;

describe("deterministic agreement permits", () => {
  it("binds strict compiler output to its digest, salt, chain, factory, and predicted clone", async () => {
    const factoryAddress = "0x1111111111111111111111111111111111111111" as Hex;
    const signerAddress = "0x2222222222222222222222222222222222222222" as Hex;
    const predictedAgreement = "0x3333333333333333333333333333333333333333" as Hex;
    const salt = `0x${"44".repeat(32)}` as Hex;
    const signatureHex = `0x${"55".repeat(32)}${"66".repeat(32)}1b` as Hex;
    const readContract = jest.fn(async ({ functionName }: { functionName: string }) => {
      if (functionName === "nonces") return 7n;
      if (functionName === "predictAddress") return predictedAgreement;
      throw new Error(`Unexpected read: ${functionName}`);
    });
    const publicClient = {
      getChainId: jest.fn(async () => 59141),
      readContract,
    } as any;
    const walletClient = {
      account: { address: signerAddress },
      signTypedData: jest.fn(async () => signatureHex),
    } as any;
    const factory = new AgreementFactory(
      { factoryAddress, chainId: 59141 },
      { publicClient, walletClient },
    );
    const compiled = compileAgreementPackage(referencePackage);
    const deadline = 2_000_000_000;

    const result = await factory.createCompiledPackageDeterministicPermitSignature(
      walletClient,
      compiled,
      salt,
      deadline,
    );

    expect(result.signerAddress).toBe(signerAddress);
    expect(result.signature).toBe(signatureHex);
    expect(result.typedData.domain).toEqual({
      name: "AgreementFactory",
      version: "1",
      chainId: 59141,
      verifyingContract: factoryAddress,
    });
    expect(result.typedData.message).toMatchObject({
      docHash: compiled.manifest.packageDigest,
      salt,
      predictedAgreement,
      nonce: 7n,
      deadline: BigInt(deadline),
    });
    expect(
      result.typedData.types.PermitDeterministicAgreementWithActions.map(
        ({ name }) => name,
      ),
    ).toEqual([
      "docUri",
      "docHash",
      "initialState",
      "inputDefsHash",
      "transitionsHash",
      "initVarsHash",
      "verifiersHash",
      "actionsHash",
      "salt",
      "predictedAgreement",
      "nonce",
      "deadline",
    ]);
    expect(walletClient.signTypedData).toHaveBeenCalledWith(
      expect.objectContaining({
        account: walletClient.account,
        primaryType: "PermitDeterministicAgreementWithActions",
      }),
    );
  });

  it("rejects mutated compiler output before asking the wallet to sign", async () => {
    const walletClient = {
      account: { address: "0x2222222222222222222222222222222222222222" },
      signTypedData: jest.fn(),
    } as any;
    const factory = new AgreementFactory(
      { factoryAddress: "0x1111111111111111111111111111111111111111" },
      { publicClient: {} as any, walletClient },
    );
    const compiled = compileAgreementPackage(referencePackage);
    const mutated = {
      ...compiled,
      params: {
        ...compiled.params,
        docHash: `0x${"00".repeat(32)}` as Hex,
      },
    };

    await expect(
      factory.createCompiledPackageDeterministicPermitSignature(
        walletClient,
        mutated,
        `0x${"44".repeat(32)}` as Hex,
        2_000_000_000,
      ),
    ).rejects.toThrow(
      "Compiled package docHash must equal the canonical package digest",
    );
    expect(walletClient.signTypedData).not.toHaveBeenCalled();
  });
});
