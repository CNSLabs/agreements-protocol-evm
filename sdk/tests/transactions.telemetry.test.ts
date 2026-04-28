// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach } from "@jest/globals";

import { executeTransaction } from "../src/transactions.js";
import { getFinishedTestSpans, resetOtelTestExporter } from "./otel-test-utils.js";

describe("transactions telemetry", () => {
  beforeEach(() => {
    resetOtelTestExporter();
  });

  it("emits send and receipt spans for confirmed transactions", async () => {
    const request = {
      address: "0x1111111111111111111111111111111111111111",
      functionName: "submitInput",
    } as any;
    const walletClient = {
      writeContract: jest.fn(async () =>
        "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      ),
    } as any;
    const publicClient = {
      chain: { id: 59141 },
      waitForTransactionReceipt: jest.fn(async () => ({
        transactionHash:
          "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        logs: [],
      })),
    } as any;

    const receipt = await executeTransaction(
      request,
      publicClient,
      walletClient,
      true,
    );

    expect(receipt.transactionHash).toBe(
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );

    const spans = getFinishedTestSpans();
    const sendSpan = spans.find((span) => span.name === "evm.send_tx");
    const receiptSpan = spans.find((span) => span.name === "evm.wait_receipt");

    expect(sendSpan?.attributes["blockchain.contract.address"]).toBe(
      "0x1111111111111111111111111111111111111111",
    );
    expect(sendSpan?.attributes["blockchain.contract.function_name"]).toBe(
      "submitInput",
    );
    expect(sendSpan?.attributes["blockchain.transaction_hash"]).toBe(
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    expect(receiptSpan?.attributes["blockchain.transaction_hash"]).toBe(
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
  });
});
