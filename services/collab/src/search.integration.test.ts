import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { Pool } from "pg";
import * as Y from "yjs";
import { checkpointHandler } from "./checkpoints.js";
import { DocumentStore } from "./persistence.js";
import { fixture } from "./testing/fixture.js";

test("search projects exact committed cuts, validates scope/hash and keeps failures private", { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const workerURL = process.env.TEST_COLLAB_DATABASE_URL ?? process.env.TEST_DATABASE_URL!;
  const handler = checkpointHandler(workerURL, "search-test-token");
  const server = createServer((request, response) => { void handler(request, response); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/internal/search/materialize`;
  const scope = await fixture(admin);
  const store = new DocumentStore(workerURL, randomUUID());
  const doc = new Y.Doc(); const text = doc.getText("content"); let update: Uint8Array = new Uint8Array();
  doc.on("update", bytes => { update = bytes; });
  const snapshot = (await admin.query("SELECT id::text FROM document_snapshots WHERE document_id=$1 AND through_sequence=0", [scope.document_id])).rows[0].id;
  const input = { project_id: scope.project_id, file_id: scope.file_id, document_id: scope.document_id, snapshot_id: snapshot, through_sequence: "17" };
  const request = (body = input, token = "search-test-token") => fetch(endpoint, { method: "POST", headers: { "x-internal-token": token, "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    const fence = await store.acquire(scope.document_id);
    for (let i = 0; i < 25; i++) {
      text.insert(text.length, `${i}:Ω\n`);
      await store.append(scope, fence, BigInt(i), randomUUID(), randomUUID(), createHash("sha256").update(update).digest(), update, Buffer.byteLength(text.toString()));
    }
    assert.equal((await request(input, "forged")).status, 403);
    const response = await request(); assert.equal(response.status, 200);
    const projected = await response.json() as { text: string };
    assert.equal(projected.text, Array.from({ length: 17 }, (_, i) => `${i}:Ω\n`).join(""));
    const copy = new Y.Doc(); copy.getText("content");
    const rows = (await admin.query("SELECT update_bytes FROM document_updates WHERE document_id=$1 AND sequence<=17 ORDER BY sequence", [scope.document_id])).rows;
    for (const row of rows) Y.applyUpdate(copy, row.update_bytes);
    assert.equal(projected.text, copy.getText("content").toString()); copy.destroy();
    for (const bad of [{ ...input, project_id: randomUUID() }, { ...input, file_id: randomUUID() }, { ...input, snapshot_id: randomUUID() }, { ...input, through_sequence: "26" }, { ...input, through_sequence: "9223372036854775808" }, { ...input, through_sequence: "017" }]) assert.equal((await request(bad)).status, 503);
    await admin.query("UPDATE document_updates SET update_hash=$2 WHERE document_id=$1 AND sequence=11", [scope.document_id, Buffer.alloc(32)]);
    assert.equal((await request()).status, 503, "corrupt cut exposed searchable text");
    const healthy = await fetch(endpoint.replace("/search/materialize", "/checkpoints/prepare"), { method: "POST", headers: { "x-internal-token": "search-test-token" }, body: JSON.stringify({ text: "healthy after corrupt replay" }) });
    assert.equal(healthy.status, 200, "corruption blocked healthy isolated work");
  } finally { doc.destroy(); await store.pool.end(); await admin.end(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
