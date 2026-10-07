import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { Pool } from "pg";
import { Client, fixture, until, origin, sleep } from "../load/workload.mjs";

test("Phase 09 live metrics, correlated OTLP spans and sentinel redaction across code/stdin/output/auth",{timeout:120000},async()=>{
 assert.ok(process.env.TEST_DATABASE_URL,"TEST_DATABASE_URL required");assert.equal(process.env.CCE_EXECUTION_TESTS,"1","Execution must be explicitly enabled");
 const pool=new Pool({connectionString:process.env.TEST_DATABASE_URL});const sentinels=["SOURCE","STDIN","STDOUT","COOKIE","INVITE"].map(kind=>`CCE_SENTINEL_${kind}_${randomUUID()}`);
 const source=`// ${sentinels[0]}\nprocess.stdin.on('data', b => { console.log('${sentinels[2]}'); console.log(b.toString()); });\n`;
 const data=await fixture(pool,1,1,1024,source),user=data.users[0];sentinels.push(user.token,user.csrf);
 const request=async(path,method="GET",input)=>fetch(origin.replace("localhost","127.0.0.1")+path,{method,headers:{Cookie:`cce_session=${user.token}; extra=${sentinels[3]}`,Origin:origin,"Content-Type":"application/json","X-CSRF-Token":user.csrf,"Idempotency-Key":randomUUID()},body:input?JSON.stringify(input):undefined});
 const stats={sync:[],ack:[],peer:[],rejected:{},generated:0,acked:0},all={clients:[],sent:new Map()};const client=new Client(user,data.files[0],all,stats);all.clients.push(client);
 try{
  assert.equal((await request("/metrics")).status,404);
  assert.ok([400,404].includes((await request("/api/v1/invites/"+sentinels[4]+"/accept","POST",{})).status));
  const invite=await request(`/api/v1/projects/${data.project}/invites`,"POST",{role:"viewer",expires_at:new Date(Date.now()+3600000).toISOString(),max_uses:1});assert.equal(invite.status,201);sentinels.push((await invite.json()).token);
  await client.connect();client.send(client.edit(0,`// ${sentinels[0]}\n`));await client.drain();client.disconnect();
  const run=await request(`/api/v1/projects/${data.project}/runs`,"POST",{runtime:"javascript",entrypoint:"file0.js",stdin:sentinels[1]});assert.equal(run.status,202);const job=await run.json();
  await until(async()=> (await (await request(`/api/v1/projects/${data.project}/runs/${job.id}`)).json()).state==="succeeded","Sentinel run did not succeed");
  const output=Buffer.concat((await pool.query("SELECT payload FROM run_events WHERE job_id=$1 AND kind='stdout' ORDER BY sequence",[job.id])).rows.map(row=>row.payload)).toString();assert.ok(output.includes(sentinels[1]));assert.ok(output.includes(sentinels[2]));
  await sleep(6500);
  const metrics=await (await fetch("http://127.0.0.1:9090/api/v1/targets")).json();assert.equal(metrics.status,"success");assert.equal(metrics.data.activeTargets.length,4);assert.ok(metrics.data.activeTargets.every(t=>t.health==="up"));
  const series=await (await fetch("http://127.0.0.1:9090/api/v1/series?match%5B%5D=%7Bjob%3D%22cce%22%7D")).text();
  const logs=["api","jobs","collab","runner","web","edge","otel-collector"].map(name=>{ const output=spawnSync("docker",["logs","--since","5m",`collaborative-code-editor-${name}-1`],{encoding:"utf8",maxBuffer:32<<20});assert.equal(output.status,0);return (output.stdout??"")+(output.stderr??""); }).join("\n");
  for(const secret of sentinels){assert.equal(logs.includes(secret),false,"Sentinel leaked to global logs/traces");assert.equal(series.includes(secret),false,"Sentinel leaked to labels");}
  assert.ok(logs.includes("document.append"),"No sampled append spans were exported; retry after more sampled operations");assert.ok(logs.includes("database.query"),"No SQL spans exported");assert.ok(logs.includes("checkpoint.materialize"),"No jobs spans exported");
  // Collector exports service.name, Trace ID and Parent ID. Verify at least one
  // trace has operations from both Go and TS rather than merely separate spans.
  const resources=logs.split(/ResourceSpans #\d+/);const services=new Map();
  for(const block of resources){const service=/service.name: Str\(([^)]+)\)/.exec(block)?.[1];if(!service)continue;for(const trace of block.matchAll(/Trace ID\s*:\s*([0-9a-f]{32})/g)){const set=services.get(trace[1])??new Set();set.add(service);services.set(trace[1],set);}}
  assert.ok([...services.values()].some(set=>set.has("cce-api")&&set.has("cce-collab")),"No cross-service trace correlation captured");
  const numeric=await (await fetch("http://127.0.0.1:9090/api/v1/query?query="+encodeURIComponent('cce_runner_seconds_count{stage="runtime"}'))).json();assert.ok(numeric.data.result.length>0);
  mkdirSync("docs/measurements",{recursive:true});writeFileSync("docs/measurements/phase09-observability.json",JSON.stringify({date:new Date().toISOString(),sentinelClasses:sentinels.length,authorizedOutputContainsStdinAndStdout:true,globalLogAndTraceLeak:false,metricLabelLeak:false,scrapeTargets:metrics.data.activeTargets.map(t=>({service:t.labels.service,health:t.health})),crossServiceCorrelation:true,runnerRuntimeSeries:numeric.data.result.map(r=>({metric:r.metric,value:r.value[1]}))},null,2)+"\n");
 }finally{client.disconnect();client.doc.destroy();await pool.query("UPDATE sessions SET revoked_at=clock_timestamp() WHERE user_id=$1",[user.id]);await pool.end();}
});
