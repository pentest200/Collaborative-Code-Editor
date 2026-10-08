import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {mkdirSync,writeFileSync,readFileSync} from "node:fs";
import {Pool} from "pg";
const dir=process.env.CCE_REPORT_DIR;assert.ok(dir,"CCE_REPORT_DIR must name this run's evidence directory");
assert.ok(process.env.TEST_DATABASE_URL);assert.equal(process.env.CCE_EXECUTION_TESTS,"1");assert.equal(process.env.CCE_E2E_RESTART,"1");assert.equal(process.env.CCE_E2E_STORAGE_FAILURE,"1");assert.ok(process.env.RUNNER_INTERNAL_TOKEN);assert.ok(process.env.GRAFANA_ADMIN_PASSWORD);
mkdirSync(dir,{recursive:true});mkdirSync(".tmp/local-demo",{recursive:true});
const report={date:new Date().toISOString(),scope:"real local services; seeded independent browser sessions, separate live OAuth evidence",checks:[],status:"running"};
const save=()=>writeFileSync(`${dir}/acceptance.json`,JSON.stringify(report,null,2)+"\n");
const pool=new Pool({connectionString:process.env.TEST_DATABASE_URL});
try{
 const config=await (await fetch("http://127.0.0.1:3000/api/v1/auth/config")).json();assert.equal(config.execution_enabled,true,"Private execution must be enabled explicitly");report.githubConfigured=config.github_enabled;
 const existing=(await pool.query("SELECT id::text FROM projects")).rows.map(r=>r.id);report.existingProjectCount=existing.length;
 for(const name of ["workspace","failure-demo","jobs-death","backup","measurements","observability","runner-measurements","dashboard","load"]){
  const start=performance.now();const result=spawnSync("npm.cmd",["run",`test:${name}`],{shell:true,env:process.env,encoding:"utf8",timeout:name==="failure-demo"?900000:300000,maxBuffer:8<<20});
  const output=(result.stdout??"")+(result.stderr??"");writeFileSync(`.tmp/local-demo/${name}.txt`,output);
  let passed=Number(/# pass (\d+)/.exec(output)?.[1]??0),skipped=Number(/# skipped (\d+)/.exec(output)?.[1]??0),extraValid=true;
  if(name==="failure-demo"){const children=JSON.parse(readFileSync(`${dir}/phase09-failures.json`,"utf8")).checks;passed=children.reduce((n,c)=>n+c.passed,0);skipped=children.reduce((n,c)=>n+c.skipped,0);extraValid=children.length===6&&children.every(c=>c.success&&c.exitCode===0);}
  if(name==="load"){const load=JSON.parse(readFileSync(`${dir}/phase09-load.json`,"utf8"));passed=load.scenarios.length;extraValid=load.status==="passed"&&passed===2&&load.scenarios.every(s=>s.unresolved===0&&s.generated===s.acknowledged&&s.correctness.replicasEqualDatabase&&s.correctness.durableRows===s.generated);}
  const success=result.status===0&&passed>0&&skipped===0&&extraValid;report.checks.push({command:`npm.cmd run test:${name}`,exitCode:result.status,passed,skipped,durationSeconds:(performance.now()-start)/1000,success});save();console.log(`${name}: ${passed} passed, ${skipped} skipped, exit ${result.status}`);assert.ok(success,`${name} failed or skipped; inspect .tmp/local-demo/${name}.txt`);
 }
 assert.equal((await pool.query("SELECT count(*)::int AS n FROM projects WHERE id=ANY($1::uuid[])",[existing])).rows[0].n,existing.length,"An existing project was removed");report.existingProjectRowsPreserved=true;report.status="passed";
}catch(error){report.status="failed";report.failure=error.message;throw error;}
finally{save();await pool.end();}
