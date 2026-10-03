import { createHmac, createHash, timingSafeEqual, randomUUID } from "node:crypto";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { decodeEnvelope, encodeEnvelope, FrameType } from "@cce/protocol";
import { DocumentStore, type OwnedState } from "./persistence.js";
import { encodeCandidate } from "./candidate.js";

type Claims = { iss: string; aud: string; sub: string; sid: string; project_id: string; file_id: string; document_id: string; generation: string; role: string; connection_id: string; exp: number; iat: number };
type Peer = { socket: WebSocket; claims: Claims };
type Room = { value: OwnedState; fence: bigint; stopped: boolean; peers: Set<Peer>; queue: Promise<void>; queued: number; queuedBytes: number; rateTokens: number; rateAt: number; snapshotSequence: bigint; snapshotAt: number; timer?: NodeJS.Timeout; revalidation?: NodeJS.Timeout; idle?: NodeJS.Timeout };

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
  return encodeEnvelope(FrameType.ERROR, encoder.encode(JSON.stringify({ code, retryable: ["STORAGE_UNAVAILABLE", "RATE_LIMITED", "ROOM_MOVED", "HEAD_CHANGED"].includes(code), message })));
}

function send(peer: Peer, frame: Uint8Array) {
  if (peer.socket.readyState !== WebSocket.OPEN) return;
  if (peer.socket.bufferedAmount + frame.byteLength > maxBuffered) { peer.socket.close(1013, "Resync required"); return; }
  peer.socket.send(frame);
}

