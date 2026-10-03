import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { Pool } from "pg";
import { WebSocket } from "ws";
import * as Y from "yjs";
import { decodeEnvelope, encodeEnvelope, FrameType } from "@cce/protocol";
import { attachRealtime } from "./realtime.js";

const databaseURL = process.env.TEST_DATABASE_URL;
const secret = "test-only-assertion-key-with-enough-entropy-0303";

function assertion(claims: Record<string, unknown>) {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const value = header + "." + body;
  return value + "." + createHmac("sha256", secret).update(value).digest("base64url");
}

function frameUpdate(update: Uint8Array, instance = randomUUID(), id = randomUUID()) {
  const body = Buffer.alloc(64 + update.length);
  Buffer.from(instance.replaceAll("-", ""), "hex").copy(body, 0);
  Buffer.from(id.replaceAll("-", ""), "hex").copy(body, 16);
  createHash("sha256").update(update).digest().copy(body, 32);
  Buffer.from(update).copy(body, 64);
  return encodeEnvelope(FrameType.DURABLE_UPDATE, body);
}

function nextFrame(socket: WebSocket, expected: FrameType): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { socket.off("message", handle); reject(new Error("frame timeout")); }, 5000);
    const handle = (raw: Buffer) => {
      const frame = decodeEnvelope(new Uint8Array(raw), "server");
      if (frame.type !== expected) return;
      clearTimeout(timeout); socket.off("message", handle); resolve(frame.body);
    };
    socket.on("message", handle);
  });
}

