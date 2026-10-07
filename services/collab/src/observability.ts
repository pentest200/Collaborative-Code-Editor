import { context, propagation, trace, SpanStatusCode, type Context } from "@opentelemetry/api";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { BatchSpanProcessor, ParentBasedSampler, TraceIdRatioBasedSampler } from "@opentelemetry/sdk-trace-base";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { Registry, Histogram, Gauge, Counter, collectDefaultMetrics } from "@prometheus-io/client";
import { createServer, type IncomingHttpHeaders } from "node:http";

export const registry = new Registry();
collectDefaultMetrics({ register: registry, prefix: "cce_" });
export const seconds = new Histogram({ name: "cce_operation_seconds", help: "Wall time including failures", labelNames: ["operation", "outcome"], buckets: [.001,.005,.01,.025,.05,.1,.25,.5,1,2,5,15,30], registers: [registry] });
export const rooms = new Gauge({ name: "cce_rooms", help: "Live fenced rooms", registers: [registry] });
export const connections = new Gauge({ name: "cce_connections", help: "Active document peers", registers: [registry] });
export const queued = new Gauge({ name: "cce_room_queue_items", help: "Queued room operations", registers: [registry] });
export const queueBytes = new Gauge({ name: "cce_room_queue_bytes", help: "Queued frame body bytes", registers: [registry] });
export const stateBytes = new Gauge({ name: "cce_room_state_bytes", help: "Encoded live room state bytes (not whole process memory)", registers: [registry] });
export const candidateHeap = new Histogram({ name: "cce_candidate_heap_bytes", help: "Isolated worker heap sample, excludes main process", buckets: [4e6,8e6,16e6,32e6,64e6,80e6], registers: [registry] });
export const errors = new Counter({ name: "cce_rejections_total", help: "Typed protocol/policy/queue failures", labelNames: ["code"], registers: [registry] });
export const ownership = new Counter({ name: "cce_ownership_total", help: "Successful ownership acquisitions", registers: [registry] });
const allowed = new Set(["AUTH_REQUIRED","FORBIDDEN","STALE_GENERATION","ROOM_MOVED","STORAGE_UNAVAILABLE","FRAME_INVALID","LIMIT_EXCEEDED","RATE_LIMITED","RECEIPT_MISMATCH","HEAD_CHANGED"]);
export function rejection(error: unknown) { const code = error instanceof Error && allowed.has(error.message) ? error.message : "STORAGE_UNAVAILABLE"; errors.inc({ code }); trace.getActiveSpan()?.setStatus({ code: SpanStatusCode.ERROR, message: code }); return code; }

export function initTelemetry() {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  if (!endpoint) return;
  const ratio = Number(process.env.CCE_TRACE_SAMPLE_RATIO ?? .1);
  if (!Number.isFinite(ratio) || ratio<0 || ratio>1) throw new Error("invalid trace sample ratio");
  const provider = new NodeTracerProvider({ resource: resourceFromAttributes({ "service.name": "cce-collab" }), sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(ratio) }), spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter({ url: endpoint }), { maxQueueSize: 2048 })] });
  provider.register(); // W3C trace context; extract only traceparent, never baggage
  process.once("SIGTERM", () => { void provider.shutdown().finally(() => process.exit(0)); });
}
export function parentContext(headers: IncomingHttpHeaders): Context { return propagation.extract(context.active(), { traceparent: headers.traceparent }); }
export async function measured<T>(name: string, work: () => Promise<T>, parent = context.active()): Promise<T> {
  return context.with(parent, () => trace.getTracer("cce/collab").startActiveSpan(name, async span => {
    const start = performance.now(); let outcome = "ok";
    try { return await work(); } catch (error) { outcome = "error"; span.setStatus({ code: SpanStatusCode.ERROR, message: "operation failed" }); throw error; }
    finally { seconds.observe({ operation: name, outcome }, (performance.now()-start)/1000); span.end(); }
  }));
}
export function startMetrics() {
  const port = Number(process.env.METRICS_PORT ?? 0); if (!port) return;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("invalid METRICS_PORT");
  createServer((_request, response) => {
    if (_request.method !== "GET" || _request.url !== "/metrics") { response.writeHead(404).end(); return; }
    void registry.metrics().then(body => { response.writeHead(200,{ "content-type": registry.contentType }); response.end(body); }).catch(() => response.writeHead(503).end());
  }).listen(port, process.env.HOST ?? "127.0.0.1");
}
