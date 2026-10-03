import { createHmac, createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import { Worker } from "node:worker_threads";
import { WebSocket, WebSocketServer } from "ws";
import { Pool } from "pg";
import * as Y from "yjs";
import { decodeEnvelope, encodeEnvelope, FrameType } from "@cce/protocol";

type Claims = { iss: string; aud: string; sub: string; sid: string; project_id: string; file_id: string; document_id: string; generation: string; role: string; connection_id: string; exp: number; iat: number };
type Peer = { socket: WebSocket; claims: Claims };
type Room = { committed: Y.Doc; live: Y.Doc; peers: Set<Peer>; pending: Uint8Array[]; pendingBytes: number; seen: Map<string, string>; queue: Promise<void>; queued: number; rateTokens: number; rateAt: number; fileId: string; generation: string };

const encoder = new TextEncoder();
const maxBuffered = 4 * 1024 * 1024;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function strictClaims(value: unknown): Claims | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  const keys = ["iss", "aud", "sub", "sid", "project_id", "file_id", "document_id", "generation", "role", "connection_id", "exp", "iat"];
  if (Object.keys(data).length !== keys.length || keys.some((key) => !(key in data))) return null;
  if (data.iss !== "cce-api" || data.aud !== "cce-collab" || !["owner", "editor", "viewer"].includes(String(data.role))) return null;
  if (![data.sub, data.sid, data.project_id, data.file_id, data.document_id].every((id) => typeof id === "string" && uuidPattern.test(id))) return null;
  if (typeof data.generation !== "string" || !/^[1-9]\d*$/.test(data.generation) || typeof data.connection_id !== "string" || data.connection_id.length !== 43) return null;
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isInteger(data.exp) || !Number.isInteger(data.iat) || Number(data.exp) <= now || Number(data.exp) > now + 30 || Number(data.iat) > now + 5) return null;
  return data as Claims;
}

function verifyAssertion(header: string | undefined, secret: string, used: Map<string, number>): Claims | null {
  if (!header?.startsWith("Bearer ") || !secret) return null;
  const token = header.slice(7);
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) return null;
  const signature = createHmac("sha256", secret).update(parts[0] + "." + parts[1]).digest();
  const supplied = Buffer.from(parts[2], "base64url");
  if (supplied.length !== signature.length || !timingSafeEqual(supplied, signature)) return null;
  let headerValue: unknown; let claimsValue: unknown;
  try { headerValue = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")); claimsValue = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")); } catch { return null; }
  if (!headerValue || typeof headerValue !== "object" || (headerValue as Record<string, unknown>).alg !== "HS256" || (headerValue as Record<string, unknown>).typ !== "JWT" || Object.keys(headerValue).length !== 2) return null;
  const claims = strictClaims(claimsValue);
  if (!claims || used.has(claims.connection_id)) return null;
  for (const [id, expiry] of used) if (expiry <= Date.now() / 1000) used.delete(id);
  used.set(claims.connection_id, claims.exp);
  return claims;
}

function errorFrame(code: string, message: string): Uint8Array {
  return encodeEnvelope(FrameType.ERROR, encoder.encode(JSON.stringify({ code, retryable: false, message })));
}

function send(peer: Peer, frame: Uint8Array) {
  if (peer.socket.readyState !== WebSocket.OPEN) return;
  if (peer.socket.bufferedAmount + frame.byteLength > maxBuffered) { peer.socket.close(1013, "Resync required"); return; }
  peer.socket.send(frame);
}

