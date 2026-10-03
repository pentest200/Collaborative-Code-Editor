import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID, randomBytes } from "node:crypto";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import * as Y from "yjs";
import { FrameType, decodeEnvelope } from "@cce/protocol";
import { DocumentStore, type DocumentScope } from "./persistence.js";
import { attachRealtime } from "./realtime.js";
import { fixture, secret, connect, frame, sync, changes, mutation } from "./testing/fixture.js";

const adminURL=process.env.TEST_DATABASE_URL;
const workerURL=process.env.TEST_COLLAB_DATABASE_URL ?? adminURL;
const hash=(value: Uint8Array) => createHash('sha256').update(value).digest();

test("retained tails cross decimal sequence boundaries and replay multiple numeric batches",{skip:!adminURL},async () => {
  const pool=new Pool({connectionString:adminURL});const scope=await fixture(pool);
  const store=new DocumentStore(workerURL!,randomUUID());const doc=new Y.Doc();const text=doc.getText('content');
  let update:Uint8Array=new Uint8Array();doc.on('update',value=>{update=value;});
  try {
    const fence=await store.acquire(scope.document_id);
    for(let i=0;i<25;i++) {
      text.insert(text.length,'x');
      assert.equal(await store.append(scope,fence,BigInt(i),randomUUID(),randomUUID(),hash(update),update,i+1),BigInt(i+1));
    }
    const restored=await store.hydrate(scope.document_id);const copy=new Y.Doc();copy.getText('content');Y.applyUpdate(copy,restored.state);
    assert.equal(restored.sequence,25n);assert.equal(restored.snapshotSequence,0n);assert.equal(copy.getText('content').toString(),'x'.repeat(25));copy.destroy();
  } finally {doc.destroy();await store.pool.end();await pool.end();}
});
const wait=(ms:number) => new Promise(resolve => setTimeout(resolve,ms));
async function until(check:()=>Promise<boolean>,timeout=10000) {
  const end=Date.now()+timeout;
  while (!await check()) {if(Date.now()>end) throw new Error('Database barrier timeout');await wait(30);}
}
function child(stage=''): { process:ChildProcess; port:Promise<number>; stage:Promise<void> } {
  const process=spawn(globalThis.process.execPath,['--import','tsx',fileURLToPath(new URL('./testing/crash-worker.ts',import.meta.url))],{
    env:{...globalThis.process.env,TEST_COLLAB_DATABASE_URL:workerURL,TEST_ASSERTION_SECRET:secret,CRASH_STAGE:stage},stdio:['ignore','pipe','pipe','ipc']
  });
  let output='';process.stderr?.on('data',bytes => {output+=String(bytes);});
  const event=(key:string) => new Promise<Record<string,unknown>>((resolve,reject) => {
    const timer=setTimeout(() => {process.kill();reject(new Error('Child timeout '+key+' '+output));},45000);
    const receive=(value:Record<string,unknown>) => {if(key in value){clearTimeout(timer);process.off('message',receive);resolve(value);}};
    process.on('message',receive);process.once('error',reject);process.once('exit',() => {clearTimeout(timer);reject(new Error('Child exited '+output));});
  });
  // Only install the stage waiter for an intentional barrier.
  return {process,port:event('port').then(v => Number(v.port)),stage:stage?event('stage').then(() => {}):Promise.resolve()};
}
async function kill(process:ChildProcess) {const exited=once(process,'exit');process.kill('SIGKILL');await exited;}
async function expire(pool:Pool,scope:DocumentScope) {await pool.query("UPDATE document_owners SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE document_id=$1",[scope.document_id]);}
async function submitted(socket:Awaited<ReturnType<typeof connect>>,bytes:Uint8Array) {
  const received=frame(socket,FrameType.DURABLE_ACK);socket.send(bytes);return received;
}

