// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it } from "@jest/globals";

import { createInstrumentedHttpTransport } from "../src/rpc-transport.js";
import { getFinishedTestSpans, resetOtelTestExporter } from "./otel-test-utils.js";

describe("rpc transport telemetry", () => {
  beforeEach(() => {
    resetOtelTestExporter();
  });

  it("emits rpc spans for viem transport requests", async () => {
    const transport = createInstrumentedHttpTransport("https://rpc.example.com", {
      fetchFn: async () =>
        new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0xe705" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    })({
      chain: {
        id: 59141,
        rpcUrls: { default: { http: ["https://rpc.example.com"] } },
      } as any,
      retryCount: 0,
      timeout: 1000,
    });

    const result = await transport.request({
      method: "eth_chainId",
      params: [],
    });

    expect(result).toBe("0xe705");

    const rpcSpan = getFinishedTestSpans().find((span) => span.name === "evm.rpc_request");
    expect(rpcSpan?.attributes["rpc.system"]).toBe("evm");
    expect(rpcSpan?.attributes["rpc.method"]).toBe("eth_chainId");
    expect(rpcSpan?.attributes["rpc.url"]).toBe("https://rpc.example.com/");
    expect(rpcSpan?.attributes["server.address"]).toBe("rpc.example.com");
    expect(rpcSpan?.attributes["http.response.status_code"]).toBe(200);
  });
});
