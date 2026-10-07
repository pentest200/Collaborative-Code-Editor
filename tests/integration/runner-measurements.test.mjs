import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {test} from "node:test";
import {Pool} from "pg";
import {mkdirSync,writeFileSync} from "node:fs";
import {fixture,until,origin,sleep} from "../load/workload.mjs";

test("Phase 09 measures actual runner startup/runtime/kill/cleanup separately",{timeout:90000},async()=>{
 assert.ok(process.env.TEST_DATABASE_URL);assert.equal(process.env.CCE_EXECUTION_TESTS,"1");
 const pool=new Pool({connectionString:process.env.TEST_DATABASE_URL}),data=await fixture(pool,1,1,1024,"setInterval(() => {}, 100);\n"),user=data.users[0];
 const request=(path,body,method="POST")=>fetch(origin.replace("localhost","127.0.0.1")+path,{method,headers:{Cookie:`cce_session=${user.token}`,Origin:origin,"Content-Type":"application/json","X-CSRF-Token":user.csrf,"Idempotency-Key":randomUUID()},body:body===undefined?undefined:JSON.stringify(body)});
 try{
  for(let n=0;n<2;n++){
   const response=await request(`/api/v1/projects/${data.project}/runs`,{runtime:"javascript",entrypoint:"file0.js",stdin:""});assert.equal(response.status,202);const job=await response.json();
   await until(async()=>(await pool.query("SELECT state FROM run_jobs WHERE id=$1",[job.id])).rows[0].state==="running","runner not running");await sleep(600);
   const cancel=await request(`/api/v1/projects/${data.project}/runs/${job.id}`,undefined,"DELETE");assert.equal(cancel.status,202);await until(async()=>(await pool.query("SELECT state FROM run_jobs WHERE id=$1",[job.id])).rows[0].state==="cancelled","run did not cancel");await sleep(5500);
  }
  const report={date:new Date().toISOString(),actualCancelledRuns:2,definition:"Current runner process cumulative histogram quantile estimates, since its last restart; includes other completed attempts in that process. Not the load interval or an SLO. Hydration estimates use a separate 30-minute rate window.",queries:[]};
  for(const [name,expr] of [["runnerStages","sum by(le,stage,runtime)(cce_runner_seconds_bucket)"],["hydration",'sum by(le,operation)(rate(cce_operation_seconds_bucket{service="collab",operation=~"document.open|document.hydrate|document.sync"}[30m]))']])for(const q of [.5,.95]){
   const query=`histogram_quantile(${q},${expr})`,response=await fetch("http://127.0.0.1:9090/api/v1/query?query="+encodeURIComponent(query));assert.ok(response.ok);const body=await response.json();assert.equal(body.status,"success");assert.ok(body.data.result.length);report.queries.push({name,quantile:q,query,results:body.data.result.map(r=>({labels:r.metric,seconds:Number.isFinite(Number(r.value[1]))?Number(r.value[1]):null}))});
  }
  for(const stage of ["startup","runtime","termination","cleanup","total"])assert.ok(report.queries.some(q=>q.results.some(r=>r.labels.stage===stage&&r.labels.runtime==="javascript"&&r.seconds!==null)),`Missing measured ${stage}`);
  mkdirSync("docs/measurements",{recursive:true});writeFileSync("docs/measurements/phase09-stages.json",JSON.stringify(report,null,2)+"\n");
 }finally{await pool.query("UPDATE sessions SET revoked_at=clock_timestamp() WHERE user_id=$1",[user.id]);await pool.end();}
});
