// SPDX-License-Identifier: Apache-2.0

import { trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";

const exporter = new InMemorySpanExporter();
const tracerProvider = new BasicTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});

trace.setGlobalTracerProvider(tracerProvider);

export function resetOtelTestExporter(): void {
  exporter.reset();
}

export function getFinishedTestSpans() {
  return exporter.getFinishedSpans();
}