function uuid(bytes: Uint8Array): string {
  const hex = Buffer.from(bytes).toString('hex');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
const knownErrors = new Set(['AUTH_REQUIRED','FORBIDDEN','STALE_GENERATION','ROOM_MOVED','STORAGE_UNAVAILABLE','FRAME_INVALID','LIMIT_EXCEEDED','RATE_LIMITED','RECEIPT_MISMATCH','HEAD_CHANGED']);
function errorCode(error: unknown): string {
  return error instanceof Error && knownErrors.has(error.message) ? error.message : 'STORAGE_UNAVAILABLE';
}
function receiptBody(sequence: bigint, body: Uint8Array): Uint8Array {
  const value = new Uint8Array(72); new DataView(value.buffer).setBigUint64(0, sequence); value.set(body.subarray(0,64),8); return value;
}

export function attachRealtime(server: HttpServer, databaseURL: string, secret: string, persistence?: DocumentStore) {
  const store = persistence ?? new DocumentStore(databaseURL, randomUUID());
  const pool = store.pool;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 524288 + 64 + 6, perMessageDeflate: false });
  const used = new Map<string, number>();
  const rooms = new Map<string, Room>();
  const loadingRooms = new Map<string, Promise<Room>>();
  let closing = false;

  async function current(claims: Claims) {
    const result = await pool.query(`SELECT f.id::text AS file_id,f.generation::text AS generation,m.role
      FROM documents d JOIN files f ON f.id=d.file_id
      JOIN projects p ON p.id=f.project_id AND p.lifecycle_state='active'
      JOIN project_members m ON m.project_id=p.id AND m.user_id=$2
      JOIN sessions s ON s.id=$3 AND s.user_id=m.user_id AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
      WHERE d.id=$1 AND f.project_id=$4 AND f.current_document_id=d.id AND f.tombstoned_at IS NULL AND d.generation=f.generation`,
      [claims.document_id, claims.sub, claims.sid, claims.project_id]);
    const row = result.rows[0] as { file_id: string; generation: string; role: string } | undefined;
    return row && row.file_id === claims.file_id && row.generation === claims.generation ? row : null;
  }
  function stop(document: string, room: Room, code: string) {
    room.stopped = true; clearInterval(room.timer); clearInterval(room.revalidation); clearTimeout(room.idle);
    if (rooms.get(document) === room) rooms.delete(document);
    for (const peer of room.peers) { send(peer, errorFrame(code, 'Document must resynchronize')); peer.socket.close(1013); }
  }
  function enqueue(room: Room, bytes: number, work: () => Promise<void>): boolean {
    if (room.stopped || room.queued >= 128 || room.queuedBytes + bytes > 4194304) return false;
    room.queued++; room.queuedBytes += bytes;
    room.queue = room.queue.then(work).catch(() => {}).finally(() => { room.queued--; room.queuedBytes -= bytes; });
    return true;
  }
  async function snapshot(document: string, room: Room) {
    if (room.stopped || room.value.sequence === room.snapshotSequence) return;
    // Encoded bytes are immutable; publication refers to precisely this cut.
    const cut = room.value;
    await store.snapshot(document, room.fence, cut);
    room.snapshotSequence = cut.sequence; room.snapshotAt = Date.now();
  }
  async function roomFor(claims: Claims): Promise<Room> {
    const existing = rooms.get(claims.document_id);
    if (existing && !existing.stopped) { clearTimeout(existing.idle); return existing; }
    const loading = loadingRooms.get(claims.document_id);
    if (loading) return loading;
    if (rooms.size + loadingRooms.size >= 256 || loadingRooms.size >= 4) throw new Error('RATE_LIMITED');
    const task = (async () => {
      const fence = await store.acquire(claims.document_id);
      // Renewal starts before replay so large retained tails do not lose ownership.
      let failed = false; let renewing = false;
      const timer = setInterval(() => {
        if (renewing) return; renewing = true;
        void store.renew(claims.document_id,fence).then(ok => { if (!ok) failed=true; }).catch(() => { failed=true; }).finally(() => { renewing=false; });
      },5000); timer.unref();
      try {
        const value = await store.hydrate(claims.document_id);
        if (failed || closing) throw new Error('ROOM_MOVED');
        clearInterval(timer);
        const room: Room = { value, fence, stopped: false, peers: new Set(), queue: Promise.resolve(), queued: 0, queuedBytes: 0, rateTokens: 100, rateAt: performance.now(), snapshotSequence: value.snapshotSequence, snapshotAt: Date.now() };
        rooms.set(claims.document_id, room);
        let renewingLease = false;
        room.timer = setInterval(() => {
          if (renewingLease || room.stopped) return; renewingLease = true;
          void store.renew(claims.document_id,room.fence).then(ok => {
            if (!ok) stop(claims.document_id,room,'ROOM_MOVED');
          }).catch(() => stop(claims.document_id,room,'STORAGE_UNAVAILABLE')).finally(() => { renewingLease = false; });
        },5000); room.timer.unref();
        let ticking = false;
        room.revalidation = setInterval(() => {
          if (ticking || room.stopped) return; ticking = true;
          void (async () => {
            for (const peer of room.peers) {
              if (!await current(peer.claims)) { send(peer,errorFrame('FORBIDDEN','Access changed')); peer.socket.close(1008); }
            }
            if (Date.now()-room.snapshotAt>=30000) enqueue(room,0,async () => { try { await snapshot(claims.document_id,room); } catch (error) { if (errorCode(error)==='ROOM_MOVED') stop(claims.document_id,room,'ROOM_MOVED'); } });
          })().catch(error => stop(claims.document_id,room,errorCode(error))).finally(() => { ticking=false; });
        },2000); room.revalidation.unref();
        return room;
      } catch (error) { clearInterval(timer); await store.release(claims.document_id,fence).catch(() => {}); throw error; }
    })();
    loadingRooms.set(claims.document_id,task);
    try { return await task; } finally { loadingRooms.delete(claims.document_id); }
  }

  server.on('upgrade', async (request: IncomingMessage, socket, head) => {
    const match = /^\/internal\/ws\/documents\/([0-9a-f-]{36})$/.exec(request.url ?? '');
    if (!match || closing) { socket.destroy(); return; }
    const claims = verifyAssertion(request.headers.authorization,secret,used);
    if (!claims || claims.document_id!==match[1]) { socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
    try {
      const access = await current(claims);
      if (!access || access.role!==claims.role) { socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
      const room = await roomFor(claims);
      if (room.stopped || !await current(claims)) throw new Error('FORBIDDEN');
      wss.handleUpgrade(request,socket,head,ws => {
        const peer: Peer = { socket: ws, claims }; room.peers.add(peer); clearTimeout(room.idle);
        send(peer,encodeEnvelope(FrameType.HELLO,encoder.encode(JSON.stringify({ protocol:1,file_id:claims.file_id,document_id:claims.document_id,generation:Number(claims.generation),committed_sequence:room.value.sequence.toString() }))));
        ws.on('error', () => { ws.terminate(); });
        ws.on('close', () => {
          room.peers.delete(peer);
          if (room.peers.size || room.stopped || closing) return;
          room.idle = setTimeout(() => {
            enqueue(room,0,async () => {
              if (room.peers.size) return;
              await snapshot(claims.document_id,room).catch(() => {});
              stop(claims.document_id,room,'ROOM_MOVED'); await store.release(claims.document_id,room.fence).catch(() => {});
            });
          },30000); room.idle.unref();
        });
        ws.on('message',(raw,binary) => {
          if (!binary) { send(peer,errorFrame('FRAME_INVALID','Binary frame required')); ws.close(1003); return; }
          let frame: ReturnType<typeof decodeEnvelope>;
          try { frame=decodeEnvelope(new Uint8Array(raw as Buffer),'client'); } catch { send(peer,errorFrame('FRAME_INVALID','Invalid frame')); ws.close(1003); return; }
          if (frame.type!==FrameType.SYNC_REQUEST && frame.type!==FrameType.DURABLE_UPDATE) { send(peer,errorFrame('FRAME_INVALID','Unsupported frame')); return; }
          const now=performance.now(); room.rateTokens=Math.min(100,room.rateTokens+(now-room.rateAt)*0.1); room.rateAt=now;
          if (room.rateTokens<1) { send(peer,errorFrame('RATE_LIMITED','Room send rate exceeded')); return; } room.rateTokens--;
          const queued=enqueue(room,frame.body.byteLength,async () => {
            try {
              if (room.stopped) throw new Error('ROOM_MOVED');
              if (!await current(claims)) throw new Error('FORBIDDEN');
              if (frame.type===FrameType.SYNC_REQUEST) {
                const value=await encodeCandidate(room.value.state,[],{syncVector:frame.body});
                const update=value.update!; const vector=value.vector;
                const body=new Uint8Array(16+vector.length+update.length); const view=new DataView(body.buffer);
                view.setBigUint64(0,room.value.sequence); view.setUint32(8,vector.length); body.set(vector,12); view.setUint32(12+vector.length,update.length); body.set(update,16+vector.length);
                send(peer,encodeEnvelope(FrameType.SYNC_STATE,body)); return;
              }
              const instance=uuid(frame.body.subarray(0,16)); const message=uuid(frame.body.subarray(16,32));
              const hash=frame.body.subarray(32,64); const update=frame.body.subarray(64);
              if (!timingSafeEqual(hash,createHash('sha256').update(update).digest())) throw new Error('FRAME_INVALID');
              const prior=await store.receipt(claims,room.fence,instance,message,hash);
              if (prior!==null) { send(peer,encodeEnvelope(FrameType.DURABLE_ACK,receiptBody(prior,frame.body))); return; }
              const candidate=await encodeCandidate(room.value.state,[update]);
              let sequence: bigint;
              try { sequence=await store.append(claims,room.fence,room.value.sequence,instance,message,hash,update,candidate.textBytes); }
              catch (error) {
                if (errorCode(error)!=='STORAGE_UNAVAILABLE') throw error;
                // The COMMIT may have succeeded despite a lost response. Resolve
                // its original identity and rehydrate before sending any success.
                const receipt=await store.receipt(claims,room.fence,instance,message,hash);
                room.value=await store.hydrate(claims.document_id);
                if (receipt===null) throw error;
                sequence=receipt;
              }
              if (room.stopped) throw new Error('ROOM_MOVED');
              if (sequence===room.value.sequence+1n) room.value={...candidate,sequence};
              else if (sequence>room.value.sequence) room.value=await store.hydrate(claims.document_id);
              const body=new Uint8Array(72+update.length); body.set(receiptBody(sequence,frame.body)); body.set(update,72);
              // Recheck each peer before delivering committed source. Read
              // revocation remains bounded (2s), never an instant-erasure claim.
              for (const other of room.peers) if (other!==peer && await current(other.claims)) send(other,encodeEnvelope(FrameType.UPDATE_COMMITTED,body));
              send(peer,encodeEnvelope(FrameType.DURABLE_ACK,receiptBody(sequence,frame.body)));
              if (room.value.sequence-room.snapshotSequence>=100n) await snapshot(claims.document_id,room).catch(error => { if (errorCode(error)==='ROOM_MOVED') stop(claims.document_id,room,'ROOM_MOVED'); });
            } catch (error) {
              const code=errorCode(error); send(peer,errorFrame(code,'Document operation rejected; unacknowledged work is unsaved'));
              if (code==='ROOM_MOVED' || code==='HEAD_CHANGED' || code==='STORAGE_UNAVAILABLE') stop(claims.document_id,room,code);
            }
          });
          if (!queued) send(peer,errorFrame(room.stopped?'ROOM_MOVED':'RATE_LIMITED','Room unavailable or busy'));
        });
      });
    } catch { socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n'); socket.destroy(); }
  });
  return { close: async () => {
    closing=true;
    const values=[...rooms.entries()];
    for (const [id,room] of values) { stop(id,room,'ROOM_MOVED'); for (const peer of room.peers) peer.socket.terminate(); }
    await Promise.allSettled([...loadingRooms.values()]);
    // Wait for work already in flight before releasing fences or ending the pool.
    await Promise.allSettled(values.map(async ([id,room]) => { await room.queue; await store.release(id,room.fence); }));
    wss.close(); await pool.end();
  } };
}
