import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { Pool } from "pg";
import * as Y from "yjs";

const databaseURL = process.env.TEST_DATABASE_URL;
const origin = process.env.CCE_E2E_ORIGIN ?? "http://localhost:3000";
async function until(check, message, timeout = 30000) { const deadline = Date.now() + timeout; while (!await check()) { if (Date.now() > deadline) throw new Error(message); await new Promise(resolve => setTimeout(resolve, 80)); } }
const sha = value => createHash("sha256").update(value).digest();
test("Phase 08 real two-account search, lag/version, safe snippets and lifecycle visibility", { skip: !databaseURL, timeout: 150000 }, async () => {
  const pool = new Pool({ connectionString: databaseURL }); const users = [];
  for (const role of ["owner", "viewer", "outsider"]) {
    const id = (await pool.query("INSERT INTO users(provider,provider_subject,display_name) VALUES('github',$1,$2) RETURNING id::text", [randomUUID(), `Search ${role}`])).rows[0].id;
    const token = randomBytes(32).toString("base64url"), csrf = sha("cce-csrf-v1:" + token).toString("base64url");
    await pool.query("INSERT INTO sessions(user_id,token_hash,csrf_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')", [id, sha(token), sha(csrf)]); users.push({ id, token, csrf, role });
  }
  const tx = await pool.connect(); let project, file, document;
  const source = "needle <script>window.searchInjection = true</script> Ω";
  const doc = new Y.Doc(); doc.getText("content").insert(0, source); const state = Y.encodeStateAsUpdate(doc), vector = Y.encodeStateVector(doc); doc.destroy();
  try {
    await tx.query("BEGIN"); project = (await tx.query("INSERT INTO projects(owner_id,name) VALUES($1,'Search browser acceptance') RETURNING id::text", [users[0].id])).rows[0].id;
    for (const user of users.slice(0, 2)) await tx.query("INSERT INTO project_members(project_id,user_id,role) VALUES($1,$2,$3)", [project, user.id, user.role]);
    file = (await tx.query("INSERT INTO files(project_id,name,kind,language) VALUES($1,'main.js','file','javascript') RETURNING id::text", [project])).rows[0].id;
    document = (await tx.query("INSERT INTO documents(file_id,generation,committed_text_bytes) VALUES($1,1,$2) RETURNING id::text", [file, Buffer.byteLength(source)])).rows[0].id;
    const snapshot = (await tx.query("INSERT INTO document_snapshots(document_id,through_sequence,encoded_state,state_vector,checksum) VALUES($1,0,$2,$3,$4) RETURNING id", [document, state, vector, sha(state)])).rows[0].id;
    await tx.query("UPDATE documents SET snapshot_id=$2 WHERE id=$1", [document, snapshot]); await tx.query("UPDATE files SET current_document_id=$1 WHERE id=$2", [document, file]); await tx.query("COMMIT");
  } catch (error) { await tx.query("ROLLBACK"); throw error; } finally { tx.release(); }
  const browser = await chromium.launch({ executablePath: process.env.CCE_BROWSER_PATH ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", headless: true, args: ["--no-sandbox", "--disable-gpu", "--host-resolver-rules=MAP localhost 127.0.0.1"] });
  const contexts = [], pages = [], errors = []; const base = `/api/v1/projects/${project}`;
  try {
    await until(async () => (await pool.query("SELECT through_sequence FROM search_documents WHERE file_id=$1", [file])).rows.length === 1, "Search worker did not index initial committed source");
    for (const user of users) {
      const context = await browser.newContext(); contexts.push(context); await context.addCookies([{ name: "cce_session", value: user.token, domain: "localhost", path: "/", httpOnly: true, sameSite: "Lax" }]);
      const page = await context.newPage(); pages.push(page); page.on("pageerror", error => errors.push(error.message));
      await page.goto(`${origin}/projects/${project}/workspace`);
    }
    const [owner, viewer, outsider] = pages;
    assert.equal(await outsider.evaluate(async path => (await fetch(path)).status, `${base}/search?q=needle`), 404);
    for (const page of [owner, viewer]) { await page.getByRole("button", { name: "Search project", exact: true }).click(); await page.getByLabel("Filename or content").fill("needle"); await page.getByRole("button", { name: "Search", exact: true }).click(); }
    const results = viewer.getByRole("list", { name: "Search results" });
    await results.getByRole("button", { name: "Open search result main.js" }).waitFor();
    assert.equal(await results.locator("pre").textContent(), source); assert.equal(await viewer.evaluate(() => window.searchInjection), undefined);
    await results.getByRole("button", { name: "Open search result main.js" }).click(); await viewer.getByRole("tab", { name: "main.js", exact: true }).waitFor();
    await owner.getByRole("button", { name: "File: main.js" }).click(); await until(async () => ["Saved", "Synced"].includes(await owner.locator(".editor-breadcrumb span").textContent()), "Owner did not sync");
    // Fixture-scoped durable claim barrier keeps indexing behind a real receipt.
    await pool.query("UPDATE search_tasks SET claim_id=$2,lease_expires_at=clock_timestamp()+interval '1 hour' WHERE file_id=$1", [file, randomUUID()]);
    await owner.locator(".monaco-editor").click(); await owner.keyboard.press("Control+End"); await owner.keyboard.insertText(" liveonly");
    await until(async () => (await owner.locator(".editor-breadcrumb span").textContent()) === "Saved", "Edit was not durably acknowledged");
    const head = (await pool.query("SELECT last_committed_sequence::text FROM documents WHERE id=$1", [document])).rows[0].last_committed_sequence;
    assert.ok(BigInt(head) > 0n);
    await viewer.getByRole("button", { name: "Refresh results" }).click(); await results.getByText(`Indexed version 0 · behind committed version ${head}`, { exact: true }).waitFor();
    assert.equal(await results.locator("pre").textContent(), source);
    await pool.query("UPDATE search_tasks SET claim_id=NULL,lease_expires_at=NULL,retry_at=clock_timestamp() WHERE file_id=$1", [file]);
    await until(async () => (await pool.query("SELECT through_sequence::text FROM search_documents WHERE file_id=$1", [file])).rows[0]?.through_sequence === head, "Search worker did not catch up");
    await viewer.getByLabel("Filename or content").fill("liveonly"); await viewer.getByRole("button", { name: "Search", exact: true }).click(); await results.getByText(`Indexed version ${head} · current at search`, { exact: true }).waitFor();
    assert.ok((await results.locator("pre").textContent()).includes("liveonly"));
    mkdirSync(".tmp", { recursive: true }); await viewer.screenshot({ path: ".tmp/phase08-search-desktop.png", fullPage: true });
    await viewer.setViewportSize({ width: 390, height: 844 }); await viewer.screenshot({ path: ".tmp/phase08-search-narrow.png", fullPage: true }); assert.equal(await viewer.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    const mutation = await owner.evaluate(async ({ base, file, csrf }) => { const tree = await (await fetch(`${base}/tree`)).json(); return (await fetch(`${base}/tree/${file}`, { method: "PATCH", headers: { "content-type": "application/json", "X-CSRF-Token": csrf, "If-Match": tree.tree_version }, body: JSON.stringify({ name: "renamed.js" }) })).status; }, { base, file, csrf: users[0].csrf }); assert.equal(mutation, 200);
    await results.getByRole("button", { name: "Open search result renamed.js" }).waitFor();
    const deleted = await owner.evaluate(async ({ base, file, csrf }) => { const tree = await (await fetch(`${base}/tree`)).json(); return (await fetch(`${base}/tree/${file}`, { method: "DELETE", headers: { "X-CSRF-Token": csrf, "If-Match": tree.tree_version } })).status; }, { base, file, csrf: users[0].csrf }); assert.equal(deleted, 204);
    await viewer.getByRole("status").getByText("No matching files or indexed content.").waitFor(); assert.equal(await results.locator("pre").count(), 0);
    assert.equal(await owner.evaluate(async ({ base, user, csrf }) => (await fetch(`${base}/members/${user}`, { method: "DELETE", headers: { "X-CSRF-Token": csrf } })).status, { base, user: users[1].id, csrf: users[0].csrf }), 204);
    assert.equal(await viewer.evaluate(async path => (await fetch(path)).status, `${base}/search?q=needle`), 404); assert.deepEqual(errors, []);
  } finally { await pool.query("UPDATE search_tasks SET claim_id=NULL,lease_expires_at=NULL WHERE file_id=$1", [file]); await Promise.all(contexts.map(context => context.close())); await browser.close(); await pool.end(); }
});
