import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import * as Y from "yjs";
import { initialStateHandler } from "./initial-state.js";

test("private initializer returns a valid empty Yjs document and rejects unauthenticated callers", async () => {
  const server = createServer(initialStateHandler).listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing TCP address");
    const origin = `http://127.0.0.1:${address.port}`;
    assert.equal((await fetch(origin)).status, 403);
    const response = await fetch(origin, { headers: { "X-Internal-Token": "cce_dev_internal_only" } });
    assert.equal(response.status, 200);
    const body = await response.json() as { encoded_state: string; state_vector: string };
    const doc = new Y.Doc();
    Y.applyUpdate(doc, Buffer.from(body.encoded_state, "base64"));
    assert.equal(doc.getText("content").toString(), "");
    assert.deepEqual(Buffer.from(Y.encodeStateVector(doc)), Buffer.from(body.state_vector, "base64"));
    doc.destroy();
  } finally {
    server.close();
  }
});
