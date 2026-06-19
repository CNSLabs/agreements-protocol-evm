// SPDX-License-Identifier: Apache-2.0

import { SpanStatusCode, trace, type Span } from "@opentelemetry/api";

type SpanAttributeValue = string | number | boolean;

function isPresent<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function isPromiseLike<T>(value: T | PromiseLike<T>): value is PromiseLike<T> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as PromiseLike<T>).then === "function"
  );
}

function recordSpanError(span: Span, error: unknown): void {
  if (error instanceof Error) {
    span.recordException(error);
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: error.message,
    });
    return;
  }

  span.recordException(String(error));
  span.setStatus({
    code: SpanStatusCode.ERROR,
    message: String(error),
  });
}

export function withSdkSpan<T>(
  name: string,
  attributes: Record<string, SpanAttributeValue | undefined>,
  callback: (span: Span) => T,
): T {
  const filteredAttributes = Object.fromEntries(
    Object.entries(attributes).filter(([, value]) => isPresent(value)),
  ) as Record<string, SpanAttributeValue>;

  return trace.getTracer("@shodai-network/agreements-protocol-evm").startActiveSpan(
    name,
    { attributes: filteredAttributes },
    (span) => {
      try {
        const result = callback(span);

        if (isPromiseLike(result)) {
          return Promise.resolve(result)
            .catch((error) => {
              recordSpanError(span, error);
              throw error;
            })
            .finally(() => {
              span.end();
            }) as T;
        }

        span.end();
        return result;
      } catch (error) {
        recordSpanError(span, error);
        span.end();
        throw error;
      }
    },
  );
}
