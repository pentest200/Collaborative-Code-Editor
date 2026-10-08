const reportDir = process.env.CCE_REPORT_DIR ?? "docs/measurements";
// Designated local acceptance stack only. Seeded, bounded real Go/TS/PostgreSQL
// workload; independent sessions; no OAuth bypass endpoint or production fault API.
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { cpus, totalmem, platform, release } from "node:os";
import { execFileSync } from "node:child_process";
import { Pool } from "pg";
import { WebSocket } from "ws";
import * as Y from "yjs";
import { decodeEnvelope, encodeEnvelope, FrameType } from "@cce/protocol";

export const origin=process.env.CCE_E2E_ORIGIN ?? "http://localhost:3000";
export const sha=bytes=>createHash("sha256").update(bytes).digest();
const bytes=id=>Buffer.from(id.replaceAll("-",""),"hex");
const uuid=b=>{const h=Buffer.from(b).toString("hex");return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;};
export const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export async function until(check,message,timeout=60000){const start=Date.now();while(!await check()){if(Date.now()-start>timeout)throw new Error(message);await sleep(40);}}
export function summary(values){const sorted=[...values].sort((a,b)=>a-b);const at=p=>sorted[Math.max(0,Math.ceil(sorted.length*p)-1)]??null;return {samples:values.length,p50:at(.5),p95:at(.95),max:sorted.at(-1)??null};}
export function rng(seed){let value=seed>>>0;return ()=>{value^=value<<13;value^=value>>>17;value^=value<<5;return (value>>>0)/4294967296;};}

export async function fixture(pool,count,documents,size=1024,source){
 const users=[];for(let n=0;n<count;n++){
  const id=(await pool.query("INSERT INTO users(provider,provider_subject,display_name) VALUES('github',$1,$2) RETURNING id::text",[randomUUID(),`Measured editor ${n}`])).rows[0].id;
  const token=randomBytes(32).toString("base64url"),csrf=sha("cce-csrf-v1:"+token).toString("base64url");
  await pool.query("INSERT INTO sessions(user_id,token_hash,csrf_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')",[id,sha(token),sha(csrf)]);users.push({id,token,csrf});
 }
 const tx=await pool.connect();const files=[];let project;
 try {await tx.query("BEGIN");project=(await tx.query("INSERT INTO projects(owner_id,name) VALUES($1,'Measured local fixture') RETURNING id::text",[users[0].id])).rows[0].id;
  for(const [i,user] of users.entries())await tx.query("INSERT INTO project_members(project_id,user_id,role) VALUES($1,$2,$3)",[project,user.id,i===0?"owner":"editor"]);
  for(let n=0;n<documents;n++){
   const doc=new Y.Doc();doc.getText("content").insert(0,source??"x".repeat(size));const state=Y.encodeStateAsUpdate(doc),vector=Y.encodeStateVector(doc);
   const file=(await tx.query("INSERT INTO files(project_id,name,kind,language) VALUES($1,$2,'file','javascript') RETURNING id::text",[project,`file${n}.js`])).rows[0].id;
   const document=(await tx.query("INSERT INTO documents(file_id,generation,committed_text_bytes) VALUES($1,1,$2) RETURNING id::text",[file,Buffer.byteLength(doc.getText("content").toString())])).rows[0].id;
   const snapshot=(await tx.query("INSERT INTO document_snapshots(document_id,through_sequence,encoded_state,state_vector,checksum) VALUES($1,0,$2,$3,$4) RETURNING id",[document,state,vector,sha(state)])).rows[0].id;
   await tx.query("UPDATE documents SET snapshot_id=$2 WHERE id=$1",[document,snapshot]);await tx.query("UPDATE files SET current_document_id=$2 WHERE id=$1",[file,document]);files.push({file,document,state});doc.destroy();
  }await tx.query("COMMIT");
 }catch(error){await tx.query("ROLLBACK");throw error;}finally{tx.release();}
 return {users,project,files};
}

