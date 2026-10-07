import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { Pool } from "pg";
import { fixture, until, origin, sha } from "../load/workload.mjs";
const compose=(...args)=>execFileSync("docker",["compose","-f","infra/compose/compose.yaml",...args],{encoding:"utf8",stdio:["ignore","pipe","pipe"]});
test("Phase 09 actual jobs process death during checkpoint and search publication, fenced retry",{timeout:120000},async()=>{
 assert.ok(process.env.TEST_DATABASE_URL,"TEST_DATABASE_URL required");assert.equal(process.env.CCE_E2E_RESTART,"1","Designated local process-death opt-in required");
 const pool=new Pool({connectionString:process.env.TEST_DATABASE_URL});const lock=await pool.connect();const suffix=randomUUID().replaceAll("-","").slice(0,12),fn="cce_phase09_barrier_"+suffix,triggers=["cce_phase09_checkpoint_"+suffix,"cce_phase09_search_"+suffix],key=909000;let stopped=false,data,checkpoint;
 try{
  compose("stop","jobs");stopped=true;data=await fixture(pool,1,1,1024,"// Worker-death fixture\n");const user=data.users[0];
  const request=await fetch(origin.replace("localhost","127.0.0.1")+`/api/v1/projects/${data.project}/checkpoints`,{method:"POST",headers:{Cookie:`cce_session=${user.token}`,Origin:origin,"Content-Type":"application/json","X-CSRF-Token":user.csrf},body:JSON.stringify({name:"Actual jobs death"})});assert.equal(request.status,202);checkpoint=(await request.json()).id;
  await lock.query("SELECT pg_advisory_lock($1),pg_advisory_lock($2)",[key,key+1]);
  await pool.query(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF TG_TABLE_NAME='checkpoint_files' THEN IF NEW.checkpoint_id::text=TG_ARGV[0] THEN PERFORM pg_advisory_xact_lock(TG_ARGV[1]::bigint); END IF; ELSIF TG_TABLE_NAME='search_documents' THEN IF NEW.file_id::text=TG_ARGV[0] THEN PERFORM pg_advisory_xact_lock(TG_ARGV[1]::bigint); END IF; END IF; RETURN NEW; END $$`);
  await pool.query(`CREATE TRIGGER ${triggers[0]} BEFORE UPDATE ON checkpoint_files FOR EACH ROW EXECUTE FUNCTION ${fn}('${checkpoint}','${key}')`);
  await pool.query(`CREATE TRIGGER ${triggers[1]} BEFORE INSERT OR UPDATE ON search_documents FOR EACH ROW EXECUTE FUNCTION ${fn}('${data.files[0].file}','${key+1}')`);
  compose("start","jobs");stopped=false;
  let pids=[];await until(async()=>{pids=(await pool.query("SELECT pid FROM pg_stat_activity WHERE wait_event='advisory' AND (query LIKE 'UPDATE checkpoint_files%' OR query LIKE 'INSERT INTO search_documents%')")).rows.map(row=>row.pid);return pids.length===2;},"Both durable consumers did not reach their publication barriers");
  assert.equal((await pool.query("SELECT state FROM checkpoints WHERE id=$1",[checkpoint])).rows[0].state,"materializing");assert.equal((await pool.query("SELECT count(*)::int AS n FROM search_documents WHERE file_id=$1",[data.files[0].file])).rows[0].n,0);
  compose("kill","-s","SIGKILL","jobs");stopped=true;
  // Process loss does not alone imply DB rollback; terminate only the observed
  // fixture-blocked statements before releasing the barrier.
  for(const pid of pids)await pool.query("SELECT pg_terminate_backend($1)",[pid]);
  await lock.query("SELECT pg_advisory_unlock($1),pg_advisory_unlock($2)",[key,key+1]);
  await pool.query(`DROP TRIGGER ${triggers[0]} ON checkpoint_files; DROP TRIGGER ${triggers[1]} ON search_documents; DROP FUNCTION ${fn}()`);
  // Actual worker died; accelerate DB-clock lease expiry to keep this bounded.
  // This explicitly does NOT measure the normal five-minute/30-second wait.
  await pool.query("UPDATE checkpoints SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[checkpoint]);await pool.query("UPDATE search_tasks SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE file_id=$1",[data.files[0].file]);
  compose("start","jobs");stopped=false;
  await until(async()=>{const cp=(await pool.query("SELECT state,attempt FROM checkpoints WHERE id=$1",[checkpoint])).rows[0];const search=(await pool.query("SELECT content FROM search_documents WHERE file_id=$1",[data.files[0].file])).rows[0];return cp.state==="ready"&&Number(cp.attempt)===2&&search?.content==="// Worker-death fixture\n";},"Killed consumers did not recover exact captured inputs");
  const download=await fetch(origin.replace("localhost","127.0.0.1")+`/api/v1/projects/${data.project}/checkpoints/${checkpoint}/files/${data.files[0].file}`,{headers:{Cookie:`cce_session=${user.token}`}});assert.equal(download.status,200);assert.ok(sha(await download.text()).equals(sha("// Worker-death fixture\n")));
  mkdirSync("docs/measurements",{recursive:true});writeFileSync("docs/measurements/phase09-jobs-death.json",JSON.stringify({date:new Date().toISOString(),actualJobsSIGKILL:true,checkpointAndSearchBlockedAtRealPublication:true,noPrematureReadyOrProjection:true,checkpointRecoveredAtAttempt:2,exactDownloadAndProjection:true,leaseExpiry:"fixture accelerated after actual process death; natural five-minute/30-second takeover timing is not measured"},null,2)+"\n");
 }finally{
  await lock.query("SELECT pg_advisory_unlock_all()").catch(()=>{});lock.release();await pool.query(`DROP TRIGGER IF EXISTS ${triggers[0]} ON checkpoint_files; DROP TRIGGER IF EXISTS ${triggers[1]} ON search_documents; DROP FUNCTION IF EXISTS ${fn}()`).catch(()=>{});if(stopped)compose("start","jobs");if(data)await pool.query("UPDATE sessions SET revoked_at=clock_timestamp() WHERE user_id=$1",[data.users[0].id]);await pool.end();
 }
});
