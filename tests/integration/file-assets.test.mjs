import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID, randomBytes } from "node:crypto";
import { chromium } from "playwright-core";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
const sha = data => createHash("sha256").update(data).digest("hex");
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const sql = input => execFileSync("docker", ["exec", "-i", "collaborative-code-editor-postgres-1", "psql", "-U", "cce", "-d", "cce", "-At", "-v", "ON_ERROR_STOP=1"], { input, encoding: "utf8", timeout: 30000 }).trim();
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8", timeout: 30000 }).trim();
async function until(fn, timeout = 45000) { const end = Date.now() + timeout; while (!await fn()) { if (Date.now() > end) throw new Error("Asset acceptance timed out"); await pause(200); } }

test("arbitrary file types retain bytes through import, download, checkpoint, restore and workspace sync", { skip: process.env.CCE_WORKSPACE_TESTS !== "1", timeout: 240000 }, async () => {
 const keepAlive = setInterval(() => {}, 1000); let project, browser; const actors = [];
 try {
  for (const role of ["owner", "viewer", "outsider"]) {
   const id = randomUUID(); const token = randomBytes(32).toString("base64url"); const csrf = createHash("sha256").update("cce-csrf-v1:" + token).digest("base64url");
   sql(`INSERT INTO users(id,provider,provider_subject,display_name) VALUES('${id}','github','${id}','Asset ${role}'); INSERT INTO sessions(user_id,token_hash,csrf_hash,expires_at) VALUES('${id}',decode('${sha(token)}','hex'),decode('${sha(csrf)}','hex'),now()+interval '1 hour');`); actors.push({ id, token, csrf });
  }
  async function request(method, path, body, actor = 0, extra = {}) {
   const user = actors[actor]; return fetch("http://127.0.0.1:3000" + path, { method, signal: AbortSignal.timeout(90000), headers: { Origin: "http://localhost:3000", Cookie: `cce_session=${user.token}`, "X-CSRF-Token": user.csrf, ...extra, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  }
  const created = await request("POST", "/api/v1/projects", { name: "All file types acceptance" }); assert.equal(created.status, 201); project = (await created.json()).id;
  sql(`INSERT INTO project_members VALUES('${project}','${actors[1].id}','viewer');`);
  const base = `/api/v1/projects/${project}`;
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j6mAAAAAASUVORK5CYII=", "base64");
  const assets = [
   ["pixel.png", png], ["report.pdf", Buffer.from("%PDF-1.7\n\0\x80original bytes")], ["archive.zip", Buffer.from([80,75,3,4,0,255,254,128])],
   ["module.wasm", Buffer.from([0,97,115,109,1,0,0,0])], ["program.exe", Buffer.from([77,90,0,255,128])], ["arbitrary.extension", Buffer.from(Array.from({ length: 256 }, (_, i) => i))],
   ["legacy.txt", Buffer.from([255,254,65,0,66,0])], ["large.txt", Buffer.alloc(600000, 65)], ["empty.bin", Buffer.alloc(0)],
   ["unsafe.html", Buffer.from("<!doctype html><html><script>alert('not executed')</script></html>")],
  ];
  const response = await request("POST", `${base}/import`, { files: [{ path: "main.py", text: "from pathlib import Path\nprint(Path('archive.zip').read_bytes().hex())\n" }, ...assets.map(([path, bytes]) => ({ path, data_base64: bytes.toString("base64") }))] }, 0, { "If-Match": "0" }); assert.equal(response.status, 201, await response.clone().text());
  let tree = await (await request("GET", `${base}/tree`)).json();
  for (const [name, bytes] of assets) {
   const entry = tree.entries.find(item => item.name === name); assert.equal(entry.storage_kind, "asset");
   const download = await request("GET", `${base}/files/${entry.id}/asset`); assert.equal(download.status, 200); assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes); assert.match(download.headers.get("content-disposition"), /attachment/);
   assert.equal((await request("GET", `${base}/files/${entry.id}/asset`, null, 1)).status, 200);
   assert.equal((await request("GET", `${base}/files/${entry.id}/asset`, null, 2)).status, 404);
  }
  const unsafe = tree.entries.find(item => item.name === "unsafe.html"); const unsafeDownload = await request("GET", `${base}/files/${unsafe.id}/asset?preview=1`); assert.match(unsafeDownload.headers.get("content-disposition"), /attachment/); assert.match(unsafeDownload.headers.get("content-security-policy"), /sandbox/); await unsafeDownload.arrayBuffer();
  const invalid = await request("POST", `${base}/import`, { files: [{ path: "new.bin", data_base64: "not base64!" }] }, 0, { "If-Match": tree.tree_version }); assert.equal(invalid.status, 400);
  const forbidden = await request("POST", `${base}/import`, { files: [{ path: "forbidden.bin", data_base64: "AA==" }] }, 1, { "If-Match": tree.tree_version }); assert.equal(forbidden.status, 403);
  const conflict = await request("POST", `${base}/import`, { files: [{ path: "fresh.bin", data_base64: "AA==" }, { path: "pixel.png", data_base64: "AA==" }] }, 0, { "If-Match": tree.tree_version }); assert.equal(conflict.status, 409); assert.equal((await (await request("GET", `${base}/tree`)).json()).entries.length, tree.entries.length);
  const captured = await request("POST", `${base}/checkpoints`, { name: "All file formats" }); assert.equal(captured.status, 202); const checkpoint = await captured.json(); let manifest;
  await until(async () => { const response = await request("GET", `${base}/checkpoints/${checkpoint.id}`); if (!response.ok) return false; manifest = await response.json(); return true; });
  for (const [name, bytes] of assets) { const file = manifest.files.find(item => item.path === name); assert.equal(file.asset, true); const saved = await request("GET", `${base}/checkpoints/${checkpoint.id}/files/${file.file_id}`); assert.deepEqual(Buffer.from(await saved.arrayBuffer()), bytes); }
  const pixel = tree.entries.find(item => item.name === "pixel.png"); assert.equal((await request("DELETE", `${base}/tree/${pixel.id}`, null, 0, { "If-Match": tree.tree_version })).status, 204);
  tree = await (await request("GET", `${base}/tree`)).json(); const restored = await request("POST", `${base}/checkpoints/${checkpoint.id}/restore`, {}, 0, { "If-Match": tree.tree_version }); assert.equal(restored.status, 200, await restored.clone().text());
  tree = await (await request("GET", `${base}/tree`)).json(); for (const [name, bytes] of assets) { const entry = tree.entries.find(item => item.name === name); assert.equal(entry.storage_kind, "asset"); assert.equal(entry.generation, "2"); const restoredData = await request("GET", `${base}/files/${entry.id}/asset`); assert.deepEqual(Buffer.from(await restoredData.arrayBuffer()), bytes); }
  const config = { action: "start", language: "python", root: ".", entrypoint: "main.py" }; assert.equal((await request("PUT", `${base}/workspace`, config)).status, 200);
  assert.equal((await request("POST", `${base}/workspace/sync`, { checkpoint_id: checkpoint.id })).status, 200);
  for (const [name, bytes] of assets) { const command = "import hashlib,sys;print(hashlib.sha256(open(sys.argv[1],'rb').read()).hexdigest())"; assert.equal(docker("exec", `cce-workspace-${project}`, "python", "-c", command, `/project/work/${name}`), sha(bytes)); }
  const run = await request("POST", `${base}/workspace/tasks`, { action: "run" }); assert.equal(run.status, 202); let environment; await until(async () => { environment = await (await request("GET", `${base}/workspace`)).json(); return environment.task.state !== "running"; }); assert.equal(environment.task.state, "succeeded", environment.task.log); assert.match(environment.task.log, /504b030400fffe80/);
  const restricted = await request("POST", `${base}/runs`, { runtime: "python", entrypoint: "main.py", stdin: "" }, 0, { "Idempotency-Key": randomUUID() }); assert.equal(restricted.status, 409);
  browser = await chromium.launch({ executablePath: process.env.CCE_BROWSER_PATH ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", headless: true, args: ["--no-sandbox", "--disable-gpu", "--host-resolver-rules=MAP localhost 127.0.0.1"] });
  const context = await browser.newContext(); await context.addCookies([{ name: "cce_session", value: actors[0].token, domain: "localhost", path: "/", httpOnly: true, sameSite: "Lax" }]); const page = await context.newPage(); await page.goto(`http://localhost:3000/projects/${project}/workspace`);
  await page.getByRole("button", { name: "File: pixel.png", exact: true }).click(); await page.getByRole("link", { name: "Download original", exact: true }).waitFor(); await page.waitForFunction(() => document.querySelector('.asset-image img')?.naturalWidth > 0);
  assert.equal(await page.locator('.monaco-editor').count(), 0);
  const assetDocument = tree.entries.find(item => item.name === 'pixel.png').document_id;
  const admission = await page.evaluate(document => new Promise(resolve => { const socket = new WebSocket(`ws://localhost:3000/ws/documents/${document}`); const timer = setTimeout(() => { socket.close(); resolve('timeout'); }, 5000); socket.onerror = () => { clearTimeout(timer); resolve('rejected'); }; socket.onopen = () => { clearTimeout(timer); socket.close(); resolve('admitted'); }; }), assetDocument);
  assert.equal(admission, 'rejected', 'Original-byte files must not enter the text collaboration protocol');
  await page.getByRole("button", { name: "File: report.pdf", exact: true }).click(); await page.getByText("This file is stored in its original format.", { exact: false }).waitFor();
  await page.getByLabel("Select local files", { exact: true }).setInputFiles([{ name: "browser.zip", mimeType: "application/zip", buffer: assets[2][1] }, { name: "big-source.txt", mimeType: "text/plain", buffer: Buffer.alloc(400000, 66) }]); await page.getByRole("button", { name: "Import selected files", exact: true }).click(); await page.getByRole("button", { name: "File: browser.zip", exact: true }).waitFor(); await page.getByRole("button", { name: "File: big-source.txt", exact: true }).waitFor();
  const folder = resolve(".tmp", `asset-folder-${project}`, "all-files"); mkdirSync(resolve(folder, "node_modules"), { recursive: true }); writeFileSync(resolve(folder, "node_modules", "sample.bin"), assets[5][1]); await page.getByLabel("Select local folder", { exact: true }).setInputFiles(folder); await page.getByRole("button", { name: "Import selected files", exact: true }).click(); await page.getByRole("button", { name: "File: sample.bin", exact: true }).waitFor();
  mkdirSync(".tmp/file-assets", { recursive: true }); await page.screenshot({ path: ".tmp/file-assets/imported.png", fullPage: true });
 } finally {
  await browser?.close(); if (project && actors.length) { const user = actors[0]; const headers = { Origin: "http://localhost:3000", Cookie: `cce_session=${user.token}`, "X-CSRF-Token": user.csrf, "Content-Type": "application/json" }; await fetch(`http://127.0.0.1:3000/api/v1/projects/${project}/workspace`, { method: "PUT", headers, body: JSON.stringify({ action: "stop", language: "python", root: ".", entrypoint: "" }) }).catch(() => {}); await fetch(`http://127.0.0.1:3000/api/v1/projects/${project}/workspace`, { method: "DELETE", headers }).catch(() => {}); await fetch(`http://127.0.0.1:3000/api/v1/projects/${project}`, { method: "DELETE", headers }).catch(() => {}); }
  if (actors.length) sql(`UPDATE sessions SET revoked_at=now() WHERE user_id IN (${actors.map(actor => `'${actor.id}'`).join(",")});`); clearInterval(keepAlive);
 }
});