export class Client {
 constructor(user,file,all,stats){this.user=user;this.file=file;this.all=all;this.stats=stats;this.doc=new Y.Doc();this.doc.getText("content");this.instance=randomUUID();this.pending=new Map();this.receipts=new Map();this.ackFrames=0;this.synced=false;this.socket=null;this.fatal=null;}
 async connect(){
  if(this.socket?.readyState===WebSocket.OPEN)return;
  const start=performance.now();this.synced=false;const socket=new WebSocket(`${origin.replace(/^http/,"ws")}/ws/documents/${this.file.document}`,{headers:{Cookie:`cce_session=${this.user.token}`,Origin:origin},family:4});this.socket=socket;
  socket.on("error",()=>{});socket.on("close",()=>{if(this.socket===socket){this.synced=false;this.socket=null;}});
  socket.on("open",()=>socket.send(encodeEnvelope(FrameType.SYNC_REQUEST,Y.encodeStateVector(this.doc))));
  socket.on("message",raw=>{
   try {const {type,body}=decodeEnvelope(raw,"server");
    if(type===FrameType.SYNC_STATE){const length=new DataView(body.buffer,body.byteOffset).getUint32(8);Y.applyUpdate(this.doc,body.subarray(16+length));this.synced=true;this.stats.sync.push(performance.now()-start);}
    if(type===FrameType.UPDATE_COMMITTED){Y.applyUpdate(this.doc,body.subarray(72));const key=uuid(body.subarray(24,40));const sent=this.all.sent.get(key);if(sent?.targets.has(this)){this.stats.peer.push(performance.now()-sent.at);sent.targets.delete(this);}}
    if(type===FrameType.DURABLE_ACK){this.ackFrames++;const key=uuid(body.subarray(24,40));const prior=this.receipts.get(key),sequence=new DataView(body.buffer,body.byteOffset).getBigUint64(0);if(prior!==undefined)assert.equal(sequence,prior);this.receipts.set(key,sequence);const entry=this.pending.get(key);if(entry){assert.ok(sha(entry.update).equals(Buffer.from(body.subarray(40,72))));this.stats.ack.push(performance.now()-entry.firstSent);this.pending.delete(key);this.stats.acked++;}}
    if(type===FrameType.ERROR){const code=JSON.parse(new TextDecoder().decode(body)).code;this.stats.rejected[code]=(this.stats.rejected[code]??0)+1;if(!["RATE_LIMITED","ROOM_MOVED","STORAGE_UNAVAILABLE","HEAD_CHANGED"].includes(code))throw new Error(`Unexpected rejection ${code}`);}
   }catch(error){this.fatal=error;socket.terminate();}
  });
  await until(()=>this.synced||this.fatal,"Document did not synchronize",15000);if(this.fatal)throw this.fatal;
 }
 edit(position,text,remove=0){let update;const listener=bytes=>{update=bytes;};this.doc.on("update",listener);this.doc.transact(()=>{const content=this.doc.getText("content");if(remove)content.delete(position,Math.min(remove,content.length-position));if(text)content.insert(position,text);});this.doc.off("update",listener);if(!update)return;
  const message=randomUUID(),body=Buffer.concat([bytes(this.instance),bytes(message),sha(update),update]);this.pending.set(message,{message,update,body,firstSent:0});this.stats.generated++;return message;
 }
 send(message){const entry=this.pending.get(message);if(!entry||!this.synced||this.socket?.readyState!==WebSocket.OPEN)return;const now=performance.now();if(!entry.firstSent)entry.firstSent=now;this.all.sent.set(message,{at:now,targets:new Set(this.all.clients.filter(c=>c!==this&&c.synced&&c.file.document===this.file.document))});this.socket.send(encodeEnvelope(FrameType.DURABLE_UPDATE,entry.body));}
 async drain(){for(const message of this.pending.keys()){if(!this.synced)await this.connect();this.send(message);await until(()=>!this.pending.has(message)||!this.synced||this.fatal,"Receipt missing",10000);if(this.fatal)throw this.fatal;if(this.pending.has(message))return this.drain();}}
 disconnect(){const socket=this.socket;this.socket=null;this.synced=false;socket?.terminate();}
}

