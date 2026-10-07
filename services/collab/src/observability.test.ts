import assert from "node:assert/strict";
import { test } from "node:test";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { measured, registry, parentContext, rejection } from "./observability.js";

test("telemetry exports correlated numeric operations without source, error strings or credentials", async () => {
  const sentinel = "CCE_SECRET_SENTINEL_source_cookie_invite_stdin_stdout";
  const exporter = new InMemorySpanExporter();
  const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }); provider.register();
  try {
    await assert.rejects(measured("document.update", () => measured("document.append", async () => { throw new Error(sentinel); }), parentContext({ authorization: sentinel, cookie: sentinel, baggage: `secret=${sentinel}`, traceparent: "00-01234567890123456789012345678901-0123456789012345-01" })));
    rejection(new Error(sentinel));
    const spans = exporter.getFinishedSpans(); assert.equal(spans.length, 2); assert.equal(spans[0].spanContext().traceId, spans[1].spanContext().traceId);
    for (const span of spans) { assert.equal(JSON.stringify({ name: span.name, attributes: span.attributes, events: span.events, status: span.status }).includes(sentinel), false); assert.deepEqual(span.attributes, {}); }
    const metrics = await registry.metrics(); assert.equal(metrics.includes(sentinel), false); assert.ok(metrics.includes('code="STORAGE_UNAVAILABLE"'));
  } finally { await provider.shutdown(); }
});
