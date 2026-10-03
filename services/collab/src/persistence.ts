import { createHash } from "node:crypto";
import { Pool } from "pg";
import { encodeCandidate, type EncodedDocument } from "./candidate.js";

export type DocumentScope = { project_id: string; file_id: string; document_id: string; generation: string; sub: string; sid: string };
export type OwnedState = EncodedDocument & { sequence: bigint };
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest();

export class DocumentStore {
  readonly pool: Pool;
  constructor(url: string, readonly worker: string) {
    this.pool = new Pool({ connectionString: url, max: 8, connectionTimeoutMillis: 2000, query_timeout: 4000, statement_timeout: 3000 });
    this.pool.on("error", () => { /* Queries fail closed; no source or credentials in logs. */ });
  }
  private args(scope: DocumentScope, fence: bigint) {
    return [scope.project_id, scope.file_id, scope.document_id, scope.generation, scope.sub, scope.sid, this.worker, fence.toString()];
  }
  async acquire(document: string): Promise<bigint> {
    return BigInt((await this.pool.query("SELECT cce_acquire_document($1,$2)::text AS fence", [document, this.worker])).rows[0].fence);
  }
  async renew(document: string, fence: bigint): Promise<boolean> {
    return (await this.pool.query("SELECT cce_renew_document($1,$2,$3) AS ok", [document, this.worker, fence.toString()])).rows[0].ok as boolean;
  }
  async release(document: string, fence: bigint) {
    await this.pool.query("SELECT cce_release_document($1,$2,$3)", [document, this.worker, fence.toString()]);
  }
  async receipt(scope: DocumentScope, fence: bigint, instance: string, message: string, hash: Uint8Array): Promise<bigint | null> {
    const result = await this.pool.query("SELECT cce_document_receipt($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)::text AS sequence", [...this.args(scope, fence), instance, message, Buffer.from(hash)]);
    return result.rows[0].sequence === null ? null : BigInt(result.rows[0].sequence);
  }
  async append(scope: DocumentScope, fence: bigint, head: bigint, instance: string, message: string, hash: Uint8Array, update: Uint8Array, textBytes: number): Promise<bigint> {
    // A single function call in autocommit: its result is exposed only after
    // ReadyForQuery confirms transaction completion. Network errors are ambiguous.
    const result = await this.pool.query("SELECT cce_append_document($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)::text AS sequence", [...this.args(scope, fence), head.toString(), instance, message, Buffer.from(hash), Buffer.from(update), textBytes]);
    return BigInt(result.rows[0].sequence);
  }
  async hydrate(document: string): Promise<OwnedState & { snapshotSequence: bigint }> {
    const deadline = performance.now() + 30000;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const head = (await client.query("SELECT last_committed_sequence::text AS head FROM documents WHERE id=$1", [document])).rows[0]?.head;
      if (head === undefined) throw new Error("STALE_GENERATION");
      const snapshot = (await client.query("SELECT through_sequence::text AS sequence,encoded_state,state_vector,checksum FROM document_snapshots WHERE document_id=$1 AND through_sequence<=$2 ORDER BY through_sequence DESC LIMIT 1", [document, head])).rows[0];
      if (!snapshot || !digest(snapshot.encoded_state).equals(snapshot.checksum)) throw new Error("STORAGE_UNAVAILABLE");
      let value = await encodeCandidate(snapshot.encoded_state, [], { expectedVector: snapshot.state_vector });
      let sequence = BigInt(snapshot.sequence);
      while (sequence < BigInt(head)) {
        if (performance.now() > deadline) throw new Error("STORAGE_UNAVAILABLE");
        // At most 8 MiB per replay batch (16 bounded updates); the retained log
        // is never copied in full into the main process or a worker.
        const rows = (await client.query("SELECT sequence::text,update_bytes,update_hash FROM document_updates WHERE document_id=$1 AND sequence>$2 AND sequence<=$3 ORDER BY sequence LIMIT 16", [document, sequence.toString(), head])).rows;
        if (!rows.length) throw new Error("STORAGE_UNAVAILABLE");
        for (const row of rows) {
          if (BigInt(row.sequence) !== sequence + 1n || !digest(row.update_bytes).equals(row.update_hash)) throw new Error("STORAGE_UNAVAILABLE");
          sequence++;
        }
        value = await encodeCandidate(value.state, rows.map(row => new Uint8Array(row.update_bytes)));
      }
      await client.query("COMMIT");
      return { ...value, sequence, snapshotSequence: BigInt(snapshot.sequence) };
    } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
    finally { client.release(); }
  }
  async snapshot(document: string, fence: bigint, state: OwnedState) {
    await this.pool.query("SELECT cce_publish_snapshot($1,$2,$3,$4,$5,$6,$7)", [document, this.worker, fence.toString(), state.sequence.toString(), Buffer.from(state.state), Buffer.from(state.vector), digest(state.state)]);
  }
}