export async function verify(pool,data,clients,stats){
 await Promise.all(clients.map(c=>c.drain()));await until(()=>data.files.every(file=>{const values=clients.filter(c=>c.file.document===file.document).map(c=>c.doc.getText("content").toString());return values.every(v=>v===values[0]);}),"Replicas failed to converge");
 let count=0;const hashes=[];for(const file of data.files){
  const doc=new Y.Doc();Y.applyUpdate(doc,file.state);const rows=(await pool.query("SELECT sequence::text,client_instance_id::text,message_id::text,update_bytes,update_hash FROM document_updates WHERE document_id=$1 ORDER BY document_updates.sequence",[file.document])).rows;
  rows.forEach((row,i)=>{assert.equal(row.sequence,String(i+1));assert.ok(sha(row.update_bytes).equals(row.update_hash));Y.applyUpdate(doc,row.update_bytes);const sender=clients.find(c=>c.instance===row.client_instance_id);assert.ok(sender);assert.equal(sender.receipts.get(row.message_id),BigInt(row.sequence));});count+=rows.length;
  for(const client of clients.filter(c=>c.file.document===file.document))assert.equal(client.doc.getText("content").toString(),doc.getText("content").toString());
  hashes.push(sha(doc.getText("content").toString()).toString("hex"));doc.destroy();
 }assert.equal(count,stats.generated);assert.equal(stats.acked,stats.generated);return {durableRows:count,contiguous:true,replicasEqualDatabase:true,contentHashes:hashes};
}