test("real process death before commit, after commit, after snapshot and during renewal",{skip:!adminURL,timeout:120000},async () => {
  const pool=new Pool({connectionString:adminURL});const scope=await fixture(pool);const children:ChildProcess[]=[];
  const barrier=await pool.connect();
  const trigger='phase04_'+randomUUID().replaceAll('-','');
  try {
    await pool.query(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.document_id::text=TG_ARGV[0] THEN PERFORM pg_advisory_xact_lock(73004,1); END IF; RETURN NEW; END $$`);
    await pool.query(`CREATE TRIGGER ${trigger} BEFORE INSERT ON document_updates FOR EACH ROW EXECUTE FUNCTION ${trigger}('${scope.document_id}')`);
    await barrier.query('SELECT pg_advisory_lock(73004,1)');
    const before=child();children.push(before.process);const beforePort=await before.port;
    const writer=await connect(beforePort,scope);const peer=await connect(beforePort,scope);let successes=0;
    for(const socket of [writer,peer]) socket.on('message',raw => {const type=decodeEnvelope(raw as Buffer,'server').type;if(type===FrameType.DURABLE_ACK || type===FrameType.UPDATE_COMMITTED)successes++;});
    const original=mutation(changes('durable'));
    writer.send(original);
    await until(async () => !!(await pool.query("SELECT 1 FROM pg_stat_activity WHERE wait_event='advisory' AND query LIKE 'SELECT cce_append_document%'")).rowCount);
    assert.equal(successes,0,'No precommit broadcast or ACK');await kill(before.process);
    // PostgreSQL may finish an in-flight statement after its client dies. Keep
    // the insert blocked until its 3s statement timeout aborts the transaction;
    // only then release the barrier. A death alone is not proof of rollback.
    await until(async () => !(await pool.query("SELECT 1 FROM pg_stat_activity WHERE wait_event='advisory' AND query LIKE 'SELECT cce_append_document%'")).rowCount);
    await barrier.query('SELECT pg_advisory_unlock(73004,1)');
    await pool.query(`DROP TRIGGER ${trigger} ON document_updates`);await pool.query(`DROP FUNCTION ${trigger}()`);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM document_updates WHERE document_id=$1',[scope.document_id])).rows[0].n,0);
    writer.terminate();peer.terminate();await expire(pool,scope);

    const after=child('after-commit');children.push(after.process);const afterPort=await after.port;
    const sender=await connect(afterPort,scope);const observer=await connect(afterPort,scope);successes=0;
    for(const socket of [sender,observer]) socket.on('message',raw => {const type=decodeEnvelope(raw as Buffer,'server').type;if(type===FrameType.DURABLE_ACK || type===FrameType.UPDATE_COMMITTED)successes++;});
    sender.send(original);await after.stage;
    assert.equal(successes,0,'Commit barrier precedes broadcast and ACK');
    assert.equal((await pool.query('SELECT last_committed_sequence::text AS n FROM documents WHERE id=$1',[scope.document_id])).rows[0].n,'1');
    await kill(after.process);sender.terminate();observer.terminate();
    // This takeover uses actual DB-clock expiration, not a simulated clock.
    await wait(16000);
    const snap=child('after-snapshot');children.push(snap.process);const port=await snap.port;const socket=await connect(port,scope);
    const replayed=await submitted(socket,original);assert.equal(new DataView(replayed.buffer,replayed.byteOffset).getBigUint64(0),1n);
    assert.deepEqual(await sync(socket),{text:'durable',sequence:1n});
    const local=new Y.Doc();let update:Uint8Array=new Uint8Array();local.on('update',value => {update=value;});
    for(let i=1;i<100;i++) {local.getText('content').insert(local.getText('content').length,'x');await submitted(socket,mutation(update));}
    await snap.stage;
    const saved=(await pool.query('SELECT through_sequence::text AS seq,encoded_state,checksum FROM document_snapshots WHERE document_id=$1 ORDER BY through_sequence DESC LIMIT 1',[scope.document_id])).rows[0];
    assert.equal(saved.seq,'100');assert.ok(hash(saved.encoded_state).equals(saved.checksum));
    await kill(snap.process);socket.terminate();await expire(pool,scope);
    const tail=child();children.push(tail.process);const tailSocket=await connect(await tail.port,scope);
    local.getText('content').insert(local.getText('content').length,'tail');await submitted(tailSocket,mutation(update));
    const expected=(await sync(tailSocket)).text;assert.equal(expected.length,110);assert.ok(expected.includes('durable'));assert.ok(expected.includes('x'.repeat(99)+'tail'));
    await kill(tail.process);tailSocket.terminate();await expire(pool,scope);
    const restart=child();children.push(restart.process);const recovered=await connect(await restart.port,scope);
    assert.deepEqual(await sync(recovered),{text:expected,sequence:101n});
    await kill(restart.process);recovered.terminate();local.destroy();

    const renewingScope=await fixture(pool);const renewing=child('renewal');children.push(renewing.process);const renewingSocket=await connect(await renewing.port,renewingScope);
    await renewing.stage;const old=(await pool.query('SELECT worker_id::text,fencing_token::text AS fence FROM document_owners WHERE document_id=$1',[renewingScope.document_id])).rows[0];
    await kill(renewing.process);renewingSocket.terminate();await expire(pool,renewingScope);
    const replacement=new DocumentStore(workerURL!,randomUUID());const stale=new DocumentStore(workerURL!,old.worker_id);
    try {
      const newer=await replacement.acquire(renewingScope.document_id);assert.ok(newer>BigInt(old.fence));
      const bytes=changes('stale');await assert.rejects(stale.append(renewingScope,BigInt(old.fence),0n,randomUUID(),randomUUID(),hash(bytes),bytes,5),/ROOM_MOVED/);
    } finally {await replacement.pool.end();await stale.pool.end();}
  } finally {
    await barrier.query('SELECT pg_advisory_unlock(73004,1)').catch(() => {});barrier.release();
    await pool.query(`DROP TRIGGER IF EXISTS ${trigger} ON document_updates`).catch(() => {});await pool.query(`DROP FUNCTION IF EXISTS ${trigger}()`).catch(() => {});
    for(const process of children) if(process.exitCode===null && process.signalCode===null) await kill(process);
    await pool.end();
  }
});

test("append policy, quotas, expected head, least privilege and corrupt snapshot fail closed",{skip:!adminURL},async () => {
  const pool=new Pool({connectionString:adminURL});const scope=await fixture(pool);const store=new DocumentStore(workerURL!,randomUUID());
  try {
    const fence=await store.acquire(scope.document_id);const bytes=changes('saved');const instance=randomUUID();const id=randomUUID();
    const append=(head=0n)=>store.append(scope,fence,head,instance,id,hash(bytes),bytes,5);
    assert.equal(await append(),1n);assert.equal(await append(),1n);
    const conflict=changes('different');await assert.rejects(store.append(scope,fence,1n,instance,id,hash(conflict),conflict,14),/RECEIPT_MISMATCH/);
    const different=changes('other');await assert.rejects(store.append(scope,fence,0n,randomUUID(),randomUUID(),hash(different),different,10),/HEAD_CHANGED/);
    await assert.rejects(store.pool.query("UPDATE documents SET last_committed_sequence=50 WHERE id=$1",[scope.document_id]),/permission denied/);
    await assert.rejects(store.pool.query('SELECT token_hash FROM sessions'),/permission denied/);
    assert.equal((await pool.query('SELECT source_bytes_limit::text AS size FROM projects WHERE id=$1',[scope.project_id])).rows[0].size,'10485760');
    const peerTx=await pool.connect();let peerFile:string;
    const peerState=new Y.Doc();peerState.getText('content').insert(0,'peer');const peerBytes=Y.encodeStateAsUpdate(peerState);
    try {
      await peerTx.query('BEGIN');
      peerFile=(await peerTx.query("INSERT INTO files(project_id,name,kind,language) VALUES($1,'peer.js','file','javascript') RETURNING id::text",[scope.project_id])).rows[0].id as string;
      const peerDocument=(await peerTx.query('INSERT INTO documents(file_id,generation,committed_text_bytes) VALUES($1,1,4) RETURNING id',[peerFile])).rows[0].id;
      await peerTx.query('UPDATE files SET current_document_id=$1 WHERE id=$2',[peerDocument,peerFile]);
      await peerTx.query('INSERT INTO document_snapshots(document_id,through_sequence,encoded_state,state_vector,checksum) VALUES($1,0,$2,$3,$4)',[peerDocument,Buffer.from(peerBytes),Buffer.from(Y.encodeStateVector(peerState)),hash(peerBytes)]);
      await peerTx.query('COMMIT');
    } catch(error) {await peerTx.query('ROLLBACK');throw error;} finally {peerTx.release();peerState.destroy();}
    await pool.query('UPDATE projects SET source_bytes_limit=10 WHERE id=$1',[scope.project_id]);
    await assert.rejects(store.append(scope,fence,1n,randomUUID(),randomUUID(),hash(different),different,10),/LIMIT_EXCEEDED/,'Combined active source would be 14 bytes');
    await pool.query('UPDATE files SET tombstoned_at=clock_timestamp() WHERE id=$1',[peerFile]);
    assert.equal(await store.append(scope,fence,1n,randomUUID(),randomUUID(),hash(different),different,10),2n,'Deleted source frees the active budget');
    assert.equal((await pool.query('SELECT committed_text_bytes FROM documents WHERE id=$1',[scope.document_id])).rows[0].committed_text_bytes,10);
    await pool.query('UPDATE projects SET durable_log_limit=durable_log_bytes WHERE id=$1',[scope.project_id]);
    await assert.rejects(store.append(scope,fence,2n,randomUUID(),randomUUID(),hash(different),different,10),/LIMIT_EXCEEDED/);
    assert.equal((await store.hydrate(scope.document_id)).sequence,2n);
    await store.snapshot(scope.document_id,fence,await store.hydrate(scope.document_id));
    await pool.query("UPDATE document_snapshots SET encoded_state='\\x0101'::bytea WHERE document_id=$1 AND through_sequence=2",[scope.document_id]);
    await assert.rejects(store.hydrate(scope.document_id),/STORAGE_UNAVAILABLE/);
    await assert.rejects(store.append({...scope,generation:'2'},fence,1n,randomUUID(),randomUUID(),hash(different),different,10),/STALE_GENERATION/);
    const tx=await pool.connect();
    try {
      await tx.query('BEGIN');await tx.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE',[scope.project_id]);
      const newDocument=(await tx.query('INSERT INTO documents(file_id,generation) VALUES($1,2) RETURNING id',[scope.file_id])).rows[0].id;
      await tx.query('UPDATE files SET generation=2,current_document_id=$1 WHERE id=$2',[newDocument,scope.file_id]);await tx.query('COMMIT');
    } catch(error) {await tx.query('ROLLBACK');throw error;} finally {tx.release();}
    await assert.rejects(append(),/STALE_GENERATION/);
    await pool.query('UPDATE files SET tombstoned_at=clock_timestamp() WHERE id=$1',[scope.file_id]);
    await assert.rejects(append(),/STALE_GENERATION/);
    await pool.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE id=$1',[scope.sid]);await assert.rejects(append(),/AUTH_REQUIRED/);
  } finally {await store.pool.end();await pool.end();}
});

test("lost commit response resolves the original receipt and hydrates before ACK",{skip:!adminURL},async () => {
  class LostResponse extends DocumentStore {
    override async append(...args:Parameters<DocumentStore['append']>):Promise<bigint> {await super.append(...args);throw new Error('connection lost after commit');}
  }
  const pool=new Pool({connectionString:adminURL});const scope=await fixture(pool);const store=new LostResponse(workerURL!,randomUUID());
  const server=createServer();const service=attachRealtime(server,workerURL!,secret,store);server.listen(0,'127.0.0.1');await once(server,'listening');
  let socket:Awaited<ReturnType<typeof connect>>|undefined;
  try {
    socket=await connect((server.address() as {port:number}).port,scope);
    const bytes=mutation(changes('resolved'));const first=await submitted(socket,bytes);const duplicate=await submitted(socket,bytes);
    assert.deepEqual(first,duplicate);assert.deepEqual(await sync(socket),{text:'resolved',sequence:1n});
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM document_updates WHERE document_id=$1',[scope.document_id])).rows[0].n,1);
  } finally {socket?.terminate();await service.close();await new Promise<void>(resolve=>server.close(()=>resolve()));await pool.end();}
});

test("revocation serializes with append through a database barrier",{skip:!adminURL},async () => {
  const pool=new Pool({connectionString:adminURL});const scope=await fixture(pool);const store=new DocumentStore(workerURL!,randomUUID());const barrier=await pool.connect();
  try {
    const fence=await store.acquire(scope.document_id);
    const actor=(await pool.query("INSERT INTO users(provider,provider_subject,display_name) VALUES('github',$1,'Editor') RETURNING id::text",[randomUUID()])).rows[0].id as string;
    const sid=(await pool.query("INSERT INTO sessions(user_id,token_hash,csrf_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 hour') RETURNING id::text",[actor,randomBytes(32),randomBytes(32)])).rows[0].id as string;
    await pool.query("INSERT INTO project_members(project_id,user_id,role) VALUES($1,$2,'editor')",[scope.project_id,actor]);
    const editor={...scope,sub:actor,sid};const bytes=changes('revoked');
    const ownerBytes=changes('owner');const instance=randomUUID();const identity=randomUUID();
    await store.append(scope,fence,0n,instance,identity,hash(ownerBytes),ownerBytes,5);
    await assert.rejects(store.receipt(editor,fence,instance,identity,hash(ownerBytes)),/RECEIPT_MISMATCH/);
    await barrier.query('BEGIN');await barrier.query('SELECT 1 FROM projects WHERE id=$1 FOR UPDATE',[scope.project_id]);
    await barrier.query("UPDATE project_members SET role='viewer' WHERE project_id=$1 AND user_id=$2",[scope.project_id,actor]);
    const attempt=store.append(editor,fence,1n,randomUUID(),randomUUID(),hash(bytes),bytes,5);
    const denied=assert.rejects(attempt,/FORBIDDEN/);
    await until(async()=>!!(await pool.query("SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'SELECT cce_append_document%'")).rowCount);
    await barrier.query('COMMIT');await denied;
    await assert.rejects(store.receipt(editor,fence,randomUUID(),randomUUID(),hash(bytes)),/FORBIDDEN/);
    assert.equal((await pool.query('SELECT last_committed_sequence::text AS head FROM documents WHERE id=$1',[scope.document_id])).rows[0].head,'1');
  } finally {await barrier.query('ROLLBACK');barrier.release();await store.pool.end();await pool.end();}
});

test("database connection death leaves no ACK or peer broadcast and a healthy room still saves",{skip:!adminURL,timeout:20000},async () => {
  const pool=new Pool({connectionString:adminURL});const scope=await fixture(pool);const store=new DocumentStore(workerURL!,randomUUID());
  const server=createServer();const service=attachRealtime(server,workerURL!,secret,store);server.listen(0,'127.0.0.1');await once(server,'listening');
  const port=(server.address() as {port:number}).port;const barrier=await pool.connect();
  const trigger='phase04_storage_'+randomUUID().replaceAll('-','');const sockets:Awaited<ReturnType<typeof connect>>[]=[];
  try {
    await pool.query(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.document_id::text=TG_ARGV[0] THEN PERFORM pg_advisory_xact_lock(73004,2); END IF; RETURN NEW; END $$`);
    await pool.query(`CREATE TRIGGER ${trigger} BEFORE INSERT ON document_updates FOR EACH ROW EXECUTE FUNCTION ${trigger}('${scope.document_id}')`);
    await barrier.query('SELECT pg_advisory_lock(73004,2)');
    const writer=await connect(port,scope);const observer=await connect(port,scope);sockets.push(writer,observer);
    let success=0;for(const socket of sockets) socket.on('message',raw => {const type=decodeEnvelope(raw as Buffer,'server').type;if(type===FrameType.DURABLE_ACK || type===FrameType.UPDATE_COMMITTED)success++;});
    const rejected=frame(writer,FrameType.ERROR);writer.send(mutation(changes('unsaved')));
    await until(async()=>!!(await pool.query("SELECT 1 FROM pg_stat_activity WHERE wait_event='advisory' AND query LIKE 'SELECT cce_append_document%'")).rowCount);
    await pool.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE wait_event='advisory' AND query LIKE 'SELECT cce_append_document%'");
    const error=JSON.parse(Buffer.from(await rejected).toString()) as {code:string};assert.equal(error.code,'STORAGE_UNAVAILABLE');assert.equal(success,0);
    assert.equal((await pool.query('SELECT last_committed_sequence::text AS n FROM documents WHERE id=$1',[scope.document_id])).rows[0].n,'0');
    await barrier.query('SELECT pg_advisory_unlock(73004,2)');
    const healthyScope=await fixture(pool);const healthy=await connect(port,healthyScope);sockets.push(healthy);
    await submitted(healthy,mutation(changes('healthy')));assert.deepEqual(await sync(healthy),{text:'healthy',sequence:1n});
  } finally {
    await barrier.query('SELECT pg_advisory_unlock(73004,2)').catch(()=>{});barrier.release();
    await pool.query(`DROP TRIGGER IF EXISTS ${trigger} ON document_updates`).catch(()=>{});await pool.query(`DROP FUNCTION IF EXISTS ${trigger}()`).catch(()=>{});
    for(const socket of sockets)socket.terminate();await service.close();await new Promise<void>(resolve=>server.close(()=>resolve()));await pool.end();
  }
});
