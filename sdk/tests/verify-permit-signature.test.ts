import { describe, it, expect } from "@jest/globals";
import { privateKeyToAccount } from "viem/accounts";
import { AgreementFactory } from "../src/AgreementFactory.js";
import type { AgreementJson } from "../src/types.js";

const REVIEWER = "0x1111111111111111111111111111111111111111";

// Self-contained, valid agreement (mirrors the multi-issuer fixture used elsewhere).
const agreement = {
  metadata: {
    id: "did:example:permit-guard",
    templateId: "did:template:permit-guard",
    version: "1.0.0",
    name: "Permit Guard Test",
  },
  variables: {
    primaryApprover: { type: "address", name: "Primary Approver", validation: { required: true } },
    backupApprover: { type: "address", name: "Backup Approver", validation: { required: true } },
    approvalNote: { type: "string", name: "Approval Note", validation: { required: true, minLength: 3 } },
  },
  content: { type: "md", data: "Approval content" },
  execution: {
    states: { PENDING: { name: "Pending" }, APPROVED: { name: "Approved" } },
    initialize: {
      initialState: "PENDING",
      data: {
        primaryApprover: "${variables.primaryApprover}",
        backupApprover: "${variables.backupApprover}",
      },
    },
    inputs: {
      approve: {
        type: "signedFields",
        data: { approvalNote: "${variables.approvalNote}" },
        issuer: [
          "${variables.primaryApprover.value}",
          "${variables.backupApprover.value}",
          REVIEWER,
        ],
      },
    },
    transitions: [
      { from: "PENDING", to: "APPROVED", conditions: [{ type: "isValid", input: "approve" }] },
    ],
  },
} as unknown as AgreementJson;

function makeHarness() {
  // Deterministic test signer (Anvil account #0) — local signing only, no network.
  const account = privateKeyToAccount(
    "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  );
  const walletClient = {
    account,
    signTypedData: ({ account: _ignored, ...rest }: any) => account.signTypedData(rest),
  } as any;
  const publicClient = {
    getChainId: async () => 8453,
    readContract: async () => 0n, // nonces[signer]
  } as any;
  const factory = new AgreementFactory(
    { factoryAddress: "0x76dAA59C02d902e7063E6328D2E64ACee6CC121e", chainId: 8453 },
    { walletClient, publicClient },
  );
  return { factory, walletClient, account };
}

describe("AgreementFactory.verifyPermitSignature", () => {
  const deadline = 7_000_000_000;
  // Required init vars for the fixture; same on both sign and verify so we isolate docUri.
  const initValues = {
    primaryApprover: "0x2222222222222222222222222222222222222222",
    backupApprover: "0x3333333333333333333333333333333333333333",
  };
  const opts = (docUri: string) => ({ docUri, initValues });

  it("accepts a signature over the SAME docUri that will be submitted", async () => {
    const { factory, walletClient, account } = makeHarness();
    const { signature, signerAddress } = await factory.createPermitSignature(
      walletClient,
      agreement,
      deadline,
      opts("ipfs://A"),
    );
    expect(signerAddress.toLowerCase()).toBe(account.address.toLowerCase());

    const ok = await factory.verifyPermitSignature(
      signerAddress,
      agreement,
      deadline,
      signature,
      opts("ipfs://A"),
    );
    expect(ok.valid).toBe(true);
    expect(ok.recovered.toLowerCase()).toBe(signerAddress.toLowerCase());
  });

  it("rejects when the submitted docUri differs from what was signed (the clawbank failure)", async () => {
    const { factory, walletClient } = makeHarness();
    const { signature, signerAddress } = await factory.createPermitSignature(
      walletClient,
      agreement,
      deadline,
      opts("ipfs://A"),
    );

    const mismatch = await factory.verifyPermitSignature(
      signerAddress,
      agreement,
      deadline,
      signature,
      opts("ipfs://B"), // server swapped the docUri after signing
    );
    expect(mismatch.valid).toBe(false);
  });

  it("rejects when the named signer is not the actual signer", async () => {
    const { factory, walletClient } = makeHarness();
    const { signature } = await factory.createPermitSignature(
      walletClient,
      agreement,
      deadline,
      opts("ipfs://A"),
    );

    const wrong = await factory.verifyPermitSignature(
      "0x000000000000000000000000000000000000dEaD",
      agreement,
      deadline,
      signature,
      opts("ipfs://A"),
    );
    expect(wrong.valid).toBe(false);
  });
});
