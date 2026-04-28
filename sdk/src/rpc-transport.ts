// SPDX-License-Identifier: Apache-2.0

import { SpanStatusCode } from "@opentelemetry/api";
import { http, type HttpTransportConfig } from "viem";

import { withSdkSpan } from "./telemetry.js";

type RpcPayload =
  | {
      method?: string;
      params?: unknown[];
    }
  | Array<{
      method?: string;
      params?: unknown[];
    }>;

function parseRpcPayload(body: unknown): {
  method: string;
  batchSize?: number;
} {
  if (typeof body !== "string" || body.length === 0) {
    return { method: "unknown" };
  }

  try {
    const parsed = JSON.parse(body) as RpcPayload;
    if (Array.isArray(parsed)) {
      const methods = Array.from(
        new Set(
          parsed
            .map((item) => (typeof item?.method === "string" ? item.method : undefined))
            .filter((value): value is string => Boolean(value)),
        ),
      );

      return {
        method: methods.length === 1 ? methods[0] : "batch",
        batchSize: parsed.length,
      };
    }

    return {
      method: typeof parsed?.method === "string" ? parsed.method : "unknown",
    };
  } catch {
    return { method: "unknown" };
  }
}

function parseRpcError(body: string): { code?: number; message?: string } | undefined {
  if (!body) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(body) as
      | { error?: { code?: number; message?: string } }
      | Array<{ error?: { code?: number; message?: string } }>;

    if (Array.isArray(parsed)) {
      const firstError = parsed.find((item) => item?.error);
      return firstError?.error;
    }

    return parsed?.error;
  } catch {
    return undefined;
  }
}

export function createInstrumentedHttpTransport(
  url: string,
  config: HttpTransportConfig = {},
) {
  const { fetchFn, ...rest } = config;
  const resolvedUrl = new URL(url);

  return http(url, {
    ...rest,
    fetchFn: async (input, init) => {
      const requestMethod = init?.method || "POST";
      const rpcPayload = parseRpcPayload(init?.body);
      const underlyingFetch = fetchFn ?? fetch;

      return withSdkSpan(
        "evm.rpc_request",
        {
          "rpc.system": "evm",
          "rpc.method": rpcPayload.method,
          "rpc.url": resolvedUrl.toString(),
          "server.address": resolvedUrl.host,
          "http.request.method": requestMethod,
          ...(rpcPayload.batchSize !== undefined
            ? { "rpc.batch_size": rpcPayload.batchSize }
            : {}),
        },
        async (span) => {
          const response = await underlyingFetch(input, init);
          span.setAttribute("http.response.status_code", response.status);

          const responseBody = await response.clone().text();
          const rpcError = parseRpcError(responseBody);
          if (rpcError) {
            if (rpcError.code !== undefined) {
              span.setAttribute("rpc.jsonrpc_error_code", rpcError.code);
            }
            if (rpcError.message) {
              span.setAttribute("rpc.jsonrpc_error_message", rpcError.message);
              span.setStatus({
                code: SpanStatusCode.ERROR,
                message: rpcError.message,
              });
            }
          }

          return response;
        },
      );
    },
  });
}