test("Phase 04 private rooms reject raw viewer writes and converge durable edits", { skip: !databaseURL }, async () => {
  const pool = new Pool({ connectionString: databaseURL });
  const server = createServer((_request, response) => response.writeHead(404).end());
  const service = attachRealtime(server, process.env.TEST_COLLAB_DATABASE_URL ?? databaseURL!, secret);
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const sockets: WebSocket[] = [];
  try {
    const subject = randomUUID();
    const owner = (await pool.query("INSERT INTO users(provider,provider_subject,display_name) VALUES('github',$1,'Owner') RETURNING id::text", [subject])).rows[0].id as string;
    const viewer = (await pool.query("INSERT INTO users(provider,provider_subject,display_name) VALUES('github',$1,'Viewer') RETURNING id::text", [randomUUID()])).rows[0].id as string;
    const session = (await pool.query("INSERT INTO sessions(user_id,token_hash,csrf_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 hour') RETURNING id::text", [owner, randomBytes(32), randomBytes(32)])).rows[0].id as string;
    const viewerSession = (await pool.query("INSERT INTO sessions(user_id,token_hash,csrf_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 hour') RETURNING id::text", [viewer, randomBytes(32), randomBytes(32)])).rows[0].id as string;
    const tx = await pool.connect();
    let project: string;
    try {
      await tx.query("BEGIN");
      project = (await tx.query("INSERT INTO projects(owner_id,name) VALUES($1,'Realtime fixture') RETURNING id::text", [owner])).rows[0].id as string;
      await tx.query("INSERT INTO project_members(project_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'viewer')", [project, owner, viewer]);
      await tx.query("COMMIT");
    } catch (error) { await tx.query("ROLLBACK"); throw error; } finally { tx.release(); }
    const fileTx = await pool.connect();
    let file: string; let document: string;
    try {
      await fileTx.query("BEGIN");
      file = (await fileTx.query("INSERT INTO files(project_id,name,kind,language,generation) VALUES($1,'main.ts','file','typescript',1) RETURNING id::text", [project])).rows[0].id as string;
      document = (await fileTx.query("INSERT INTO documents(file_id,generation) VALUES($1,1) RETURNING id::text", [file])).rows[0].id as string;
      await fileTx.query("UPDATE files SET current_document_id=$1 WHERE id=$2", [document, file]);
      await fileTx.query("COMMIT");
    } catch (error) { await fileTx.query("ROLLBACK"); throw error; } finally { fileTx.release(); }
    const initial = new Y.Doc(); initial.getText("content");
    const state = Y.encodeStateAsUpdate(initial); const vector = Y.encodeStateVector(initial);
    await pool.query("INSERT INTO document_snapshots(document_id,through_sequence,encoded_state,state_vector,checksum) VALUES($1,0,$2,$3,$4)", [document, Buffer.from(state), Buffer.from(vector), createHash("sha256").update(state).digest()]);
    initial.destroy();
    const connect = async (user: string, sid: string, role: string) => {
      const claims = { iss: "cce-api", aud: "cce-collab", sub: user, sid, project_id: project, file_id: file, document_id: document, generation: "1", role, connection_id: randomBytes(32).toString("base64url"), iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 20 };
      const socket = new WebSocket(`ws://127.0.0.1:${port}/internal/ws/documents/${document}`, { headers: { Authorization: "Bearer " + assertion(claims) } });
      sockets.push(socket); await once(socket, "open");
      return socket;
    };
    const first = await connect(owner, session, "owner");
    const second = await connect(owner, session, "owner");
    const third = await connect(viewer, viewerSession, "viewer");
    const localA = new Y.Doc(); const localB = new Y.Doc();
    let updateA: Uint8Array = new Uint8Array(); let updateB: Uint8Array = new Uint8Array();
    localA.on("update", (u: Uint8Array) => { updateA = u; }); localB.on("update", (u: Uint8Array) => { updateB = u; });
    localA.getText("content").insert(0, "A"); localB.getText("content").insert(0, "B");
    const denied = nextFrame(third, FrameType.ERROR); third.send(frameUpdate(updateA));
    assert.equal(JSON.parse(Buffer.from(await denied).toString()).code, "FORBIDDEN");
    const duplicateFrame = frameUpdate(updateA);
    const receivedA = nextFrame(second, FrameType.UPDATE_COMMITTED); first.send(duplicateFrame); await receivedA;
    first.send(duplicateFrame);
    const receivedB = nextFrame(first, FrameType.UPDATE_COMMITTED); second.send(frameUpdate(updateB)); await receivedB;
    const mismatch = nextFrame(first, FrameType.ERROR);
    const changed = Uint8Array.from(duplicateFrame); changed[changed.length - 1] ^= 1;
    changed.set(createHash("sha256").update(changed.subarray(70)).digest(), 38);
    first.send(changed);
    assert.equal(JSON.parse(Buffer.from(await mismatch).toString()).code, "RECEIPT_MISMATCH");
    const causal = new Y.Doc(); const causalUpdates: Uint8Array[] = [];
    causal.on("update", (bytes: Uint8Array) => causalUpdates.push(bytes));
    causal.getText("content").insert(0, "one"); causal.getText("content").insert(3, "two");
    const delayed = nextFrame(second, FrameType.UPDATE_COMMITTED); first.send(frameUpdate(causalUpdates[1])); await delayed;
    const leading = nextFrame(second, FrameType.UPDATE_COMMITTED); first.send(frameUpdate(causalUpdates[0])); await leading;
    const unauthenticated = new WebSocket(`ws://127.0.0.1:${port}/internal/ws/documents/${document}`);
    assert.equal(await new Promise<number>((resolve, reject) => { unauthenticated.once("unexpected-response", (_request, response) => resolve(response.statusCode ?? 0)); unauthenticated.once("open", () => reject(new Error("direct worker access allowed"))); unauthenticated.once("error", reject); }), 403);
    const syncClient = await connect(owner, session, "owner");
    const committed = nextFrame(syncClient, FrameType.SYNC_STATE);

    syncClient.send(encodeEnvelope(FrameType.SYNC_REQUEST, Y.encodeStateVector(new Y.Doc())));
    const sync = await committed;
    const vectorLength = new DataView(sync.buffer, sync.byteOffset).getUint32(8);
    const updateLength = new DataView(sync.buffer, sync.byteOffset).getUint32(12 + vectorLength);
    const replay = new Y.Doc(); replay.getText("content");
    Y.applyUpdate(replay, sync.subarray(16 + vectorLength, 16 + vectorLength + updateLength));

    assert.equal(replay.getText("content").length, 8);
    assert.ok(replay.getText("content").toString().includes("A"));
    assert.ok(replay.getText("content").toString().includes("B"));
    assert.ok(replay.getText("content").toString().includes("onetwo"));
    const malformed = await connect(owner, session, "owner");
    const malformedError = nextFrame(malformed, FrameType.ERROR);
    malformed.send(Buffer.from([1, 4, 0]));
    assert.equal(JSON.parse(Buffer.from(await malformedError).toString()).code, "FRAME_INVALID");
    const healthy = await connect(owner, session, "owner");
    const healthySync = nextFrame(healthy, FrameType.SYNC_STATE);
    healthy.send(encodeEnvelope(FrameType.SYNC_REQUEST, Y.encodeStateVector(new Y.Doc())));
    await healthySync;
    const rich = new Y.Doc(); let richUpdate: Uint8Array = new Uint8Array();
    rich.on("update", (bytes: Uint8Array) => { richUpdate = bytes; });
    rich.getText("content").insert(0, "formatted", { bold: true });
    const richError = nextFrame(first, FrameType.ERROR);
    first.send(frameUpdate(richUpdate));
    assert.equal(JSON.parse(Buffer.from(await richError).toString()).code, "LIMIT_EXCEEDED");
    rich.destroy();
    const count = await pool.query("SELECT count(*)::int AS count FROM document_updates WHERE document_id=$1", [document]);
    assert.equal(count.rows[0].count, 4, "One durable row per identified input");
  } finally {
    for (const socket of sockets) socket.terminate();
    await service.close(); await new Promise<void>((resolve) => server.close(() => resolve())); await pool.end();
  }
});
