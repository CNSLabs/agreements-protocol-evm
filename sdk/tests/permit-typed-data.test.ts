// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";

import { AgreementEngine } from "../src/AgreementEngine.js";
import { AgreementFactory } from "../src/AgreementFactory.js";
import type { AgreementJson } from "../src/types.js";

const SIGNER = "0x3333333333333333333333333333333333333333" as const;
const AGREEMENT = "0x4444444444444444444444444444444444444444" as const;
const FACTORY = "0x1111111111111111111111111111111111111111" as const;
const PREDICTED = "0x6666666666666666666666666666666666666666" as const;
const SALT = `0x${"ab".repeat(32)}` as const;
const SIGNATURE = `0x${"11".repeat(32)}${"22".repeat(32)}1b` as const;
const CHAIN_ID = 59141;
const DEADLINE = 2_000_000_000;

const INIT_VALUES = {
  grantorEthAddress: "0x9999999999999999999999999999999999999999",
  recipientEthAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
};

/** The EIP-712 type string a `types` entry encodes to. */
function typeString(types: Record<string, readonly { name: string; type: string }[]>): string {
  const [[primaryType, fields]] = Object.entries(types);
  return `${primaryType}(${fields.map((f) => `${f.type} ${f.name}`).join(",")})`;
}

function contractSource(name: string): string {
  return fs.readFileSync(
    path.resolve(__dirname, `../../contracts/src/${name}.sol`),
    "utf-8",
  );
}

function mockClients(reads: Record<string, unknown>) {
  const readContract = jest.fn(async ({ functionName }: { functionName: string }) => {
    if (!(functionName in reads)) {
      throw new Error(`unexpected read: ${functionName}`);
    }
    return reads[functionName];
  });
  const publicClient = {
    chain: { id: CHAIN_ID },
    getChainId: jest.fn(async () => CHAIN_ID),
    readContract,
  } as any;
  const walletClient = {
    account: { address: SIGNER },
    signTypedData: jest.fn(async () => SIGNATURE),
  } as any;
  return { publicClient, walletClient, readContract };
}

