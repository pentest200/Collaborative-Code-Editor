import { Worker } from "node:worker_threads";

export type EncodedDocument = { state: Uint8Array; vector: Uint8Array; textBytes: number; elapsedMs: number; heapBytes: number };
let active = 0;
const source = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const Y = require('yjs');
const start = performance.now();
try {
  const doc = new Y.Doc(); doc.getText('content');
  // Causally missing structs may not yet appear in doc.share/toDelta. Check
  // their decoded content too so hidden embeds/formatting cannot be receipted.
  for (const bytes of [workerData.state, ...workerData.updates]) {
    for (const struct of Y.decodeUpdate(new Uint8Array(bytes)).structs) {
      if (struct instanceof Y.Item && (
        !(struct.content instanceof Y.ContentString || struct.content instanceof Y.ContentDeleted) ||
        (typeof struct.parent === 'string' && struct.parent !== 'content') || struct.parentSub !== null
      )) throw new Error();
    }
  }
  Y.applyUpdate(doc, new Uint8Array(workerData.state));
  for (const bytes of workerData.updates) Y.applyUpdate(doc, new Uint8Array(bytes));
  if (doc.share.size !== 1 || !(doc.share.get('content') instanceof Y.Text)) throw new Error();
  const text = doc.getText('content');
  if (text.toDelta().some(item => typeof item.insert !== 'string' || 'attributes' in item)) throw new Error();
  const state = Y.encodeStateAsUpdate(doc); const vector = Y.encodeStateVector(doc);
  const textBytes = Buffer.byteLength(text.toString(), 'utf8');
  if (textBytes > 262144 || state.length > 2097152 || vector.length > 65536) throw new Error();
  if (workerData.expectedVector && !Buffer.from(vector).equals(Buffer.from(workerData.expectedVector))) throw new Error();
  const update = workerData.syncVector ? Y.encodeStateAsUpdate(doc, new Uint8Array(workerData.syncVector)) : undefined;
  parentPort.postMessage({ state, vector, update, textBytes, elapsedMs: performance.now()-start, heapBytes: process.memoryUsage().heapUsed });
  doc.destroy();
} catch { parentPort.postMessage({ error: true }); }
parentPort.close();
`;

// Main-thread state is encoded bytes only. Decode, replay, validation, cloning,
// state/vector encoding and sync-delta computation all happen in isolation.
export async function encodeCandidate(state: Uint8Array, updates: Uint8Array[] = [], options: { syncVector?: Uint8Array; expectedVector?: Uint8Array } = {}): Promise<EncodedDocument & { update?: Uint8Array }> {
  if (active >= 4) throw new Error("RATE_LIMITED");
  active++;
  let worker: Worker | undefined;
  try {
    worker = new Worker(source, { eval: true, workerData: { state, updates, ...options }, resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 8, stackSizeMb: 4 } });
    const task = worker;
    return await new Promise((resolve, reject) => {
      let done = false;
      const finish = (error?: Error, result?: EncodedDocument & { update?: Uint8Array }) => {
        if (done) return; done = true; clearTimeout(timer);
        if (error) reject(error); else resolve(result!);
      };
      const timer = setTimeout(() => finish(new Error("LIMIT_EXCEEDED")), 2000);
      task.once("message", (value: EncodedDocument & { update?: Uint8Array; error?: boolean }) => finish(value.error ? new Error("LIMIT_EXCEEDED") : undefined, value));
      task.once("error", () => finish(new Error("LIMIT_EXCEEDED")));
      task.once("exit", () => { if (!done) finish(new Error("LIMIT_EXCEEDED")); });
    });
  } finally { await worker?.terminate(); active--; }
}
