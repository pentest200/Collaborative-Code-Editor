import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import * as Y from "yjs";

const origin = "http://localhost:3000";
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha = text => createHash("sha256").update(text).digest("hex");
function docker(...args) { return execFileSync("docker", args, { encoding: "utf8", timeout: 45000 }).trim(); }
function sql(query) { return execFileSync("docker", ["exec", "-i", "collaborative-code-editor-postgres-1", "psql", "-U", "cce", "-d", "cce", "-At", "-v", "ON_ERROR_STOP=1"], { input: query, encoding: "utf8", timeout: 30000 }).trim(); }
function actor() {
 const id = randomUUID(); const token = randomBytes(32).toString("base64url"); const csrf = createHash("sha256").update("cce-csrf-v1:" + token).digest("base64url");
 sql(`INSERT INTO users(id,provider,provider_subject,display_name) VALUES('${id}','github','${id}','Workspace acceptance'); INSERT INTO sessions(user_id,token_hash,csrf_hash,expires_at) VALUES('${id}',decode('${sha(token)}','hex'),decode('${sha(csrf)}','hex'),now()+interval '1 hour');`);
 return { id, token, csrf };
}
async function request(user, method, path, body, headers = {}) {
 const response = await fetch(`http://127.0.0.1:3000${path}`, { method, headers: { Origin: origin, Cookie: `cce_session=${user.token}`, "X-CSRF-Token": user.csrf, ...headers, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
 const value = response.status === 204 ? null : await response.json(); return { status: response.status, value };
}
async function until(fn, timeout = 30000) { const end = Date.now() + timeout; while (!await fn()) { if (Date.now() > end) throw new Error("Workspace acceptance timed out"); await pause(200); } }

test("project import, five toolchains, dependencies, terminals and persistent lifecycle", { skip: process.env.CCE_WORKSPACE_TESTS !== "1", timeout: 900000 }, async t => {
 const owner = actor(); const editor = actor(); const viewer = actor(); const outsider = actor(); let project; let browser;
 try {
  const created = await request(owner, "POST", "/api/v1/projects", { name: "Development acceptance" }); assert.equal(created.status, 201); project = created.value.id;
  sql(`INSERT INTO project_members VALUES('${project}','${editor.id}','editor'),('${project}','${viewer.id}','viewer');`);
  const base = `/api/v1/projects/${project}`; const endpoint = `${base}/workspace`;
  const files = [
   { path: "python/main.py", text: "import torch\nprint('tensor:', torch.tensor([1,2,3]).sum().item())\n" },
   { path: "python/requirements.txt", text: "--extra-index-url https://download.pytorch.org/whl/cpu\ntorch==2.9.1+cpu\nnumpy==2.4.2\n" },
   { path: "node/main.mjs", text: "import ansiRegex from 'ansi-regex'; console.log('node:', typeof ansiRegex);\n" },
   { path: "node/package.json", text: JSON.stringify({ name: "workspace-acceptance", version: "1.0.0", type: "module", dependencies: { "ansi-regex": "6.0.1" }, scripts: { build: "node --check main.mjs" } }) },
   { path: "typescript/main.ts", text: "const value: number = 42; console.log('typescript:', value);\n" },
   { path: "cpp/main.cpp", text: '#include <iostream>\nint main(){std::cout << "cpp: 42\\n";}\n' },
   { path: "java/Main.java", text: 'import org.apache.commons.lang3.StringUtils;\nclass Main { public static void main(String[] args) { System.out.println(StringUtils.capitalize("java: 42")); } }\n' },
   { path: "java/pom.xml", text: '<project xmlns="http://maven.apache.org/POM/4.0.0"><modelVersion>4.0.0</modelVersion><groupId>example</groupId><artifactId>acceptance</artifactId><version>1.0</version><properties><maven.compiler.source>17</maven.compiler.source><maven.compiler.target>17</maven.compiler.target></properties><build><sourceDirectory>.</sourceDirectory></build><dependencies><dependency><groupId>org.apache.commons</groupId><artifactId>commons-lang3</artifactId><version>3.17.0</version></dependency></dependencies></project>' },
   { path: "go/main.go", text: 'package main\nimport "fmt"\nfunc main(){fmt.Println("go: 42")}\n' },
   { path: "go/go.mod", text: "module example.com/acceptance\n\ngo 1.27.1\n" },
   { path: "unicode/empty.txt", text: "" }, { path: "unicode/text.txt", text: "नमस्ते\r\n🙂\n" }
  ];
  await t.test("atomic import, exact text, name conflicts, roles and traversal", async () => {
   const imported = await request(owner, "POST", `${base}/import`, { files, parent_id: null }, { "If-Match": "0" }); assert.equal(imported.status, 201, JSON.stringify(imported.value));
   const state = sql(`SELECT encode(s.encoded_state,'base64') FROM files f JOIN documents d ON d.id=f.current_document_id JOIN document_snapshots s ON s.id=d.snapshot_id WHERE f.project_id='${project}' AND f.name='text.txt';`);
   const doc = new Y.Doc(); Y.applyUpdate(doc, Buffer.from(state, "base64")); assert.equal(doc.getText("content").toString(), "नमस्ते\r\n🙂\n"); doc.destroy();
   const tree = (await request(owner, "GET", `${base}/tree`)).value;
   const conflict = await request(owner, "POST", `${base}/import`, { files: [{ path: "new.txt", text: "new" }, files[0]] }, { "If-Match": tree.tree_version }); assert.equal(conflict.status, 409);
   assert.equal((await request(owner, "GET", `${base}/tree`)).value.entries.length, tree.entries.length);
   assert.equal((await request(viewer, "POST", `${base}/import`, { files: [{ path: "forbidden.txt", text: "x" }] }, { "If-Match": tree.tree_version })).status, 403);
   assert.equal((await request(owner, "POST", `${base}/import`, { files: [{ path: "../escape", text: "x" }] }, { "If-Match": tree.tree_version })).status, 400);
   assert.equal((await request(owner, "POST", `${base}/import`, { files: [{ path: "zero.txt", text: "a\0b" }] }, { "If-Match": tree.tree_version })).status, 400);
   assert.equal((await request(owner, "POST", `${base}/import`, { files: [{ path: "stale.txt", text: "x" }] }, { "If-Match": "0" })).status, 409);
  });
  let config = { action: "start", language: "python", root: "python", entrypoint: "main.py" };
  const start = await request(owner, "PUT", endpoint, config); assert.equal(start.status, 200, JSON.stringify(start.value));
  assert.equal((await request(viewer, "PUT", endpoint, config)).status, 403); assert.equal((await request(outsider, "GET", endpoint)).status, 404);
  const checkpoint = await request(owner, "POST", `${base}/checkpoints`, { name: "Workspace acceptance source" }); assert.equal(checkpoint.status, 202);
  await until(async () => (await request(owner, "GET", `${base}/checkpoints/${checkpoint.value.id}`)).status === 200);
  const synced = await request(owner, "POST", `${endpoint}/sync`, { checkpoint_id: checkpoint.value.id }); assert.equal(synced.status, 200, JSON.stringify(synced.value));
  async function task(action, expected) {
   const started = await request(editor, "POST", `${endpoint}/tasks`, { action }); assert.equal(started.status, 202, JSON.stringify(started.value)); let result;
   await until(async () => { result = (await request(owner, "GET", endpoint)).value.task; return result?.state !== "running"; }, 600000);
   assert.equal(result.state, "succeeded", result.log); if (expected) assert.match(result.log, expected); return result;
  }
  await t.test("Python installs CPU PyTorch and executes tensor operations", async () => { await task("install"); await task("run", /tensor: 6/); });
  await t.test("Node installs npm package; build and run use it", async () => { config = { action: "start", language: "node", root: "node", entrypoint: "main.mjs" }; assert.equal((await request(owner, "PUT", endpoint, config)).status, 200); await task("install"); await task("build"); await task("run", /node: function/); });
  await t.test("TypeScript, C++, Java and Go compile and run", async () => {
   for (const [language, root, entrypoint, expected] of [["typescript", "typescript", "main.ts", /typescript: 42/], ["cpp", "cpp", "main.cpp", /cpp: 42/], ["java", "java", "Main", /Java: 42/], ["go", "go", ".", /go: 42/]]) {
    config = { action: "start", language, root, entrypoint }; assert.equal((await request(owner, "PUT", endpoint, config)).status, 200); if (language === "go" || language === "java") await task("install"); if (language !== "typescript") await task("build"); await task("run", expected);
   }
  });
  await t.test("working files and Python dependencies persist after stop/start", async () => {
   docker("exec", `cce-workspace-${project}`, "sh", "-c", "printf persistent > /project/home/acceptance.txt");
   assert.equal((await request(owner, "PUT", endpoint, { ...config, action: "stop" })).status, 200);
   config = { action: "start", language: "python", root: "python", entrypoint: "main.py" }; assert.equal((await request(owner, "PUT", endpoint, config)).status, 200);
   assert.equal(docker("exec", `cce-workspace-${project}`, "cat", "/project/home/acceptance.txt"), "persistent"); await task("run", /tensor: 6/);
   const settings = JSON.parse(docker("inspect", `cce-workspace-${project}`))[0]; assert.equal(settings.Config.User, "1000:1000"); assert.equal(settings.HostConfig.Memory, 2147483648); assert.equal(settings.HostConfig.ReadonlyRootfs, true); assert.ok(!settings.Mounts.some(mount => mount.Destination.includes("docker.sock"))); assert.ok(!settings.Config.Env.some(value => /^(DATABASE_URL|RUNNER_INTERNAL_TOKEN|WORKSPACE_INTERNAL_TOKEN|GITHUB_CLIENT_SECRET)=/.test(value)));
  });
  await t.test("browser import preview, independent shell sessions and revocation", async () => {
   browser = await chromium.launch({ executablePath: process.env.CCE_BROWSER_PATH ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", headless: true, args: ["--no-sandbox", "--disable-gpu", "--host-resolver-rules=MAP localhost 127.0.0.1"] });
   const contexts = [];
   for (const user of [owner, editor, viewer]) { const context = await browser.newContext(); await context.addCookies([{ name: "cce_session", value: user.token, domain: "localhost", path: "/", httpOnly: true, sameSite: "Lax" }]); contexts.push(context); }
   const pages = await Promise.all(contexts.map(context => context.newPage())); for (const page of pages) await page.goto(`${origin}/projects/${project}/workspace`);
   await pages[0].getByRole("button", { name: "Import files", exact: true }).waitFor(); await pages[0].getByLabel("Select local files").setInputFiles([{ name: "browser.txt", mimeType: "text/plain", buffer: Buffer.from("browser import") }, { name: ".env.secret", mimeType: "text/plain", buffer: Buffer.from("fixture secret") }]);
   assert.equal(await pages[0].getByLabel(".env.secret", { exact: true }).isChecked(), false);
   await pages[0].getByRole("button", { name: "Import selected files" }).click(); await pages[0].getByRole("button", { name: "File: browser.txt", exact: true }).waitFor();
   assert.equal(await pages[2].getByRole("button", { name: "Import files", exact: true }).count(), 0);
   const folder = resolve(".tmp", `workspace-import-${project}`, "local-code"); mkdirSync(resolve(folder, "src"), { recursive: true }); mkdirSync(resolve(folder, "node_modules")); writeFileSync(resolve(folder, "src", "nested.py"), "print('folder import')\n"); writeFileSync(resolve(folder, "node_modules", "generated.js"), "ignored");
   await pages[0].getByLabel("Select local folder").setInputFiles(folder); await pages[0].getByRole("button", { name: "Import selected files" }).click(); await pages[0].getByRole("button", { name: "Folder: local-code", exact: true }).waitFor();
   for (const page of pages.slice(0, 2)) { await page.getByRole("button", { name: "Development workspace", exact: true }).click(); await page.getByRole("button", { name: "New terminal", exact: true }).click(); await page.getByText("Connected · your shell session", { exact: true }).waitFor(); }
   await pages[0].locator(".xterm-helper-textarea").pressSequentially("export SESSION_MARKER=owner; printf 'OWNER_OK\\n'\n", { delay: 5 });
   await until(async () => (await pages[0].locator(".xterm-accessibility").innerText()).includes("OWNER_OK"));
   await pages[1].locator(".xterm-helper-textarea").pressSequentially("echo editor:${SESSION_MARKER:-separate}\n", { delay: 5 });
   await until(async () => (await pages[1].locator(".xterm-accessibility").innerText()).includes("editor:separate"));
   mkdirSync(resolve(".tmp", "workspace-acceptance"), { recursive: true }); await pages[0].screenshot({ path: resolve(".tmp", "workspace-acceptance", "desktop.png"), fullPage: true });
   assert.equal((await request(owner, "POST", `${endpoint}/sync`, { checkpoint_id: checkpoint.value.id })).status, 409);
   sql(`DELETE FROM project_members WHERE project_id='${project}' AND user_id='${editor.id}';`);
   await until(async () => await pages[1].getByRole("heading", { name: "Workspace unavailable", exact: true }).isVisible() || await pages[1].getByText("Disconnected", { exact: true }).isVisible(), 10000);
   await pages[0].getByRole("button", { name: "Close terminal 1", exact: true }).click(); await until(async () => (await request(owner, "GET", endpoint)).value.terminals === 0);
   await contexts[0].close(); await contexts[1].close(); await contexts[2].close();
  });
  await t.test("environment deletion is owner-only and retains collaborative source", async () => {
   assert.equal((await request(viewer, "DELETE", endpoint)).status, 403); assert.equal((await request(owner, "DELETE", endpoint)).status, 204);
   assert.equal((await request(owner, "GET", endpoint)).value.state, "absent"); assert.ok((await request(owner, "GET", `${base}/tree`)).value.entries.length > 0);
   assert.equal(docker("volume", "ls", "-q", "--filter", `name=^cce-workspace-data-${project}$`), "");
  });
 } finally {
  await browser?.close(); if (project) { await request(owner, "PUT", `/api/v1/projects/${project}/workspace`, { action: "stop", language: "python", root: ".", entrypoint: "" }).catch(() => {}); await request(owner, "DELETE", `/api/v1/projects/${project}/workspace`).catch(() => {}); await request(owner, "DELETE", `/api/v1/projects/${project}`).catch(() => {}); }
  sql(`UPDATE sessions SET revoked_at=now() WHERE user_id IN ('${owner.id}','${editor.id}','${viewer.id}','${outsider.id}');`);
 }
});

test("idle shutdown and manager restart preserve project storage", { skip: process.env.CCE_WORKSPACE_TESTS !== "1", timeout: 150000 }, async () => {
 // Host Node 22 can unref its last fetch socket while the test awaits a Docker
 // service startup. Keep this bounded test alive until its finally cleanup.
 const keepAlive = setInterval(() => {}, 1000);
 const id = randomUUID(); const agent = `cce-workspace-idle-test-${id}`; const stateVolume = `cce-workspace-test-state-${id}`; const token = randomBytes(32).toString("base64url");
 try {
  const image = docker("image", "inspect", "cce-workspace-toolchains:local", "--format", "{{.Id}}");
  docker("run", "-d", "--name", agent, "--network", "none", "-e", `WORKSPACE_INTERNAL_TOKEN=${token}`, "-e", `WORKSPACE_IMAGE=${image}`, "-e", "WORKSPACE_IDLE_TIMEOUT=1s", "-v", "/var/run/docker.sock:/var/run/docker.sock", "-v", `${stateVolume}:/state`, "collaborative-code-editor-workspaces:latest");
  async function control(method, path, body) {
   const client = "import json,sys,urllib.request,urllib.error\nr=urllib.request.Request('http://127.0.0.1:8090'+sys.argv[2],data=sys.argv[3].encode() if sys.argv[3] else None,headers={'Authorization':'Bearer '+sys.argv[4],'Content-Type':'application/json'},method=sys.argv[1])\ntry:\n s=urllib.request.urlopen(r,timeout=20)\nexcept urllib.error.HTTPError as e:\n s=e\nprint(json.dumps({'status':s.code,'body':None if s.code==204 else json.loads(s.read())}))";
   const raw = execFileSync("docker", ["run", "--rm", "--network", `container:${agent}`, "cce-workspace-toolchains:local", "python3", "-c", client, method, path, body ? JSON.stringify(body) : "", token], { encoding: "utf8", timeout: 30000 });
   return JSON.parse(raw);
  }
  await until(async () => { try { return (await control("GET", "/healthz")).status === 200; } catch { return false; } });
  const config = { action: "start", language: "cpp", root: ".", entrypoint: "main.cpp" }; const started = await control("PUT", `/projects/${id}`, config); assert.equal(started.status, 200, JSON.stringify(started.body));
  assert.match(docker("exec", `cce-workspace-${id}`, "pip", "--version"), /\/project\/deps\/venv/);
  docker("exec", `cce-workspace-${id}`, "sh", "-c", "printf retained > /project/home/retained.txt");
  await until(async () => (await control("GET", `/projects/${id}`)).body.state === "exited", 60000);
  docker("restart", agent); await until(async () => { try { return (await control("GET", "/healthz")).status === 200; } catch { return false; } });
  const restored = await control("GET", `/projects/${id}`); assert.equal(restored.body.language, "cpp"); assert.equal(restored.body.entrypoint, "main.cpp");
  assert.equal((await control("PUT", `/projects/${id}`, config)).status, 200); assert.equal(docker("exec", `cce-workspace-${id}`, "cat", "/project/home/retained.txt"), "retained");
  assert.equal((await control("DELETE", `/projects/${id}`)).status, 204);
 } finally {
  clearInterval(keepAlive);
  // Every resource name is a UUID-scoped fixture created by this test.
  for (const name of [agent, `cce-workspace-${id}`]) { try { docker("rm", "-f", name); } catch {} }
  for (const name of [stateVolume, `cce-workspace-data-${id}`]) { try { if (docker("volume", "ls", "-q", "--filter", `name=^${name}$`)) docker("volume", "rm", name); } catch {} }
 }
});
