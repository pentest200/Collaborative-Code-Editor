import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { Pool } from "pg";
import * as Y from "yjs";
const url = process.env.TEST_DATABASE_URL;
const origin = "http://localhost:3000";
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha = bytes => createHash("sha256").update(bytes).digest();
async function until(predicate, timeout = 25000) { const end = Date.now() + timeout; while (!await predicate()) { if (Date.now() > end) throw new Error("Acceptance condition timed out"); await pause(100); } }
function docker(...args) { return execFileSync("docker", args, { encoding: "utf8", timeout: 30000 }).trim(); }
async function seed(pool, source, runtime = "python") {
  const users = [];
  for (const role of ["owner", "editor", "viewer", "outsider"]) {
    const id = (await pool.query("INSERT INTO users(provider,provider_subject,display_name) VALUES('github',$1,$2) RETURNING id", [randomUUID(), `Execution ${role}`])).rows[0].id;
    const token = randomBytes(32).toString("base64url"), csrf = sha("cce-csrf-v1:" + token).toString("base64url");
    const session = (await pool.query("INSERT INTO sessions(user_id,token_hash,csrf_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 hour') RETURNING id", [id, sha(token), sha(csrf)])).rows[0].id;
    users.push({ id, token, csrf, role, session });
  }
  const tx = await pool.connect(); let project, file, document;
  try {
    await tx.query("BEGIN"); project = (await tx.query("INSERT INTO projects(owner_id,name) VALUES($1,'Execution acceptance') RETURNING id", [users[0].id])).rows[0].id;
    for (const user of users.slice(0, 3)) await tx.query("INSERT INTO project_members VALUES($1,$2,$3)", [project, user.id, user.role]);
    file = (await tx.query("INSERT INTO files(project_id,name,kind,language) VALUES($1,$2,'file',$3) RETURNING id", [project, runtime === "python" ? "main.py" : "main.js", runtime])).rows[0].id;
    document = (await tx.query("INSERT INTO documents(file_id,generation,committed_text_bytes) VALUES($1,1,$2) RETURNING id", [file, Buffer.byteLength(source)])).rows[0].id;
    const doc = new Y.Doc(); doc.getText("content").insert(0, source); const state = Y.encodeStateAsUpdate(doc), vector = Y.encodeStateVector(doc); doc.destroy();
    const snapshot = (await tx.query("INSERT INTO document_snapshots(document_id,through_sequence,encoded_state,state_vector,checksum) VALUES($1,0,$2,$3,$4) RETURNING id", [document, state, vector, sha(state)])).rows[0].id;
    await tx.query("UPDATE documents SET snapshot_id=$2 WHERE id=$1", [document, snapshot]); await tx.query("UPDATE files SET current_document_id=$2 WHERE id=$1", [file, document]); await tx.query("COMMIT");
  } catch (error) { await tx.query("ROLLBACK"); throw error; } finally { tx.release(); }
  return { project, file, document, users, runtime };
}
async function request(data, method, suffix, body, actor = 0, key = randomUUID()) {
  const user = data.users[actor]; const response = await fetch(`http://127.0.0.1:3000/api/v1/projects/${data.project}/runs${suffix}`, { method, headers: { Origin: origin, Cookie: `cce_session=${user.token}`, "X-CSRF-Token": user.csrf, "Idempotency-Key": key, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, body: await response.json() };
}
function body(data, stdin = "") { return { runtime: data.runtime, entrypoint: data.runtime === "python" ? "main.py" : "main.js", stdin }; }
async function run(pool, source, runtime = "python", stdin = "") {
  const data = await seed(pool, source, runtime); const response = await request(data, "POST", "", body(data, stdin)); assert.equal(response.status, 202, JSON.stringify(response)); const id = response.body.id;
  let result; await until(async () => { result = (await request(data, "GET", `/${id}`)).body; return ["succeeded", "failed", "timed_out", "cancelled"].includes(result.state); });
  const events = (await pool.query("SELECT sequence,kind,payload FROM run_events WHERE job_id=$1 ORDER BY sequence", [id])).rows;
  assert.deepEqual(events.map(row => Number(row.sequence)), Array.from({ length: events.length }, (_, i) => i + 1));
  const output = Buffer.concat(events.filter(row => row.kind !== "status").map(row => row.payload)); assert.ok(output.length <= 65536);
  assert.equal(docker("ps", "-aq", "--filter", `name=^/cce-run-${id}-1$`), "", "Terminal run leaked container");
  return { data, id, result, output: output.toString(), events };
}
test("Phase 07 designated Docker execution, immutable jobs and limits", { skip: !url || process.env.CCE_EXECUTION_TESTS !== "1", timeout: 240000 }, async t => {
  const pool = new Pool({ connectionString: url });
  try {
    await t.test("Python/JavaScript success, errors and bounded stdin", async () => {
      const py = await run(pool, "import sys\nprint('python:' + sys.stdin.read())", "python", "input"); assert.equal(py.result.state, "succeeded"); assert.equal(py.output, "python:input\n");
      const js = await run(pool, "console.log('js:' + require('fs').readFileSync(0,'utf8'))", "javascript", "input"); assert.equal(js.result.state, "succeeded"); assert.equal(js.output, "js:input\n");
      const failure = await run(pool, "raise ValueError('expected runtime failure')"); assert.equal(failure.result.state, "failed"); assert.match(failure.output, /ValueError/);
      const badJS = await run(pool, "throw new Error('expected JS failure')", "javascript"); assert.equal(badJS.result.state, "failed"); assert.match(badJS.output, /expected JS failure/);
    });
    await t.test("nonroot, cgroups, seccomp, mounts, secret sentinel and network enforcement", async () => {
      docker("compose", "-f", "infra/compose/compose.yaml", "-f", "infra/compose/compose.runner.yaml", "exec", "-T", "runner", "sh", "-c", "printf private-host-sentinel > /runs/host-secret");
      const source = `import os,socket,json\nr={'uid':os.getuid(),'memory':open('/sys/fs/cgroup/memory.max').read().strip(),'pids':open('/sys/fs/cgroup/pids.max').read().strip(),'cpu':open('/sys/fs/cgroup/cpu.max').read().strip(),'status':open('/proc/self/status').read(),'secrets':any(k in os.environ for k in ['DATABASE_URL','GITHUB_CLIENT_SECRET','RUNNER_INTERNAL_TOKEN','ARTIFACT_SECRET_KEY']),'socket':os.path.exists('/var/run/docker.sock'),'sentinel':os.path.exists('/runs/host-secret')}\nfor key,target in [('root','/forbidden'),('source','/source/main.py'),('scratch','/tmp/large')]:\n try:\n  with open(target,'wb') as f:f.write(b'x'*(20*1024*1024) if key=='scratch' else b'x')\n  r[key]=False\n except OSError:r[key]=True\ntry:\n socket.create_connection(('1.1.1.1',80),.3);r['network']=False\nexcept OSError:r['network']=True\nprint(json.dumps(r))`;
      const observed = await run(pool, source); assert.equal(observed.result.state, "succeeded"); const limits = JSON.parse(observed.output); assert.equal(limits.uid, 65532); assert.equal(limits.memory, "134217728"); assert.equal(limits.pids, "32"); assert.equal(limits.cpu, "100000 100000"); assert.match(limits.status, /Seccomp:\s+2/); assert.match(limits.status, /NoNewPrivs:\s+1/); assert.match(limits.status, /CapEff:\s+0000000000000000/); for (const key of ["root", "source", "scratch", "network"]) assert.equal(limits[key], true, key); for (const key of ["secrets", "socket", "sentinel"]) assert.equal(limits[key], false, key);
    });
    await t.test("wall timeout, output flood, PID and memory limits actually terminate/bound", async () => {
      const loop = await run(pool, "while True: pass"); assert.equal(loop.result.state, "timed_out"); assert.equal(loop.result.exit_code, 124);
      const flood = await run(pool, "import sys\nwhile True: sys.stdout.write('x'*4096);sys.stdout.flush()"); assert.equal(flood.result.state, "failed"); assert.equal(flood.result.truncated, true); assert.equal(Buffer.byteLength(flood.output), 65536);
      const pids = await run(pool, "import subprocess,json\nchildren=[]\nfor n in range(80):\n try:children.append(subprocess.Popen(['/usr/local/bin/python3','-c','import time;time.sleep(10)']))\n except OSError:break\nprint(json.dumps({'count':len(children),'refused':len(children)<80}))"); assert.equal(pids.result.state, "succeeded"); const spawned = JSON.parse(pids.output); assert.equal(spawned.refused, true); assert.ok(spawned.count < 32);
      const memory = await run(pool, "x=bytearray(300*1024*1024)\nprint('unexpected')"); assert.equal(memory.result.state, "failed"); assert.equal(memory.result.exit_code, 137); assert.ok(!memory.output.includes("unexpected"));
    });
    await t.test("CPU quota limits four competing child processes", async () => {
      const cpu = await run(pool, `import subprocess,time,json\nstart=time.monotonic()\ncode="import time;start=time.process_time();end=time.monotonic()+1.5\\nwhile time.monotonic()<end:pass\\nprint(time.process_time()-start)"\nchildren=[subprocess.Popen(['/usr/local/bin/python3','-c',code],stdout=subprocess.PIPE) for _ in range(4)]\nused=sum(float(c.communicate()[0]) for c in children)\nprint(json.dumps({'cpu':used,'wall':time.monotonic()-start}))`); assert.equal(cpu.result.state, "succeeded"); const sample = JSON.parse(cpu.output); assert.ok(sample.cpu / sample.wall <= 1.35, JSON.stringify(sample)); assert.ok(sample.cpu > .3);
    });
    await t.test("duplicate Run, quota, cancellation and authorized resumable output", async () => {
      const data = await seed(pool, "import time\nprint('started',flush=True)\ntime.sleep(4)"); const key = randomUUID(); const input = body(data);
      const first = await request(data, "POST", "", input, 0, key); assert.equal(first.status, 202); const id = first.body.id;
      const duplicate = await request(data, "POST", "", input, 0, key); assert.equal(duplicate.status, 202); assert.equal(duplicate.body.id, id); assert.equal(duplicate.body.checkpoint_id, first.body.checkpoint_id);
      assert.equal((await request(data, "POST", "", { ...input, stdin: "changed" }, 0, key)).status, 409);
      assert.equal((await request(data, "POST", "", input)).status, 429);
      assert.equal((await request(data, "POST", "", input, 2)).status, 403); assert.equal((await request(data, "GET", `/${id}`, null, 3)).status, 404); assert.equal((await request(data, "DELETE", `/${id}`, null, 2)).status, 403);
      const foreignTx = await pool.connect(); let foreignProject;
      try {
        await foreignTx.query("BEGIN"); foreignProject = (await foreignTx.query("INSERT INTO projects(owner_id,name) VALUES($1,'Foreign output scope') RETURNING id", [data.users[3].id])).rows[0].id;
        await foreignTx.query("INSERT INTO project_members VALUES($1,$2,'owner')", [foreignProject, data.users[3].id]); await foreignTx.query("COMMIT");
      } catch (error) { await foreignTx.query("ROLLBACK"); throw error; } finally { foreignTx.release(); }
      for (const suffix of ["", "/events"]) {
        const foreign = await fetch(`http://127.0.0.1:3000/api/v1/projects/${foreignProject}/runs/${id}${suffix}`, { headers: { Cookie: `cce_session=${data.users[3].token}` } }); assert.equal(foreign.status, 404); await foreign.text();
        const outsider = await fetch(`http://127.0.0.1:3000/api/v1/projects/${data.project}/runs/${id}${suffix}`, { headers: { Cookie: `cce_session=${data.users[3].token}` } }); assert.equal(outsider.status, 404); await outsider.text();
        const anonymous = await fetch(`http://127.0.0.1:3000/api/v1/projects/${data.project}/runs/${id}${suffix}`); assert.equal(anonymous.status, 401); await anonymous.text();
      }
      await until(async () => (await request(data, "GET", `/${id}`)).body.state === "running");
      const response = await fetch(`http://127.0.0.1:3000/api/v1/projects/${data.project}/runs/${id}/events?after=0`, { headers: { Cookie: `cce_session=${data.users[2].token}` } }); assert.equal(response.status, 200); const reader = response.body.getReader(); const firstEvents = new TextDecoder().decode((await reader.read()).value); assert.match(firstEvents, /id: 1/); await reader.cancel();
      assert.equal((await request(data, "DELETE", `/${id}`, null, 1)).status, 202); await until(async () => (await request(data, "GET", `/${id}`)).body.state === "cancelled");
      const final = (await request(data, "GET", `/${id}`)).body;
      const replay = await fetch(`http://127.0.0.1:3000/api/v1/projects/${data.project}/runs/${id}/events?after=1`, { headers: { Cookie: `cce_session=${data.users[0].token}` } }); const replayText = await replay.text(); assert.ok(!replayText.includes("id: 1\n")); assert.match(replayText, new RegExp(`id: ${final.event_sequence}`));
      await pool.query("DELETE FROM project_members WHERE project_id=$1 AND user_id=$2", [data.project, data.users[2].id]); assert.equal((await request(data, "GET", `/${id}`, null, 2)).status, 404);
      const revoked = await fetch(`http://127.0.0.1:3000/api/v1/projects/${data.project}/runs/${id}/events`, { headers: { Cookie: `cce_session=${data.users[2].token}` } }); assert.equal(revoked.status, 404); await revoked.text();
      assert.equal(docker("ps", "-aq", "--filter", `name=^/cce-run-${id}-1$`), "");
      assert.equal((await request(data, "DELETE", `/${id}`)).status, 202); assert.equal((await request(data, "GET", `/${id}`)).body.state, "cancelled");
    });
    await t.test("real runner SIGKILL, independent timeout, lease failure and restart reconciliation", async () => {
      const data = await seed(pool, "print('once',flush=True)\nwhile True:pass"); const created = await request(data, "POST", "", body(data)); const id = created.body.id;
      await until(async () => (await pool.query("SELECT output_bytes FROM run_jobs WHERE id=$1", [id])).rows[0].output_bytes > 0);
      docker("compose", "-f", "infra/compose/compose.yaml", "-f", "infra/compose/compose.runner.yaml", "kill", "-s", "SIGKILL", "runner");
      try {
        await until(async () => docker("inspect", "--format", "{{.State.Running}}", `cce-run-${id}-1`) === "false", 10000);
        assert.equal(docker("inspect", "--format", "{{.State.ExitCode}}", `cce-run-${id}-1`), "124");
        await until(async () => (await request(data, "GET", `/${id}`)).body.state === "failed", 25000); assert.equal((await request(data, "GET", `/${id}`)).body.failure_code, "RUNNER_INTERRUPTED");
      } finally { docker("compose", "-f", "infra/compose/compose.yaml", "-f", "infra/compose/compose.runner.yaml", "start", "runner"); }
      await until(async () => docker("ps", "-aq", "--filter", `name=^/cce-run-${id}-1$`) === ""); await pause(1500); assert.equal((await pool.query("SELECT attempt FROM run_jobs WHERE id=$1", [id])).rows[0].attempt, 1);
      const healthy = await run(pool, "print('after-recovery')"); assert.equal(healthy.result.state, "succeeded");
    });
  } finally { await pool.end(); }
});