async function memorySamples(start,end){
 const result={};
 for(const [name,query] of [["collabRss","cce_process_resident_memory_bytes{service=\"collab\"}"],["apiRss","process_resident_memory_bytes{service=\"api\"}"],["rooms","cce_rooms{service=\"collab\"}"],["connections","cce_connections{service=\"collab\"}"],["ownershipCumulative","cce_ownership_total{service=\"collab\"}"],["roomQueueItems","cce_room_queue_items{service=\"collab\"}"],["roomQueueBytes","cce_room_queue_bytes{service=\"collab\"}"],["roomStateBytes","cce_room_state_bytes{service=\"collab\"}"],["storageBytes","cce_storage_bytes{service=\"api\"}"],["jobsBacklog","cce_job_queue_items{service=\"jobs\"}"]]){
  const params=new URLSearchParams({query,start:String(start),end:String(end),step:"1"});const response=await fetch("http://127.0.0.1:9090/api/v1/query_range?"+params);assert.ok(response.ok,"Metrics backend is required for measured load");const body=await response.json();result[name]=body.data.result.map(series=>({labels:series.metric,values:summary(series.values.map(v=>Number(v[1])))}));
 }return result;
}
async function histogramSnapshot(){
 const response=await fetch("http://127.0.0.1:9090/api/v1/query?query="+encodeURIComponent('{__name__=~"cce_operation_seconds_(bucket|sum|count)|cce_candidate_heap_bytes_(bucket|sum|count)",service="collab"}'));
 assert.ok(response.ok);const body=await response.json();assert.equal(body.status,"success");
 return new Map(body.data.result.map(row=>[JSON.stringify(row.metric),{metric:row.metric,value:Number(row.value[1])}]));
}
function histogramChanges(before,after){
 const groups=new Map();for(const [key,row] of after){const metric=row.metric,name=metric.__name__.replace(/_(bucket|sum|count)$/,"");const groupKey=JSON.stringify({name,operation:metric.operation??"candidate.heap",outcome:metric.outcome??"ok"});const group=groups.get(groupKey)??{...JSON.parse(groupKey),count:0,sum:0,buckets:[]};const delta=row.value-(before.get(key)?.value??0);assert.ok(delta>=0,"Metrics process reset during measured workload");if(metric.__name__.endsWith("_bucket"))group.buckets.push({upper:Number(metric.le),count:delta});else if(metric.__name__.endsWith("_count"))group.count=delta;else group.sum=delta;groups.set(groupKey,group);}
 return [...groups.values()].filter(g=>g.count>0).map(g=>{g.buckets.sort((a,b)=>a.upper-b.upper);const bound=q=>{const b=g.buckets.find(b=>b.count>=g.count*q);return Number.isFinite(b?.upper)?b.upper:null;};return {name:g.name,operation:g.operation,outcome:g.outcome,count:g.count,mean:g.sum/g.count,p50BucketUpper:bound(.5),p95BucketUpper:bound(.95),unit:g.name.endsWith("bytes")?"bytes":"seconds"};});
}
async function workload(pool,{editors,documents,seconds,seed,size,faults=false}){
 const random=rng(seed),data=await fixture(pool,editors,documents,size);const stats={sync:[],ack:[],peer:[],rejected:{},generated:0,acked:0};const all={sent:new Map(),clients:[]};all.clients=data.users.map((user,i)=>new Client(user,data.files[i%documents],all,stats));
 const clients=all.clients;await sleep(5500);const histogramBefore=await histogramSnapshot();const start=performance.now(),startEpoch=Date.now()/1000;const rss=[];const memoryTimer=setInterval(()=>rss.push(process.memoryUsage().rss),250);const baseline=(await pool.query("SELECT durable_log_bytes::text FROM projects WHERE id=$1",[data.project])).rows[0];
 try {
  // Admission is staggered to respect the explicit four-room hydration bound.
  for(const client of clients)await client.connect();
  const started=performance.now();let round=0;
  while(performance.now()-started<seconds*1000){
   for(const [i,client] of clients.entries()){
    const text=client.doc.getText("content"),position=round%3===0?0:Math.floor(random()*(text.length+1));
    const key=client.edit(position,String.fromCharCode(97+i%26),text.length>0&&random()<.35?1:0);if(key)client.send(key);
   }round++;await sleep(1000);
  }
  await verify(pool,data,clients,stats);
  const faultEvidence=[];
  if(faults){
   const offline=clients[0];offline.disconnect();offline.edit(0,"offline");clients[1].send(clients[1].edit(0,"peer"));await clients[1].drain();await offline.connect();await offline.drain();await verify(pool,data,clients,stats);faultEvidence.push("offline local edit with peer edit, original identified replay and convergence");
   clients[0].socket._socket.pause();for(let n=0;n<3;n++){clients[1].send(clients[1].edit(0,"slow"));await sleep(250);}await clients[1].drain();await sleep(500);clients[0].socket._socket.resume();await verify(pool,data,clients,stats);faultEvidence.push("1.25s paused TCP reader catches up; send ceiling saturation not established");
   // Bounded burst exceeds client/room admission; retain/retry every rejected ID.
   for(let n=0;n<120;n++)clients[0].send(clients[0].edit(0,"b"));await sleep(12000);
   for(const client of clients){client.disconnect();await client.connect();await client.drain();}await verify(pool,data,clients,stats);assert.ok(Object.values(stats.rejected).reduce((a,b)=>a+b,0)>0);faultEvidence.push("120-frame burst counts rejection/backpressure and retries retained identities");
   const entry=[...all.sent.keys()][0],sender=clients.find(c=>c.receipts.has(entry));const row=(await pool.query("SELECT update_bytes FROM document_updates WHERE message_id=$1",[entry])).rows[0];const prior=sender.receipts.get(entry);
   const duplicate=Buffer.concat([bytes(sender.instance),bytes(entry),sha(row.update_bytes),row.update_bytes]);const before=(await pool.query("SELECT count(*)::int AS n FROM document_updates WHERE document_id=$1",[sender.file.document])).rows[0].n;const ackFrames=sender.ackFrames;sender.socket.send(encodeEnvelope(FrameType.DURABLE_UPDATE,duplicate));await until(()=>sender.ackFrames>ackFrames,"Duplicate receipt missing");assert.equal(sender.receipts.get(entry),prior);assert.equal((await pool.query("SELECT count(*)::int AS n FROM document_updates WHERE document_id=$1",[sender.file.document])).rows[0].n,before);faultEvidence.push("duplicate returns original sequence with no extra row");
  }
  const correctness=await verify(pool,data,clients,stats);const final=(await pool.query("SELECT durable_log_bytes::text FROM projects WHERE id=$1",[data.project])).rows[0];
  await sleep(5500);const processMemory=await memorySamples(startEpoch,Date.now()/1000);const operationHistogramDeltas=histogramChanges(histogramBefore,await histogramSnapshot());
  return {clientRssBytes:summary(rss),serviceMemory:processMemory,operationHistogramDeltas,histogramDefinition:"Differences of scraped cumulative histograms; p50/p95 are bucket upper bounds, null means +Inf. Shared service activity can contribute; not exact per-operation samples.",seed,editors,documents,initialFileBytes:size,typingMessagesPerSecondPerEditor:1,durationSeconds:(performance.now()-start)/1000,steadyTypingDurationSeconds:seconds,generated:stats.generated,acknowledged:stats.acked,rejected:stats.rejected,unresolved:clients.reduce((n,c)=>n+c.pending.size,0),syncMs:summary(stats.sync),durableAckMs:summary(stats.ack),peerPropagationMs:summary(stats.peer),payloadGrowthBytes:Number(final.durable_log_bytes)-Number(baseline.durable_log_bytes),correctness,faultEvidence};
 }finally{clearInterval(memoryTimer);for(const client of clients){client.disconnect();client.doc.destroy();}await pool.query("UPDATE sessions SET revoked_at=clock_timestamp() WHERE user_id=ANY($1::uuid[])",[data.users.map(u=>u.id)]);}
}

