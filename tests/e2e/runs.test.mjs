import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash, randomUUID, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { Pool } from "pg";
import { chromium } from "playwright-core";
import { decodeEnvelope, FrameType } from "@cce/protocol";
import * as Y from "yjs";
const database = process.env.TEST_DATABASE_URL;
const sha = bytes => createHash("sha256").update(bytes).digest();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, timeout = 30000) { const end = Date.now() + timeout; while (!await predicate()) { if (Date.now() > end) throw new Error("Run UI acceptance timed out"); await pause(80); } }
async function type(page, value) { await page.locator(".monaco-editor").click(); await page.keyboard.press("Control+End"); await page.keyboard.insertText(value); }
test("Phase 07 Run waits for receipts and executes captured cut while a peer edits", { skip: !database || process.env.CCE_EXECUTION_TESTS !== "1", timeout: 120000 }, async () => {
  const pool = new Pool({ connectionString: database }); const users = [];
  for (const role of ["owner", "editor", "viewer"]) {
    const id = (await pool.query("INSERT INTO users(provider,provider_subject,display_name) VALUES('github',$1,$2) RETURNING id", [randomUUID(), `Run ${role}`])).rows[0].id;
    const token = randomBytes(32).toString("base64url"), csrf = sha("cce-csrf-v1:" + token).toString("base64url");
    await pool.query("INSERT INTO sessions(user_id,token_hash,csrf_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')", [id, sha(token), sha(csrf)]); users.push({ id, token, role });
  }
  const tx = await pool.connect(); let project, file, document;
  try { await tx.query("BEGIN"); project = (await tx.query("INSERT INTO projects(owner_id,name) VALUES($1,'Immutable run UI') RETURNING id", [users[0].id])).rows[0].id; for (const user of users) await tx.query("INSERT INTO project_members VALUES($1,$2,$3)", [project, user.id, user.role]);
    file = (await tx.query("INSERT INTO files(project_id,name,kind,language) VALUES($1,'main.js','file','javascript') RETURNING id", [project])).rows[0].id; document = (await tx.query("INSERT INTO documents(file_id,generation) VALUES($1,1) RETURNING id", [file])).rows[0].id;
    const snapshot = (await tx.query("INSERT INTO document_snapshots(document_id,through_sequence,encoded_state,state_vector,checksum) VALUES($1,0,$2,$3,$4) RETURNING id", [document, Buffer.from([0, 0]), Buffer.from([0]), sha(Buffer.from([0, 0]))])).rows[0].id;
    await tx.query("UPDATE documents SET snapshot_id=$2 WHERE id=$1", [document, snapshot]); await tx.query("UPDATE files SET current_document_id=$2 WHERE id=$1", [file, document]); await tx.query("COMMIT");
  } catch (error) { await tx.query("ROLLBACK"); throw error; } finally { tx.release(); }
  const browser = await chromium.launch({ executablePath: process.env.CCE_BROWSER_PATH ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", headless: true, args: ["--no-sandbox", "--disable-gpu", "--host-resolver-rules=MAP localhost 127.0.0.1"] });
  const contexts = [], pages = [], errors = []; const liveDocuments = new Set(); let holdACK = false, pendingACK = [];
  try {
    for (const [index, user] of users.entries()) {
      const context = await browser.newContext(); contexts.push(context); await context.addCookies([{ name: "cce_session", value: user.token, domain: "localhost", path: "/", httpOnly: true, sameSite: "Lax" }]);
      if (index === 0) await context.addInitScript(() => {
        const NativeEventSource = window.EventSource; let interrupted = false;
        window.runStreamRequests = [];
        window.EventSource = class extends NativeEventSource {
          constructor(url, options) {
            super(url, options);
            if (!String(url).includes("/runs/")) return;
            window.runStreamRequests.push(String(url));
            this.addEventListener("message", event => {
              if (!interrupted && JSON.parse(event.data).kind === "stdout") {
                interrupted = true; this.close(); this.dispatchEvent(new Event("error"));
              }
            });
          }
        };
      });
      if (index === 0) await context.routeWebSocket(/\/ws\/documents\//, client => { const server = client.connectToServer(); liveDocuments.add(client); client.onClose(() => { liveDocuments.delete(client); server.close(); }); server.onClose(() => client.close()); client.onMessage(message => server.send(message)); server.onMessage(message => { const frame = decodeEnvelope(new Uint8Array(message), "server"); if (frame.type === FrameType.DURABLE_ACK && holdACK) pendingACK.push(() => client.send(message)); else client.send(message); }); });
      const page = await context.newPage(); pages.push(page); page.on("pageerror", error => errors.push(error.message)); await page.goto(`http://localhost:3000/projects/${project}/workspace`); await page.getByRole("button", { name: "File: main.js" }).click(); await until(async () => ["Synced", "Saved"].includes(await page.locator(".editor-breadcrumb span").textContent()));
    }
    const [a, b, v] = pages; assert.equal(await v.getByRole("button", { name: "Run", exact: true }).isEnabled(), false);
    await a.getByRole("button", { name: "Run", exact: true }).click(); await a.getByLabel("Runtime", { exact: true }).selectOption("javascript"); await a.getByLabel("Entrypoint", { exact: true }).selectOption("main.js");
    holdACK = true; await type(a, "console.log('captured');setTimeout(()=>console.log('done'),1800);"); await until(async () => pendingACK.length > 0);
    await a.getByRole("button", { name: "Run captured source", exact: true }).click(); await until(async () => await a.getByText("Waiting for edit receipts", { exact: true }).count() > 0);
    await pause(500); assert.equal((await pool.query("SELECT count(*) FROM run_jobs WHERE project_id=$1", [project])).rows[0].count, "0", "Run captured before durable ACK");
    holdACK = false; for (const deliver of pendingACK) deliver(); pendingACK = [];
    let job; await until(async () => { job = (await pool.query("SELECT id,checkpoint_id,state FROM run_jobs WHERE project_id=$1", [project])).rows[0]; return Boolean(job); });
    await type(b, "\nconsole.log('later-peer-edit');"); await until(async () => (await b.locator(".editor-breadcrumb span").textContent()) === "Saved");
    await until(async () => (await pool.query("SELECT state FROM run_jobs WHERE id=$1", [job.id])).rows[0].state === "succeeded");
    await until(async () => (await a.getByRole("region", { name: "Run output", exact: true }).textContent()).includes("done"));
    const output = await a.getByRole("region", { name: "Run output", exact: true }).textContent(); assert.match(output, /captured/); assert.ok(!output.includes("later-peer-edit")); assert.ok(await a.getByText(job.checkpoint_id, { exact: true }).count());
    assert.equal(output.match(/captured/g)?.length, 1, "Reconnected output duplicated text");
    assert.ok((await a.evaluate(() => window.runStreamRequests)).some(url => /after=[1-9][0-9]*$/.test(url)), "Output did not resume from its durable cursor");
    await until(async () => (await a.locator(".output-heading span").textContent()) === "succeeded"); await a.getByText(/Exit 0/).waitFor();
    const captured = (await pool.query("SELECT cf.*,s.encoded_state FROM checkpoint_files cf JOIN document_snapshots s ON s.id=cf.snapshot_id WHERE checkpoint_id=$1 AND file_id=$2", [job.checkpoint_id, file])).rows[0];
    const independent = new Y.Doc(); independent.getText("content"); Y.applyUpdate(independent, captured.encoded_state); for (const row of (await pool.query("SELECT update_bytes FROM document_updates WHERE document_id=$1 AND sequence>$2 AND sequence<=$3 ORDER BY document_updates.sequence", [document, captured.snapshot_sequence, captured.through_sequence])).rows) Y.applyUpdate(independent, row.update_bytes); assert.ok(!independent.getText("content").toString().includes("later-peer-edit")); independent.destroy();
    await a.getByRole("button", { name: "New file", exact: true }).click(); await a.getByRole("form", { name: "File tree action" }).getByLabel("Name").fill("other.js"); await a.getByRole("form", { name: "File tree action" }).getByRole("button", { name: "Save", exact: true }).click();
    await a.getByRole("tab", { name: "other.js", exact: true }).waitFor(); await until(async () => ["Synced", "Saved"].includes(await a.locator(".editor-breadcrumb span").textContent()));
    await a.getByRole("tab", { name: "main.js", exact: true }).click(); await until(async () => ["Synced", "Saved"].includes(await a.locator(".editor-breadcrumb span").textContent()));
    holdACK = true; await type(a, "\nconsole.log('closed-file-draft');"); await until(async () => pendingACK.length > 0); await a.getByRole("button", { name: "Close main.js", exact: true }).click(); pendingACK = []; holdACK = false;
    await until(async () => ["Synced", "Saved"].includes(await a.locator(".editor-breadcrumb span").textContent()));
    holdACK = true; await a.getByRole("button", { name: "Run", exact: true }).click(); await a.getByLabel("Entrypoint", { exact: true }).selectOption("main.js"); await a.getByRole("button", { name: "Run captured source", exact: true }).click();
    await until(async () => pendingACK.length > 0); assert.equal((await pool.query("SELECT count(*) FROM run_jobs WHERE project_id=$1", [project])).rows[0].count, "1", "Closed-file receipt not awaited before capture");
    await until(async () => [...liveDocuments].every(client => client.url().endsWith(document))); assert.equal(liveDocuments.size, 1, "Closed-file flush opened more than one active document transport");
    holdACK = false; for (const deliver of pendingACK) deliver(); pendingACK = [];
    await until(async () => { job = (await pool.query("SELECT id,checkpoint_id,state FROM run_jobs WHERE project_id=$1 ORDER BY created_at DESC", [project])).rows[0]; return job.state === "succeeded" && (await pool.query("SELECT count(*) FROM run_jobs WHERE project_id=$1", [project])).rows[0].count === "2"; });
    await until(async () => (await a.getByRole("region", { name: "Run output", exact: true }).textContent()).includes("closed-file-draft"));
    await until(async () => (await a.locator(".output-heading span").textContent()) === "succeeded"); await a.getByText(/Exit 0/).waitFor();
    assert.equal(await a.evaluate(() => new Promise((resolve, reject) => { const request = indexedDB.open("cce-drafts-v1", 1); request.onerror = () => reject(request.error); request.onsuccess = () => { const db = request.result; const tx = db.transaction("drafts", "readonly"); const rows = tx.objectStore("drafts").getAll(); tx.oncomplete = () => { db.close(); resolve(rows.result.reduce((sum, row) => sum + row.pending.length, 0)); }; }; })), 0, "Run left pending local edits");
    mkdirSync(".tmp", { recursive: true }); await a.screenshot({ path: ".tmp/phase07-runs-desktop.png", fullPage: true }); await a.setViewportSize({ width: 390, height: 844 }); await a.screenshot({ path: ".tmp/phase07-runs-narrow.png", fullPage: true }); assert.equal(await a.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true); assert.deepEqual(errors, []);
  } catch (error) {
    mkdirSync(".tmp", { recursive: true }); await pages[0]?.screenshot({ path: ".tmp/phase07-runs-failure.png", fullPage: true });
    console.error("Run browser diagnostics", JSON.stringify({ output: await pages[0]?.getByRole("region", { name: "Run output", exact: true }).textContent().catch(() => "missing"), errors }));
    throw error;
  } finally { await browser.close(); await pool.end(); }
});
