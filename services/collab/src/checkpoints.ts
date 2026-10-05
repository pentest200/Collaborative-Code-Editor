import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Pool } from "pg";
import { encodeCandidate } from "./candidate.js";

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function checkpointHandler(url: string, token: string) {
  const pool = new Pool({ connectionString: url, max: 2, connectionTimeoutMillis: 2000, query_timeout: 4000 });
  pool.on("error", () => {});
  return async (request: IncomingMessage, response: ServerResponse) => {
    const supplied = Buffer.from(String(request.headers["x-internal-token"] ?? ""));
    const expected = Buffer.from(token);
    if (!token || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { response.writeHead(403).end(); return; }
    if (request.method !== "POST") { response.writeHead(405).end(); return; }
    try {
      let length = 0; const chunks: Buffer[] = [];
      for await (const chunk of request) {
        length += chunk.length;
        if (length > 2 * 1024 * 1024) throw new Error("LIMIT_EXCEEDED");
        chunks.push(Buffer.from(chunk));
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (request.url === "/internal/checkpoints/prepare") {
        if (typeof body.text !== "string" || Buffer.byteLength(body.text) > 262144) throw new Error("LIMIT_EXCEEDED");
        // Fresh random Yjs identity, never captured CRDT structs or tombstones.
        const value = await encodeCandidate(new Uint8Array([0, 0]), [], { text: body.text });
        response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(JSON.stringify({ encoded_state: Buffer.from(value.state).toString("base64"), state_vector: Buffer.from(value.vector).toString("base64") }));
        return;
      }
      const search = request.url === "/internal/search/materialize";
      if (!uuid.test(body.project_id) || !uuid.test(body.file_id)) throw new Error("FRAME_INVALID");
      if (search && (!uuid.test(body.document_id) || !uuid.test(body.snapshot_id) || typeof body.through_sequence !== "string" || !/^(0|[1-9][0-9]{0,18})$/.test(body.through_sequence) || BigInt(body.through_sequence) > 9223372036854775807n)) throw new Error("FRAME_INVALID");
      if (!search && !uuid.test(body.checkpoint_id)) throw new Error("FRAME_INVALID");
      const input = search ? (await pool.query(`SELECT d.id AS document_id,$4::bigint::text AS through_sequence,s.through_sequence::text AS snapshot_sequence,s.checksum AS snapshot_checksum,
        s.encoded_state,s.state_vector,s.checksum,s.through_sequence::text AS actual_snapshot_sequence
        FROM documents d JOIN files f ON f.id=d.file_id JOIN document_snapshots s ON s.document_id=d.id AND s.id=$5
        WHERE f.project_id=$1 AND f.id=$2 AND d.id=$3 AND d.last_committed_sequence>=$4`,
        [body.project_id,body.file_id,body.document_id,body.through_sequence,body.snapshot_id])).rows[0] : (await pool.query(`SELECT f.document_id,f.through_sequence::text,f.snapshot_sequence::text,f.snapshot_checksum,
        s.encoded_state,s.state_vector,s.checksum,s.through_sequence::text AS actual_snapshot_sequence FROM checkpoint_files f JOIN checkpoints c ON c.id=f.checkpoint_id
        JOIN document_snapshots s ON s.id=f.snapshot_id AND s.document_id=f.document_id
        WHERE c.project_id=$1 AND c.id=$2 AND f.file_id=$3`, [body.project_id, body.checkpoint_id, body.file_id])).rows[0];
      if (!input || input.snapshot_sequence !== input.actual_snapshot_sequence || BigInt(input.snapshot_sequence) > BigInt(input.through_sequence) || !hash(input.encoded_state).equals(input.snapshot_checksum) || !input.checksum.equals(input.snapshot_checksum)) throw new Error("STORAGE_UNAVAILABLE");
      let value = await encodeCandidate(input.encoded_state, [], { expectedVector: input.state_vector });
      let sequence = BigInt(input.snapshot_sequence); const head = BigInt(input.through_sequence);
      const deadline = performance.now() + 30000;
      while (sequence < head) {
        if (performance.now() > deadline) throw new Error("STORAGE_UNAVAILABLE");
        const rows = (await pool.query("SELECT sequence::text,update_bytes,update_hash FROM document_updates WHERE document_id=$1 AND sequence>$2 AND sequence<=$3 ORDER BY document_updates.sequence LIMIT 16", [input.document_id, sequence.toString(), head.toString()])).rows;
        if (!rows.length) throw new Error("STORAGE_UNAVAILABLE");
        for (const row of rows) {
          if (BigInt(row.sequence) !== ++sequence || !hash(row.update_bytes).equals(row.update_hash)) throw new Error("STORAGE_UNAVAILABLE");
        }
        value = await encodeCandidate(value.state, rows.map(row => new Uint8Array(row.update_bytes)));
      }
      value = await encodeCandidate(value.state, [], { projectText: true });
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ text: value.text }));
    } catch {
      if (!response.headersSent) response.writeHead(503, { "cache-control": "no-store" });
      response.end();
    }
  };
}