async function main(){
 assert.ok(process.env.TEST_DATABASE_URL,"TEST_DATABASE_URL required; load checks never silently skip");assert.equal(process.env.CCE_LOAD_TESTS,"1","Set CCE_LOAD_TESTS=1 only on the designated local stack");
 const pool=new Pool({connectionString:process.env.TEST_DATABASE_URL,max:4});
 const report={date:new Date().toISOString(),toolchains:{node:process.version,npm:execFileSync("npm.cmd",["--version"],{shell:true,encoding:"utf8"}).trim(),yjs:"13.6.27"},host:{os:platform(),release:release(),cpu:cpus()[0]?.model,logicalCPUs:cpus().length,ramBytes:totalmem()},topology:"Windows raw clients -> localhost Caddy -> Go -> one TS worker -> PostgreSQL in Docker Desktop; loopback, not WAN",scenarios:[],status:"running"};
 try{report.database=(await pool.query("SELECT version() AS version")).rows[0].version;report.scenarios.push(await workload(pool,{editors:5,documents:1,seconds:8,seed:90901,size:1024,faults:true}));report.scenarios.push(await workload(pool,{editors:12,documents:4,seconds:8,seed:90902,size:8192}));report.status="passed";}
 catch(error){report.status="failed";report.failure=error.message;throw error;}
 finally{mkdirSync(reportDir,{recursive:true});writeFileSync(`${reportDir}/phase09-load.json`,JSON.stringify(report,null,2)+"\n");await pool.end();}
 console.log(JSON.stringify(report.scenarios.map(s=>({editors:s.editors,documents:s.documents,ack:s.durableAckMs,peer:s.peerPropagationMs,rejected:s.rejected,correctness:s.correctness.replicasEqualDatabase})),null,2));
}
if(process.argv[1]?.endsWith("workload.mjs"))await main();