describe("permit typed data", () => {
  let grantSimpleJson: AgreementJson;

  beforeAll(() => {
    grantSimpleJson = JSON.parse(
      fs.readFileSync(
        path.resolve(__dirname, "../../agreements/grant-simple/unwrapped/grant-simple.json"),
        "utf-8",
      ),
    );
  });

  it("an input permit names its signer and carries the signer's nonce, not a state", async () => {
    // Only the signer's nonce is read: a read of the state would throw here.
    const { publicClient, walletClient } = mockClients({ nonces: 7n });
    const engine = new AgreementEngine(AGREEMENT, publicClient);

    const permit = await engine.createPermitSignature(
      walletClient,
      grantSimpleJson,
      "grantorData",
      {
        grantorName: "Alice",
        scope: "Scope",
        termDuration: "12 months",
        effectiveDate: "2026-01-01",
      },
      DEADLINE,
    );

    expect(permit).toEqual({ signature: SIGNATURE, signerAddress: SIGNER });

    const typedData = walletClient.signTypedData.mock.calls[0][0];
    const signedType = typeString(typedData.types);
    expect(signedType).toBe(
      "PermitInput(address signer,bytes32 inputId,bytes payload,uint256 nonce,uint256 deadline)",
    );
    expect(contractSource("AgreementEngine")).toContain(`"${signedType}"`);
    expect(typedData.primaryType).toBe("PermitInput");
    expect(typedData.domain).toEqual({
      name: "AgreementEngine",
      version: "1",
      chainId: CHAIN_ID,
      verifyingContract: AGREEMENT,
    });
    expect(typedData.message).toMatchObject({
      signer: SIGNER,
      nonce: 7n,
      deadline: BigInt(DEADLINE),
    });
    expect(Object.keys(typedData.message)).toEqual(
      typedData.types.PermitInput.map((f: { name: string }) => f.name),
    );
  });

  it("a creation permit names its signer", async () => {
    const { publicClient, walletClient } = mockClients({ nonces: 2n });
    const factory = new AgreementFactory(
      { factoryAddress: FACTORY },
      { publicClient, walletClient },
    );

    const permit = await factory.createPermitSignature(walletClient, grantSimpleJson, DEADLINE, {
      initValues: INIT_VALUES,
    });

    expect(permit).toEqual({ signature: SIGNATURE, signerAddress: SIGNER });

    const typedData = walletClient.signTypedData.mock.calls[0][0];
    const signedType = typeString(typedData.types);
    expect(signedType).toBe(
      "PermitAgreementWithActions(address signer,string docUri,bytes32 docHash,bytes32 initialState,bytes32 inputDefsHash,bytes32 transitionsHash,bytes32 initVarsHash,bytes32 verifiersHash,bytes32 actionsHash,uint256 nonce,uint256 deadline)",
    );
    expect(contractSource("AgreementFactory")).toContain(`"${signedType}"`);
    expect(typedData.primaryType).toBe("PermitAgreementWithActions");
    expect(typedData.domain).toEqual({
      name: "AgreementFactory",
      version: "1",
      chainId: CHAIN_ID,
      verifyingContract: FACTORY,
    });
    expect(typedData.message).toMatchObject({
      signer: SIGNER,
      nonce: 2n,
      deadline: BigInt(DEADLINE),
    });
    expect(Object.keys(typedData.message)).toEqual(
      typedData.types.PermitAgreementWithActions.map((f: { name: string }) => f.name),
    );
  });

  it("a deterministic creation permit binds the salt and the signer's predicted address", async () => {
    const { publicClient, walletClient, readContract } = mockClients({
      nonces: 0n,
      predictAddress: PREDICTED,
    });
    const factory = new AgreementFactory(
      { factoryAddress: FACTORY },
      { publicClient, walletClient },
    );

    const permit = await factory.createDeterministicPermitSignature(
      walletClient,
      grantSimpleJson,
      SALT,
      DEADLINE,
      { initValues: INIT_VALUES },
    );

    expect(permit).toEqual({ signature: SIGNATURE, signerAddress: SIGNER });

    const predictCall = readContract.mock.calls
      .map(([params]) => params as any)
      .find((params) => params.functionName === "predictAddress");
    expect(predictCall.args).toEqual([SIGNER, SALT]);

    const typedData = walletClient.signTypedData.mock.calls[0][0];
    const signedType = typeString(typedData.types);
    expect(signedType).toBe(
      "PermitDeterministicAgreementWithActions(address signer,string docUri,bytes32 docHash,bytes32 initialState,bytes32 inputDefsHash,bytes32 transitionsHash,bytes32 initVarsHash,bytes32 verifiersHash,bytes32 actionsHash,bytes32 salt,address predictedAgreement,uint256 nonce,uint256 deadline)",
    );
    expect(contractSource("AgreementFactory")).toContain(`"${signedType}"`);
    expect(typedData.primaryType).toBe("PermitDeterministicAgreementWithActions");
    expect(typedData.message).toMatchObject({
      signer: SIGNER,
      salt: SALT,
      predictedAgreement: PREDICTED,
      nonce: 0n,
      deadline: BigInt(DEADLINE),
    });
    expect(Object.keys(typedData.message)).toEqual(
      typedData.types.PermitDeterministicAgreementWithActions.map((f: { name: string }) => f.name),
    );
  });

  it("predictAddress asks the factory for the creator's address", async () => {
    const { publicClient, walletClient, readContract } = mockClients({
      predictAddress: PREDICTED,
    });
    const factory = new AgreementFactory(
      { factoryAddress: FACTORY },
      { publicClient, walletClient },
    );

    await expect(factory.predictAddress(SIGNER, SALT)).resolves.toBe(PREDICTED);
    expect((readContract.mock.calls[0][0] as any).args).toEqual([SIGNER, SALT]);
  });
});
