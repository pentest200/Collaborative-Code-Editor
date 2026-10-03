import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { Pool } from "pg";
import * as Y from "yjs";
import { decodeEnvelope, FrameType } from "@cce/protocol";

const databaseURL = process.env.TEST_DATABASE_URL;
const origin = process.env.CCE_E2E_ORIGIN ?? "http://localhost:3000";
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, message, timeout = 20000) { const end = Date.now() + timeout; while (!await predicate()) { if (Date.now() > end) throw new Error(message); await pause(80); } }
async function text(page) { return (await page.locator(".view-lines").innerText()).replace(/[\s\u200b]+/g, ""); }
async function type(page, value) { await page.locator(".monaco-editor").click(); await page.keyboard.press("Control+End"); await page.keyboard.insertText(value); }
async function settled(page) { await until(async () => ["Synced", "Saved"].includes(await page.locator(".editor-breadcrumb span").textContent()), "Document did not settle"); }
async function downloadText(page, path) {
  const result = await page.evaluate(async path => { const response = await fetch(path, { cache: "no-store" }); return { status: response.status, body: await response.text() }; }, path);
  assert.equal(result.status, 200, result.body); return result.body;
}
async function drafts(page) {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open("cce-drafts-v1", 1); request.onerror = () => reject(request.error);
    request.onsuccess = () => { const db = request.result; const tx = db.transaction("drafts", "readonly"); const rows = tx.objectStore("drafts").getAll(); tx.oncomplete = () => { db.close(); resolve(rows.result.map(row => ({ ...row, state: Array.from(row.state) }))); }; };
  }));
}
async function seed(pool) {
  const users = [];
  for (const role of ["owner", "editor", "editor", "viewer"]) {
    const id = (await pool.query("INSERT INTO users(provider,provider_subject,display_name) VALUES('github',$1,$2) RETURNING id::text", [randomUUID(), `Checkpoint ${role} ${users.length}`])).rows[0].id;
    const token = randomBytes(32).toString("base64url"); const csrf = createHash("sha256").update("cce-csrf-v1:" + token).digest("base64url");
    await pool.query("INSERT INTO sessions(user_id,token_hash,csrf_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')", [id, createHash("sha256").update(token).digest(), createHash("sha256").update(csrf).digest()]);
    users.push({ id, token, csrf, role });
  }
  const tx = await pool.connect(); let project, file, document;
  try {
    await tx.query("BEGIN"); project = (await tx.query("INSERT INTO projects(owner_id,name) VALUES($1,'Checkpoint browser acceptance') RETURNING id::text", [users[0].id])).rows[0].id;
    for (const user of users) await tx.query("INSERT INTO project_members(project_id,user_id,role) VALUES($1,$2,$3)", [project, user.id, user.role]);
    file = (await tx.query("INSERT INTO files(project_id,name,kind,language) VALUES($1,'main.js','file','javascript') RETURNING id::text", [project])).rows[0].id;
    document = (await tx.query("INSERT INTO documents(file_id,generation) VALUES($1,1) RETURNING id::text", [file])).rows[0].id;
    const snapshot = (await tx.query("INSERT INTO document_snapshots(document_id,through_sequence,encoded_state,state_vector,checksum) VALUES($1,0,$2,$3,$4) RETURNING id", [document, Buffer.from([0, 0]), Buffer.from([0]), createHash("sha256").update(Buffer.from([0, 0])).digest()])).rows[0].id;
    await tx.query("UPDATE documents SET snapshot_id=$2 WHERE id=$1", [document, snapshot]);
    await tx.query("UPDATE files SET current_document_id=$1 WHERE id=$2", [document, file]); await tx.query("COMMIT");
  } catch (error) { await tx.query("ROLLBACK"); throw error; } finally { tx.release(); }
  return { project, file, document, users };
}

