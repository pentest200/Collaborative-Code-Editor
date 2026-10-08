const reportDir = process.env.CCE_REPORT_DIR ?? "docs/measurements";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
assert.ok(process.env.TEST_DATABASE_URL,"TEST_DATABASE_URL required");
assert.equal(process.env.CCE_E2E_RESTART,"1","Explicit local process-death opt-in required");
assert.equal(process.env.CCE_E2E_STORAGE_FAILURE,"1","Explicit scoped storage-failure opt-in required");
// Existing tests use real processes and fixture-scoped DB barriers. Keep these
// sequential; shared worker-death/queue suites cannot safely overlap.
const report={date:new Date().toISOString(),checks:[]};
for(const name of ["realtime","recovery","checkpoints","search","runs","execution"]){
 if(["runs","execution"].includes(name))assert.equal(process.env.CCE_EXECUTION_TESTS,"1","Execution must be explicitly enabled; skips are not passes");
 const start=performance.now();const result=spawnSync("npm.cmd",["run",`test:${name}`],{env:process.env,shell:true,encoding:"utf8",timeout:300000,maxBuffer:4<<20});
 const output=(result.stdout??"")+(result.stderr??"");const passed=Number(/# pass (\d+)/.exec(output)?.[1]??0),skipped=Number(/# skipped (\d+)/.exec(output)?.[1]??0);
 const success=result.status===0&&passed>0&&skipped===0;report.checks.push({command:`npm.cmd run test:${name}`,passed,skipped,exitCode:result.status,durationSeconds:(performance.now()-start)/1000,success});
 mkdirSync(".tmp/phase09-failures",{recursive:true});writeFileSync(`.tmp/phase09-failures/${name}.txt`,output);console.log(`${name}: ${passed} passed, ${skipped} skipped, exit ${result.status}`);
 mkdirSync(reportDir,{recursive:true});writeFileSync(`${reportDir}/phase09-failures.json`,JSON.stringify(report,null,2)+"\n");assert.ok(success,`${name} failed or skipped; see .tmp/phase09-failures/${name}.txt`);
}
