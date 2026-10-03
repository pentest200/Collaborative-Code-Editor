import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { WebSocket } from "ws";
import * as Y from "yjs";
import { encodeEnvelope, decodeEnvelope, FrameType } from "@cce/protocol";
import type { DocumentScope } from "../persistence.js";

export const secret="test-only-phase04-internal-assertion-key";
export async function fixture(pool: Pool): Promise<DocumentScope> {
  const sub=(await pool.query("INSERT INTO users(provider,provider_subject,display_name) VALUES('github',$1,'Durability test') RETURNING id::text",[randomUUID()])).rows[0].id as string;
  const sid=(await pool.query("INSERT INTO sessions(user_id,token_hash,csrf_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 hour') RETURNING id::text",[sub,randomBytes(32),randomBytes(32)])).rows[0].id as string;
  const tx=await pool.connect();
  try {
    await tx.query("BEGIN");
    const project=(await tx.query("INSERT INTO projects(owner_id,name) VALUES($1,'Phase 04 fixture') RETURNING id::text",[sub])).rows[0].id as string;
    await tx.query("INSERT INTO project_members(project_id,user_id,role) VALUES($1,$2,'owner')",[project,sub]);
    const file=(await tx.query("INSERT INTO files(project_id,name,kind,language) VALUES($1,'main.js','file','javascript') RETURNING id::text",[project])).rows[0].id as string;
    const document=(await tx.query("INSERT INTO documents(file_id,generation) VALUES($1,1) RETURNING id::text",[file])).rows[0].id as string;
    await tx.query("UPDATE files SET current_document_id=$1 WHERE id=$2",[document,file]);
    await tx.query("INSERT INTO document_snapshots(document_id,through_sequence,encoded_state,state_vector,checksum) VALUES($1,0,$2,$3,$4)",[document,Buffer.from([0,0]),Buffer.from([0]),createHash('sha256').update(Buffer.from([0,0])).digest()]);
    await tx.query("COMMIT");
    return {sub,sid,project_id:project,file_id:file,document_id:document,generation:'1'};
  } catch(error) { await tx.query("ROLLBACK"); throw error; } finally {tx.release();}
}
export function mutation(update: Uint8Array, instance=randomUUID(), message=randomUUID()) {
  const body=Buffer.alloc(64+update.length);
  Buffer.from(instance.replaceAll('-',''),'hex').copy(body); Buffer.from(message.replaceAll('-',''),'hex').copy(body,16);
  createHash('sha256').update(update).digest().copy(body,32); Buffer.from(update).copy(body,64);
  return encodeEnvelope(FrameType.DURABLE_UPDATE,body);
}
export function frame(socket: WebSocket, type: FrameType): Promise<Uint8Array> {
  return new Promise((resolve,reject) => {
    const timer=setTimeout(() => {socket.off('message',receive); reject(new Error('Frame timeout '+type));},10000);
    const receive=(raw: Buffer) => { const value=decodeEnvelope(raw,'server'); if(value.type===type) {clearTimeout(timer);socket.off('message',receive);resolve(value.body);} };
    socket.on('message',receive);
  });
}
export async function connect(port: number, scope: DocumentScope, role='owner'): Promise<WebSocket> {
  const claims={...scope,iss:'cce-api',aud:'cce-collab',role,connection_id:randomBytes(32).toString('base64url'),iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+25};
  const header=Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url'); const body=Buffer.from(JSON.stringify(claims)).toString('base64url');
  const token=header+'.'+body+'.'+createHmac('sha256',secret).update(header+'.'+body).digest('base64url');
  const socket=new WebSocket(`ws://127.0.0.1:${port}/internal/ws/documents/${scope.document_id}`,{headers:{Authorization:'Bearer '+token}});
  socket.on('error',() => {});
  await new Promise<void>((resolve,reject) => {socket.once('open',resolve);socket.once('error',reject);}); return socket;
}
export async function sync(socket: WebSocket): Promise<{text:string;sequence:bigint}> {
  const received=frame(socket,FrameType.SYNC_STATE);socket.send(encodeEnvelope(FrameType.SYNC_REQUEST,Buffer.from([0])));
  const body=await received; const view=new DataView(body.buffer,body.byteOffset,body.byteLength); const len=view.getUint32(8);
  const doc=new Y.Doc();doc.getText('content');Y.applyUpdate(doc,body.subarray(16+len));
  const text=doc.getText('content').toString();doc.destroy();return {text,sequence:view.getBigUint64(0)};
}
export function changes(text: string): Uint8Array {
  const doc=new Y.Doc();doc.getText('content').insert(0,text);const bytes=Y.encodeStateAsUpdate(doc);doc.destroy();return bytes;
}
