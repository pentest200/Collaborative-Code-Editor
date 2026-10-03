import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import * as Y from "yjs";
import { checkpointHandler } from "./checkpoints.js";
import { encodeCandidate } from "./candidate.js";

test("checkpoint preparation is private, bounded, and produces fresh Yjs identities", async () => {
  const handler = checkpointHandler("", "fixture-checkpoint-token");
  const server = createServer((request, response) => { void handler(request, response); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/internal/checkpoints/prepare`;
  const text = "captured α\nconst x = '<script>';\n";
  const prepare = (value: string, token = "fixture-checkpoint-token") => fetch(endpoint, { method: "POST", headers: { "content-type": "application/json", "x-internal-token": token }, body: JSON.stringify({ text: value }) });
  try {
    assert.equal((await prepare(text, "forged")).status, 403);
    assert.equal((await prepare("x".repeat(262145))).status, 503);
    const states: Uint8Array[] = [];
    for (let i = 0; i < 2; i++) {
      const response = await prepare(text); assert.equal(response.status, 200);
      const body = await response.json() as { encoded_state: string; state_vector: string };
      const state = Buffer.from(body.encoded_state, "base64"); states.push(state);
      const doc = new Y.Doc(); doc.getText("content"); Y.applyUpdate(doc, state);
      assert.equal(doc.getText("content").toString(), text); assert.equal(doc.share.size, 1);
      assert.ok(Buffer.from(Y.encodeStateVector(doc)).equals(Buffer.from(body.state_vector, "base64"))); doc.destroy();
    }
    assert.notDeepEqual(states[0], states[1], "preparation reused CRDT identity");
    const encoded = await encodeCandidate(states[0]); assert.equal("text" in encoded, false, "live room candidate retained a text projection");
    assert.equal((await encodeCandidate(states[0], [], { projectText: true })).text, text);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