test("Phase 06 real checkpoint UI, continued edits, restore rebind and offline generation recovery", { skip: !databaseURL, timeout: 180000 }, async () => {
  const pool = new Pool({ connectionString: databaseURL }); const data = await seed(pool);
  const browser = await chromium.launch({ executablePath: process.env.CCE_BROWSER_PATH ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", headless: true, args: ["--no-sandbox", "--disable-gpu", "--host-resolver-rules=MAP localhost 127.0.0.1"] });
  const contexts = [], pages = []; const errors = [];
  const offline = { enabled: false, routes: [], oldUpdates: 0 };
  try {
    for (const [index, user] of data.users.entries()) {
      const context = await browser.newContext(); contexts.push(context);
      await context.addCookies([{ name: "cce_session", value: user.token, domain: "localhost", path: "/", httpOnly: true, sameSite: "Lax" }]);
      if (index === 1) await context.routeWebSocket(/\/ws\//, client => {
        if (offline.enabled) { client.close({ code: 1012 }); return; }
        const server = client.connectToServer(); const route = { client, server }; offline.routes.push(route);
        client.onClose(() => { server.close(); offline.routes = offline.routes.filter(item => item !== route); });
        server.onClose(() => { client.close(); offline.routes = offline.routes.filter(item => item !== route); });
        client.onMessage(message => {
          if (client.url().endsWith(data.document)) { const frame = decodeEnvelope(new Uint8Array(message), "client"); if (frame.type === FrameType.DURABLE_UPDATE) offline.oldUpdates++; }
          server.send(message);
        }); server.onMessage(message => client.send(message));
      });
      const page = await context.newPage(); pages.push(page); page.on("pageerror", error => errors.push(error.message));
      await page.goto(`${origin}/projects/${data.project}/workspace`); await page.getByRole("button", { name: "File: main.js" }).click(); await settled(page);
    }
    const [a, b, c, v] = pages;
    await type(a, "baseline"); await settled(a); await until(async () => (await text(b)).includes("baseline") && (await text(c)).includes("baseline"), "Initial convergence");
    await a.getByRole("button", { name: "Checkpoints", exact: true }).click();
    await a.getByLabel("Checkpoint name").fill("Three actor cut");
    const continued = Promise.all([type(b, "peer"), type(c, "third")]);
    await a.getByRole("button", { name: "Capture checkpoint", exact: true }).click(); await continued;
    await a.getByRole("button", { name: "Preview Three actor cut" }).waitFor();
    const cp = (await pool.query("SELECT id::text FROM checkpoints WHERE project_id=$1 AND name='Three actor cut'", [data.project])).rows[0].id;
    const input = (await pool.query("SELECT * FROM checkpoint_files WHERE checkpoint_id=$1", [cp])).rows[0];
    const snapshot = (await pool.query("SELECT encoded_state FROM document_snapshots WHERE id=$1", [input.snapshot_id])).rows[0];
    const independent = new Y.Doc(); independent.getText("content"); Y.applyUpdate(independent, snapshot.encoded_state);
    for (const row of (await pool.query("SELECT update_bytes FROM document_updates WHERE document_id=$1 AND sequence>$2 AND sequence<=$3 ORDER BY sequence", [data.document, input.snapshot_sequence, input.through_sequence])).rows) Y.applyUpdate(independent, row.update_bytes);
    const cut = independent.getText("content").toString(); independent.destroy(); assert.ok(cut.includes("baseline"));
    await a.getByRole("button", { name: "Preview Three actor cut" }).click(); await a.getByRole("button", { name: "Preview file main.js" }).click();
    await until(async () => (await a.getByRole("region", { name: "Captured file text" }).textContent()) === cut, "File preview did not finish loading");
    assert.equal(await a.getByRole("region", { name: "Captured file text" }).textContent(), cut);
    assert.equal(await downloadText(a, `/api/v1/projects/${data.project}/checkpoints/${cp}/files/${data.file}`), cut);
    await v.getByRole("button", { name: "Checkpoints", exact: true }).click(); await v.getByRole("button", { name: "Preview Three actor cut" }).click();
    assert.equal(await v.getByRole("button", { name: "Capture checkpoint", exact: true }).count(), 0); assert.equal(await v.getByRole("button", { name: "Restore checkpoint", exact: true }).count(), 0);
    await b.getByRole("button", { name: "Checkpoints", exact: true }).click(); await b.getByRole("button", { name: "Preview Three actor cut" }).click();
    assert.equal(await b.getByRole("button", { name: "Restore checkpoint", exact: true }).count(), 0);
    await b.getByRole("button", { name: "Close checkpoints" }).click();
    await settled(b); await settled(c);
    offline.enabled = true; for (const route of [...offline.routes]) { route.client.close({ code: 1012 }); route.server.close(); } await contexts[1].setOffline(true);
    await type(b, "offline-draft"); await until(async () => (await drafts(b)).some(row => row.scope.documentID === data.document && row.pending.length > 0), "Offline draft was not retained");
    const transmittedBeforeRestore = offline.oldUpdates;
    await type(a, "latest"); await settled(a); await until(async () => (await text(c)).includes("latest"), "Latest peer edit missing");
    const before = (await text(a));
    a.once("dialog", dialog => dialog.accept()); await a.getByRole("button", { name: "Restore checkpoint", exact: true }).click();
    await a.getByRole("status").getByText(/Restored\. The previous committed state/).waitFor();
    await until(async () => (await text(a)) === cut.replace(/\s/g, "") && (await text(c)) === cut.replace(/\s/g, ""), "Connected clients failed to rebind");
    const current = (await pool.query("SELECT current_document_id::text,generation::text FROM files WHERE id=$1", [data.file])).rows[0]; assert.notEqual(current.current_document_id, data.document); assert.equal(current.generation, "2");
    const previous = (await pool.query("SELECT id::text FROM checkpoints WHERE project_id=$1 AND name LIKE 'Before restore:%'", [data.project])).rows[0].id;
    await until(async () => (await pool.query("SELECT state FROM checkpoints WHERE id=$1", [previous])).rows[0].state === "ready", "Prior checkpoint never materialized");
    const priorText = await downloadText(a, `/api/v1/projects/${data.project}/checkpoints/${previous}/files/${data.file}`); assert.equal(priorText.replace(/\s/g, ""), before); assert.ok(priorText.includes("latest")); assert.ok(!priorText.includes("offline-draft"));
    const oldHead = (await pool.query("SELECT last_committed_sequence FROM documents WHERE id=$1", [data.document])).rows[0].last_committed_sequence;
    offline.enabled = false; await contexts[1].setOffline(false);
    await until(async () => (await text(b)) === cut.replace(/\s/g, ""), "Offline client failed to rebind after reconnect", 30000);
    assert.equal(offline.oldUpdates, transmittedBeforeRestore, "Old generation outbox transmitted after restore");
    assert.equal((await pool.query("SELECT last_committed_sequence FROM documents WHERE id=$1", [data.document])).rows[0].last_committed_sequence, oldHead);
    const old = (await drafts(b)).find(row => row.scope.documentID === data.document); assert.ok(old.pending.length > 0); assert.match(old.frozen, /Version replaced\/deleted/);
    const recovered = new Y.Doc(); recovered.getText("content"); Y.applyUpdate(recovered, Uint8Array.from(old.state)); assert.ok(recovered.getText("content").toString().includes("offline-draft")); recovered.destroy();
    await b.getByRole("button", { name: "Recover drafts" }).click(); const dialog = b.getByRole("dialog", { name: "Recover browser drafts" });
    const downloadPromise = b.waitForEvent("download"); await dialog.getByRole("button", { name: "Download generation 1 draft" }).click(); const download = await downloadPromise; assert.ok(download.suggestedFilename().includes("generation-1")); await dialog.getByRole("button", { name: "Close recovery" }).click();
    mkdirSync(".tmp", { recursive: true }); await a.screenshot({ path: ".tmp/phase06-checkpoints-desktop.png", fullPage: true });
    await a.setViewportSize({ width: 390, height: 844 }); await a.screenshot({ path: ".tmp/phase06-checkpoints-narrow.png", fullPage: true });
    assert.equal(await a.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); assert.deepEqual(errors, []);
  } finally { await Promise.all(contexts.map(context => context.close())); await browser.close(); await pool.end(); }
});
