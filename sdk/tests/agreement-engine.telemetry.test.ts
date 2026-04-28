// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, beforeEach } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";

import { AgreementEngine } from "../src/AgreementEngine.js";
import type { AgreementJson } from "../src/types.js";
import { getFinishedTestSpans, resetOtelTestExporter } from "./otel-test-utils.js";

describe("AgreementEngine telemetry", () => {
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

  it("emits SDK spans for submitInputWithPermit", async () => {
    const publicClient = {
      chain: { id: 59141 },
      waitForTransactionReceipt: jest.fn(async () => ({
        transactionHash:
          "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        logs: [],
      })),
    } as any;
    const walletClient = {
      account: {
        address: "0x3333333333333333333333333333333333333333",
      },
      writeContract: jest.fn(async () =>
        "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      ),
    } as any;
    const engine = new AgreementEngine(
      "0x4444444444444444444444444444444444444444",
      publicClient,
      walletClient,
    );

    await engine.submitInputWithPermit(
      "0x5555555555555555555555555555555555555555",
      grantSimpleJson,
      "grantorData",
      {
        grantorName: "Alice",
        scope: "Scope",
        termDuration: "12 months",
        effectiveDate: "2026-01-01",
      },
      Math.floor(Date.now() / 1000) + 3600,
      {
        v: 27,
        r: "0x1111111111111111111111111111111111111111111111111111111111111111",
        s: "0x2222222222222222222222222222222222222222222222222222222222222222",
      },
      true,
    );

    const spans = getFinishedTestSpans();
    const outerSpan = spans.find(
      (span) => span.name === "agreement_engine.submit_input_with_permit",
    );

    expect(outerSpan?.attributes["agreement.address"]).toBe(
      "0x4444444444444444444444444444444444444444",
    );
    expect(outerSpan?.attributes["agreement.input_id"]).toBe("grantorData");
    expect(spans.some((span) => span.name === "evm.send_tx")).toBe(true);
    expect(spans.some((span) => span.name === "evm.wait_receipt")).toBe(true);
  });
});
