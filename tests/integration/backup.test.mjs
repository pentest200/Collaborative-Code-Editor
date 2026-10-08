const reportDir = process.env.CCE_REPORT_DIR ?? "docs/measurements";
// Recovery drill uses only newly named scratch containers/volumes. The source
// database/volumes are never reset. Dumps contain private data and stay in .tmp.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { Pool } from "pg";
import * as Y from "yjs";
import { fixture, until, origin, sha, sleep, Client } from "../load/workload.mjs";

const docker=(...args)=>execFileSync("docker",args,{encoding:"utf8",maxBuffer:8<<20,stdio:["ignore","pipe","pipe"]}).trim();
const compose=(...args)=>docker("compose","-f","infra/compose/compose.yaml",...args);
test("Phase 09 isolated PostgreSQL and cold MinIO backup recovery, exact replay and restored generation",{timeout:180000},async()=>{
 assert.ok(process.env.TEST_DATABASE_URL,"TEST_DATABASE_URL required");assert.equal(process.env.CCE_BACKUP_TESTS,"1","Designated local backup drill opt-in required");
 const pool=new Pool({connectionString:process.env.TEST_DATABASE_URL});const data=await fixture(pool,1,1,1024,"// Backup fixture\n");const user=data.users[0],file=data.files[0];
 const base=`/api/v1/projects/${data.project}`;
 const request=async(host,path,method="GET",body,version)=>fetch(host+path,{method,headers:{Cookie:`cce_session=${user.token}`,Origin:origin,"Content-Type":"application/json","X-CSRF-Token":user.csrf,...(version?{"If-Match":version}:{})},body:body?JSON.stringify(body):undefined});
 const stats={sync:[],ack:[],peer:[],rejected:{},generated:0,acked:0},all={clients:[],sent:new Map()},client=new Client(user,file,all,stats);all.clients.push(client);
 const tag="cce-phase09-backup-"+randomUUID().slice(0,8),network=tag+"-network",volume=tag+"-artifacts",containers=[];let copiedPool,sourceStopped=false,objectsStopped=false;
 mkdirSync(".tmp/phase09-backup",{recursive:true});const dump=resolve(".tmp/phase09-backup/"+tag+".dump");
 try{
  await client.connect();client.send(client.edit(0,"// Durably acknowledged before backup\n"));await client.drain();const expected=client.doc.getText("content").toString();client.disconnect();
  const cpResponse=await request(origin.replace("localhost","127.0.0.1"),base+"/checkpoints","POST",{name:"Backup recovery drill"});assert.equal(cpResponse.status,202);const cp=await cpResponse.json();
  await until(async()=>(await pool.query("SELECT state FROM checkpoints WHERE id=$1",[cp.id])).rows[0].state==="ready","Checkpoint not ready before backup");
  // Quiesce application writers. pg_dump is independently transaction-consistent;
  // a stopped MinIO volume copy pairs ready artifact references with immutable data.
  docker("stop","collaborative-code-editor-jobs-1","collaborative-code-editor-runner-1","collaborative-code-editor-api-1","collaborative-code-editor-collab-1");sourceStopped=true;
  const sourcePG="collaborative-code-editor-postgres-1",sourceMinio="collaborative-code-editor-minio-1";
  const sourceVolume=JSON.parse(docker("inspect",sourceMinio))[0].Mounts.find(m=>m.Destination==="/data").Name;
  assert.equal(sourceVolume,"collaborative-code-editor_artifacts");
  docker("exec",sourcePG,"pg_dump","-U","cce","-d","cce","-Fc","-f","/tmp/"+tag+".dump");docker("cp",sourcePG+":/tmp/"+tag+".dump",dump);
  compose("stop","minio");objectsStopped=true;docker("volume","create",volume);
  docker("run","--rm","--mount",`type=volume,source=${sourceVolume},target=/from,readonly`,"--mount",`type=volume,source=${volume},target=/to`,"alpine:3.22","cp","-a","/from/.","/to/");
  compose("start","--wait","minio");objectsStopped=false;compose("start","--wait","collab","api","jobs");docker("start","collaborative-code-editor-runner-1");sourceStopped=false;
  docker("network","create",network);
  const pgName=tag+"-postgres";containers.push(pgName);docker("run","-d","--name",pgName,"--network",network,"--network-alias","pg","-e","POSTGRES_USER=cce","-e","POSTGRES_PASSWORD=cce_dev_only","-e","POSTGRES_DB=cce","--tmpfs","/var/lib/postgresql","-p","127.0.0.1::5432","postgres:18.6-alpine");
  await until(()=>{try{return docker("exec",pgName,"pg_isready","-h","127.0.0.1","-U","cce","-d","cce").includes("accepting connections");}catch{return false;}},"Scratch PostgreSQL not ready");
  docker("exec",pgName,"psql","-h","127.0.0.1","-U","cce","-d","cce","-v","ON_ERROR_STOP=1","-c","CREATE ROLE cce_collab NOLOGIN; CREATE ROLE cce_worker LOGIN PASSWORD 'cce_worker_dev_only' IN ROLE cce_collab;");
  docker("cp",dump,pgName+":/tmp/backup.dump");docker("exec",pgName,"pg_restore","-h","127.0.0.1","-U","cce","-d","cce","--exit-on-error","--no-owner","/tmp/backup.dump");
  const pgPort=docker("port",pgName,"5432/tcp").split(":").at(-1);copiedPool=new Pool({connectionString:`postgres://cce:cce_dev_only@127.0.0.1:${pgPort}/cce?sslmode=disable`});
  assert.equal((await copiedPool.query("SELECT count(*)::int AS n FROM schema_migrations")).rows[0].n,8);
  // Independent reconstruction from the restored CRDT identities/log, not exported text.
  const recovered=new Y.Doc();Y.applyUpdate(recovered,file.state);for(const row of (await copiedPool.query("SELECT update_bytes,update_hash FROM document_updates WHERE document_id=$1 ORDER BY sequence",[file.document])).rows){assert.ok(sha(row.update_bytes).equals(row.update_hash));Y.applyUpdate(recovered,row.update_bytes);}assert.equal(recovered.getText("content").toString(),expected);recovered.destroy();
  // Docker Desktop's container config digest can outlive its image alias after
  // rebuilds. Resolve the existing local service tag to an available image ID;
  // never pull a substitute image during the recovery drill.
  const imageOf=name=>JSON.parse(docker("image","inspect",JSON.parse(docker("inspect",name))[0].Config.Image))[0].Id;
  const minioName=tag+"-minio";containers.push(minioName);docker("run","-d","--name",minioName,"--network",network,"--network-alias","minio","-e","MINIO_ROOT_USER=cce_local_storage","-e","MINIO_ROOT_PASSWORD=cce_local_storage_only","--mount",`type=volume,source=${volume},target=/data`,imageOf(sourceMinio));
  const collabName=tag+"-collab";containers.push(collabName);docker("run","-d","--name",collabName,"--network",network,"--network-alias","collab","-e","HOST=0.0.0.0","-e","DATABASE_URL=postgres://cce_worker:cce_worker_dev_only@pg:5432/cce?sslmode=disable","-e","COLLAB_INTERNAL_TOKEN=cce_dev_internal_only",imageOf("collaborative-code-editor-collab-1"));
  const apiName=tag+"-api";containers.push(apiName);docker("run","-d","--name",apiName,"--network",network,"-p","127.0.0.1::8080","-e","APP_ENV=development","-e","PUBLIC_ORIGIN="+origin,"-e","API_LISTEN_ADDR=0.0.0.0:8080","-e","DATABASE_URL=postgres://cce:cce_dev_only@pg:5432/cce?sslmode=disable","-e","COLLAB_INTERNAL_ORIGIN=http://collab:8081","-e","COLLAB_INTERNAL_TOKEN=cce_dev_internal_only","-e","ARTIFACT_ENDPOINT=http://minio:9000","-e","ARTIFACT_ACCESS_KEY=cce_local_storage","-e","ARTIFACT_SECRET_KEY=cce_local_storage_only","-e","ARTIFACT_BUCKET=cce-checkpoints",imageOf("collaborative-code-editor-api-1"));
  const apiPort=docker("port",apiName,"8080/tcp").split(":").at(-1),recoveryOrigin=`http://127.0.0.1:${apiPort}`;
  await until(async()=>{try{return (await fetch(recoveryOrigin+"/api/v1/healthz")).ok;}catch{return false;}},"Recovered API not healthy");await sleep(1000);
  const preview=await request(recoveryOrigin,base+"/checkpoints/"+cp.id);assert.equal(preview.status,200);const manifest=await preview.json();assert.equal(manifest.files[0].document_id,file.document);
  const download=await request(recoveryOrigin,base+`/checkpoints/${cp.id}/files/${file.file}`);assert.equal(download.status,200);assert.equal(await download.text(),expected);
  const tree=await (await request(recoveryOrigin,base+"/tree")).json();const restore=await request(recoveryOrigin,base+`/checkpoints/${cp.id}/restore`,"POST",{},tree.tree_version);assert.equal(restore.status,200);
  const newFile=(await (await request(recoveryOrigin,base+"/tree")).json()).entries.find(f=>f.id===file.file);assert.notEqual(newFile.document_id,file.document);assert.equal(newFile.generation,"2");
  const snapshot=(await copiedPool.query("SELECT encoded_state FROM document_snapshots WHERE document_id=$1",[newFile.document_id])).rows[0];const restoredDoc=new Y.Doc();Y.applyUpdate(restoredDoc,snapshot.encoded_state);assert.equal(restoredDoc.getText("content").toString(),expected);restoredDoc.destroy();
  mkdirSync(reportDir,{recursive:true});writeFileSync(`${reportDir}/phase09-backup.json`,JSON.stringify({date:new Date().toISOString(),dumpBytes:statSync(dump).size,canonicalMigrations:8,exactAcknowledgedReplay:true,coldMinioCopyVerifiedThroughAuthorizedDownload:true,ownerRestoreFreshGeneration:true,sourceVolumesPreserved:true,scope:"local quiesced pg_dump + cold volume clone; does not establish off-host backup retention, disaster RPO/RTO or host failure resilience"},null,2)+"\n");
 }finally{
  client.disconnect();client.doc.destroy();if(copiedPool)await copiedPool.end();
  if(objectsStopped)compose("start","--wait","minio");if(sourceStopped)compose("start","--wait","collab","api","jobs");docker("start","collaborative-code-editor-runner-1");
  for(const name of containers.reverse()){assert.ok(name.startsWith(tag+"-"));try{docker("rm","-f",name);}catch{}}
  try{docker("network","rm",network);}catch{}try{docker("volume","rm",volume);}catch{}
  await pool.query("UPDATE sessions SET revoked_at=clock_timestamp() WHERE user_id=$1",[user.id]);await pool.end();
 }
});
