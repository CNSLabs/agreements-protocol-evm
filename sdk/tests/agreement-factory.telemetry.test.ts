// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, beforeEach } from "@jest/globals";
import {
  encodeAbiParameters,
  encodeEventTopics,
  keccak256,
  stringToHex,
} from "viem";
import * as fs from "fs";
import * as path from "path";

import { AgreementFactory } from "../src/AgreementFactory.js";
import { AgreementFactoryABI } from "../src/generated/AgreementFactoryAbi.js";
import type { AgreementJson } from "../src/types.js";
import { getFinishedTestSpans, resetOtelTestExporter } from "./otel-test-utils.js";

describe("AgreementFactory telemetry", () => {
  let grantSimpleJson: AgreementJson;

  beforeAll(() => {
    const agreementPath = path.resolve(
      __dirname,
      "../../agreements/grant-simple/unwrapped/grant-simple.json",
    );
    grantSimpleJson = JSON.parse(fs.readFileSync(agreementPath, "utf-8"));
  });

  beforeEach(() => {
    resetOtelTestExporter();
  });

  it("emits factory and EVM spans for createAgreement", async () => {
    const request = {
      address: "0x1111111111111111111111111111111111111111",
      functionName: "createAgreement",
      abi: AgreementFactoryABI as any,
      args: [],
    } as any;
    const agreementAddress = "0x6666666666666666666666666666666666666666" as const;
    const owner = "0x7777777777777777777777777777777777777777" as const;
    const docUri = "ipfs://agreement/test";
    const docHash = keccak256(stringToHex(JSON.stringify(grantSimpleJson)));
    const publicClient = {
      chain: { id: 59141 },
      simulateContract: jest.fn(async () => ({ request })),
      waitForTransactionReceipt: jest.fn(async () => ({
        transactionHash:
          "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        logs: [
          {
            data: encodeAbiParameters(
              [
                { name: "docUri", type: "string" },
                { name: "docHash", type: "bytes32" },
              ],
              [docUri, docHash],
            ),
            topics: encodeEventTopics({
              abi: AgreementFactoryABI as any,
              eventName: "AgreementDeployed",
              args: {
                agreement: agreementAddress,
                owner,
              },
            }),
          },
        ],
      })),
    } as any;
    const walletClient = {
      account: {
        address: "0x8888888888888888888888888888888888888888",
      },
      writeContract: jest.fn(async () =>
        "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      ),
    } as any;
    const factory = new AgreementFactory(
      {
        factoryAddress: "0x1111111111111111111111111111111111111111",
        chainId: 59141,
      },
      {
        publicClient,
        walletClient,
      },
    );

    const deployment = await factory.createAgreement(grantSimpleJson, {
      initValues: {
        grantorEthAddress: "0x9999999999999999999999999999999999999999",
        recipientEthAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
    });

    expect(deployment.address).toBe(agreementAddress);

    const spans = getFinishedTestSpans();
    const outerSpan = spans.find(
      (span) => span.name === "agreement_factory.create",
    );

    expect(outerSpan?.attributes["blockchain.contract.address"]).toBe(
      "0x1111111111111111111111111111111111111111",
    );
    expect(spans.some((span) => span.name === "evm.simulate_tx")).toBe(true);
    expect(spans.some((span) => span.name === "evm.send_tx")).toBe(true);
    expect(spans.some((span) => span.name === "evm.wait_receipt")).toBe(true);
  });
});