const validatorSource = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const Y = require('yjs');
try {
  const doc = new Y.Doc(); doc.getText('content');
  Y.applyUpdate(doc, new Uint8Array(workerData.state));
  Y.applyUpdate(doc, new Uint8Array(workerData.update));
  if (doc.share.size !== 1 || !(doc.share.get('content') instanceof Y.Text)) throw new Error('invalid roots');
  const delta = doc.getText('content').toDelta();
  if (delta.some(item => typeof item.insert !== 'string' || 'attributes' in item)) throw new Error('rich content rejected');
  const state = Y.encodeStateAsUpdate(doc);
  if (Buffer.byteLength(doc.getText('content').toString(), 'utf8') > 262144 || state.byteLength > 2097152 || Y.encodeStateVector(doc).byteLength > 65536) throw new Error('candidate limit exceeded');
  parentPort.postMessage({ state });
} catch { parentPort.postMessage({ error: true }); }
`;

async function validateCandidate(room: Room, update: Uint8Array): Promise<Y.Doc> {
  const state = Y.encodeStateAsUpdate(room.live);
  const worker = new Worker(validatorSource, { eval: true, workerData: { state, update }, resourceLimits: { maxOldGenerationSizeMb: 64, stackSizeMb: 4 } });
  const result = await new Promise<Uint8Array>((resolve, reject) => {
    let finished = false;
    const fail = () => { if (!finished) { finished = true; clearTimeout(timer); reject(new Error("candidate invalid")); } };
    const timer = setTimeout(() => { fail(); void worker.terminate(); }, 2000);
    worker.once("message", (message: { state?: Uint8Array; error?: boolean }) => {
      if (!message.state || message.error) { fail(); return; }
      if (!finished) { finished = true; clearTimeout(timer); resolve(message.state); }
    });
    worker.once("error", fail); worker.once("exit", (code) => { if (code !== 0) fail(); });
  });
  const candidate = new Y.Doc(); candidate.getText("content");
  Y.applyUpdate(candidate, result);
  return candidate;
}

export function attachRealtime(server: HttpServer, databaseURL: string, secret: string) {
  const pool = new Pool({ connectionString: databaseURL, max: 5 });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 2097152 + 65536 + 16, perMessageDeflate: false });
  const used = new Map<string, number>();
  const rooms = new Map<string, Room>();
  const loadingRooms = new Map<string, Promise<Room>>();

  async function current(claims: Claims) {
    const result = await pool.query(`SELECT f.id::text AS file_id,f.generation::text AS generation,m.role
      FROM documents d JOIN files f ON f.id=d.file_id
      JOIN projects p ON p.id=f.project_id AND p.lifecycle_state='active'
      JOIN project_members m ON m.project_id=p.id AND m.user_id=$2
      JOIN sessions s ON s.id=$3 AND s.user_id=m.user_id AND s.revoked_at IS NULL AND s.expires_at>now()
      WHERE d.id=$1 AND f.project_id=$4 AND f.current_document_id=d.id AND f.tombstoned_at IS NULL AND d.generation=f.generation`,
      [claims.document_id, claims.sub, claims.sid, claims.project_id]);
    const row = result.rows[0] as { file_id: string; generation: string; role: string } | undefined;
    return row && row.file_id === claims.file_id && row.generation === claims.generation ? row : null;
  }

  async function roomFor(claims: Claims): Promise<Room> {
    const existing = rooms.get(claims.document_id);
    if (existing) return existing;
    const loading = loadingRooms.get(claims.document_id);
    if (loading) return loading;
    const task = (async () => {
      const result = await pool.query(`SELECT encoded_state FROM document_snapshots WHERE document_id=$1 AND through_sequence=0`, [claims.document_id]);
      if (!result.rows[0]) throw new Error("initial snapshot unavailable");
      const committed = new Y.Doc(); committed.getText("content");
      Y.applyUpdate(committed, new Uint8Array(result.rows[0].encoded_state as Buffer));
      const live = new Y.Doc(); live.getText("content"); Y.applyUpdate(live, Y.encodeStateAsUpdate(committed));
      const room: Room = { committed, live, peers: new Set(), pending: [], pendingBytes: 0, seen: new Map(), queue: Promise.resolve(), queued: 0, rateTokens: 100, rateAt: performance.now(), fileId: claims.file_id, generation: claims.generation };
      rooms.set(claims.document_id, room);
      return room;
    })();
    loadingRooms.set(claims.document_id, task);
    try { return await task; } finally { loadingRooms.delete(claims.document_id); }
  }

  server.on("upgrade", async (request: IncomingMessage, socket, head) => {
    const path = request.url ?? "";
    const match = /^\/internal\/ws\/documents\/([0-9a-f-]{36})$/.exec(path);
    if (!match) { socket.destroy(); return; }
    const claims = verifyAssertion(request.headers.authorization, secret, used);
    if (!claims || claims.document_id !== match[1]) { socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); socket.destroy(); return; }
    try {
      const access = await current(claims);
      if (!access || access.role !== claims.role) { socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); socket.destroy(); return; }
      const room = await roomFor(claims);
      wss.handleUpgrade(request, socket, head, (ws) => {
        const peer: Peer = { socket: ws, claims };
        room.peers.add(peer);
        const hello = { protocol: 1, file_id: claims.file_id, document_id: claims.document_id, generation: Number(claims.generation), committed_sequence: "0" };
        send(peer, encodeEnvelope(FrameType.HELLO, encoder.encode(JSON.stringify(hello))));
        ws.on("close", () => {
          room.peers.delete(peer);
          if (room.peers.size > 0) return;
          setTimeout(async () => {
            if (room.peers.size > 0 || rooms.get(claims.document_id) !== room) return;
            try {
              const active = await pool.query(`SELECT 1 FROM files WHERE current_document_id=$1 AND tombstoned_at IS NULL`, [claims.document_id]);
              if (active.rowCount) return;
              rooms.delete(claims.document_id); room.live.destroy(); room.committed.destroy();
            } catch { /* keep the room until storage can be checked */ }
          }, 2500).unref();
        });
        ws.on("message", (raw, binary) => {
          if (!binary) { send(peer, errorFrame("FRAME_INVALID", "Binary frame required")); ws.close(1003); return; }
          let frame: ReturnType<typeof decodeEnvelope>;
          try { frame = decodeEnvelope(new Uint8Array(raw as Buffer), "client"); } catch { send(peer, errorFrame("FRAME_INVALID", "Invalid frame")); ws.close(1003); return; }
          if (frame.type === FrameType.SYNC_REQUEST) {
            try {
              const vector = Y.encodeStateVector(room.committed);
              const update = Y.encodeStateAsUpdate(room.committed, frame.body);
              const body = new Uint8Array(16 + vector.length + update.length);
              const view = new DataView(body.buffer); view.setBigUint64(0, 0n); view.setUint32(8, vector.length); body.set(vector, 12); view.setUint32(12 + vector.length, update.length); body.set(update, 16 + vector.length);
              send(peer, encodeEnvelope(FrameType.SYNC_STATE, body));
              for (const pending of room.pending) send(peer, encodeEnvelope(FrameType.PENDING_UPDATE, pending));
            } catch { send(peer, errorFrame("FRAME_INVALID", "Invalid state vector")); }
            return;
          }
          if (frame.type !== FrameType.DURABLE_UPDATE) { send(peer, errorFrame("FRAME_INVALID", "Unsupported frame")); return; }
          const now = performance.now();
          room.rateTokens = Math.min(100, room.rateTokens + (now - room.rateAt) * 0.1);
          room.rateAt = now;
          if (room.rateTokens < 1) { send(peer, errorFrame("RATE_LIMITED", "Room send rate exceeded")); return; }
          room.rateTokens--;
          if (room.queued >= 128) { send(peer, errorFrame("RATE_LIMITED", "Room busy")); return; }
          room.queued++;
          room.queue = room.queue.then(async () => {
            const access = await current(claims);
            if (!access || access.role === "viewer") { send(peer, errorFrame("FORBIDDEN", "Editing access changed")); return; }
            const identity = Buffer.from(frame.body.subarray(0, 32)).toString("hex");
            const hash = frame.body.subarray(32, 64);
            const update = frame.body.subarray(64);
            const actual = createHash("sha256").update(update).digest();
            if (!timingSafeEqual(hash, actual)) { send(peer, errorFrame("FRAME_INVALID", "Update hash mismatch")); return; }
            const prior = room.seen.get(identity);
            if (prior) { if (prior !== claims.sub + ":" + actual.toString("hex")) send(peer, errorFrame("RECEIPT_MISMATCH", "Message identity reused")); return; }
            if (room.pendingBytes + frame.body.byteLength > 2097152) { send(peer, errorFrame("LIMIT_EXCEEDED", "Pending room state full")); return; }
            let candidate: Y.Doc;
            try { candidate = await validateCandidate(room, update); } catch { send(peer, errorFrame("LIMIT_EXCEEDED", "Invalid or oversized update")); return; }
            room.live.destroy(); room.live = candidate;
            room.seen.set(identity, claims.sub + ":" + actual.toString("hex"));
            const pending = frame.body.slice(); room.pending.push(pending); room.pendingBytes += pending.byteLength;
            const outgoing = encodeEnvelope(FrameType.PENDING_UPDATE, pending);
            for (const other of room.peers) if (other !== peer) send(other, outgoing);
          }).catch(() => send(peer, errorFrame("STORAGE_UNAVAILABLE", "Room unavailable"))).finally(() => { room.queued--; });
        });
      });
    } catch { socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n"); socket.destroy(); }
  });
  return { close: () => pool.end() };
}
