import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright-core";
import { Pool } from "pg";
import { WebSocket } from "ws";
import * as Y from "yjs";
import { decodeEnvelope, encodeEnvelope, FrameType } from "@cce/protocol";

const databaseURL = process.env.TEST_DATABASE_URL;
const origin = process.env.CCE_E2E_ORIGIN ?? "http://localhost:3000";
const browserPath = process.env.CCE_BROWSER_PATH ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

async function fixture(pool) {
  const owner = (await pool.query("INSERT INTO users(provider,provider_subject,display_name) VALUES('github',$1,'Realtime owner') RETURNING id::text", [randomUUID()])).rows[0].id;
  const viewer = (await pool.query("INSERT INTO users(provider,provider_subject,display_name) VALUES('github',$1,'Realtime viewer') RETURNING id::text", [randomUUID()])).rows[0].id;
  const editor = (await pool.query("INSERT INTO users(provider,provider_subject,display_name) VALUES('github',$1,'Realtime editor') RETURNING id::text", [randomUUID()])).rows[0].id;
  const session = async (user) => {
    const token = randomBytes(32).toString("base64url");
    const csrf = createHash("sha256").update("cce-csrf-v1:" + token).digest("base64url");
    await pool.query("INSERT INTO sessions(user_id,token_hash,csrf_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')", [user, createHash("sha256").update(token).digest(), createHash("sha256").update(csrf).digest()]);
    return token;
  };
  const ownerToken = await session(owner); const viewerToken = await session(viewer); const editorToken = await session(editor);
  const tx = await pool.connect(); let project;
  try {
    await tx.query("BEGIN");
    project = (await tx.query("INSERT INTO projects(owner_id,name) VALUES($1,'Realtime browser fixture') RETURNING id::text", [owner])).rows[0].id;
    await tx.query("INSERT INTO project_members(project_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'viewer'),($1,$4,'editor')", [project, owner, viewer, editor]);
    await tx.query("COMMIT");
  } catch (error) { await tx.query("ROLLBACK"); throw error; } finally { tx.release(); }
  const fileTx = await pool.connect(); let file; let document;
  try {
    await fileTx.query("BEGIN");
    file = (await fileTx.query("INSERT INTO files(project_id,name,kind,language,generation) VALUES($1,'main.ts','file','typescript',1) RETURNING id::text", [project])).rows[0].id;
    document = (await fileTx.query("INSERT INTO documents(file_id,generation) VALUES($1,1) RETURNING id::text", [file])).rows[0].id;
    await fileTx.query("UPDATE files SET current_document_id=$1 WHERE id=$2", [document, file]);
    await fileTx.query("COMMIT");
  } catch (error) { await fileTx.query("ROLLBACK"); throw error; } finally { fileTx.release(); }
  const empty = new Y.Doc(); empty.getText("content");
  const state = Y.encodeStateAsUpdate(empty);
  await pool.query("INSERT INTO document_snapshots(document_id,through_sequence,encoded_state,state_vector,checksum) VALUES($1,0,$2,$3,$4)", [document, Buffer.from(state), Buffer.from(Y.encodeStateVector(empty)), createHash("sha256").update(state).digest()]);
  empty.destroy();
  return { project, file, document, ownerToken, viewerToken, editorToken, ownerCSRF: createHash("sha256").update("cce-csrf-v1:" + ownerToken).digest("base64url") };
}

test("two independent browsers edit through Go and raw viewer writes are rejected", { skip: !databaseURL, timeout: 120_000 }, async () => {
  console.log("browser acceptance: seeding database fixture");
  const pool = new Pool({ connectionString: databaseURL, connectionTimeoutMillis: 5000, query_timeout: 10000 });
  pool.on("error", () => {});
  const data = await fixture(pool);
  console.log("browser acceptance: fixture ready");
  let browser;
  try {
    const handshakeStatus = (headers, document = data.document) => new Promise((resolve, reject) => {
      const socket = new WebSocket(`${origin.replace(/^http/, "ws")}/ws/documents/${document}`, { headers, family: 4 });
      const timeout = setTimeout(() => { socket.terminate(); reject(new Error("Gateway handshake timeout")); }, 5000);
      socket.on("error", () => {});
      socket.once("error", error => { clearTimeout(timeout); reject(error); });
      socket.once("unexpected-response", (request, response) => { clearTimeout(timeout); const status = response.statusCode; response.destroy(); request.destroy(); resolve(status); });
      socket.once("open", () => { clearTimeout(timeout); socket.terminate(); reject(new Error("unauthorized upgrade accepted")); });
    });
    assert.equal(await handshakeStatus({ Origin: origin }), 401);
    assert.equal(await handshakeStatus({ Cookie: `cce_session=${data.ownerToken}`, Origin: "https://evil.example" }), 403);
    assert.equal(await handshakeStatus({ Cookie: `cce_session=${data.ownerToken}`, Origin: origin }, randomUUID()), 404);
    console.log("browser acceptance: gateway admission verified");
    browser = await chromium.launch({ executablePath: browserPath, headless: true, args: ["--no-sandbox", "--disable-gpu", "--host-resolver-rules=MAP localhost 127.0.0.1"] });
    const contextA = await browser.newContext(); const contextB = await browser.newContext();
    for (const [context, token] of [[contextA, data.ownerToken], [contextB, data.editorToken]]) await context.addCookies([{ name: "cce_session", value: token, domain: "localhost", path: "/", httpOnly: true, sameSite: "Lax" }]);
    const pageA = await contextA.newPage(); const pageB = await contextB.newPage();
    const errors = [];
    for (const page of [pageA, pageB]) { page.on("pageerror", (error) => errors.push(error.message)); page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); }); }
    const url = `${origin}/projects/${data.project}/workspace`;
    await Promise.all([pageA.goto(url), pageB.goto(url)]);
    await Promise.all([pageA.getByRole("button", { name: "File: main.ts" }).click(), pageB.getByRole("button", { name: "File: main.ts" }).click()]);
    await Promise.all([pageA.locator(".editor-breadcrumb span").getByText("Synced").waitFor(), pageB.locator(".editor-breadcrumb span").getByText("Synced").waitFor()]);
    await pageA.locator(".monaco-editor").click(); await pageA.keyboard.type("alpha");
    await pageA.locator(".view-line").getByText("alpha").waitFor();
    try { await pageB.locator(".view-line").getByText("alpha").waitFor({ timeout: 5000 }); }
    catch (error) { console.log("realtime diagnostic", { a: await pageA.locator(".editor-breadcrumb span").textContent(), b: await pageB.locator(".editor-breadcrumb span").textContent(), aText: await pageA.locator(".view-line").first().textContent(), bText: await pageB.locator(".view-line").first().textContent(), errors }); throw error; }
    await pageB.locator(".monaco-editor").click(); await pageB.keyboard.type("beta");
    await pageA.locator(".view-line").getByText(/alpha.*beta|beta.*alpha/).waitFor();
    assert.match(await pageB.locator(".view-line").first().textContent(), /alpha.*beta|beta.*alpha/);
    await pageA.locator(".editor-breadcrumb span").getByText("Saved", { exact: true }).waitFor();
    console.log("browser acceptance: two-account editing and receipts verified");
    const rename = await pageA.evaluate(async ({ project, file, csrf }) => {
      const response = await fetch(`/api/v1/projects/${project}/tree/${file}`, { method: "PATCH", headers: { "X-CSRF-Token": csrf, "If-Match": "0", "Content-Type": "application/json" }, body: JSON.stringify({ name: "main.py" }) });
      return { status: response.status, body: await response.text() };
    }, { project: data.project, file: data.file, csrf: data.ownerCSRF });
    assert.equal(rename.status, 200, rename.body);
    await Promise.all([pageA.getByRole("tab", { name: "main.py" }).waitFor(), pageB.getByRole("tab", { name: "main.py" }).waitFor()]);
    assert.match(await pageA.locator(".view-line").first().textContent(), /alpha.*beta|beta.*alpha/);
    const control = new WebSocket(`${origin.replace(/^http/, "ws")}/ws/projects/${data.project}?after=0`, { family: 4, headers: { Cookie: `cce_session=${data.ownerToken}`, Origin: origin } });
    const replayed = new Promise((resolve) => control.once("message", (data) => resolve(JSON.parse(String(data)))));
    await new Promise((resolve, reject) => { control.once("open", resolve); control.once("error", reject); });
    const event = await replayed;
    assert.equal(event.type, "EVENT"); assert.equal(event.sequence, "1"); control.terminate();
    const staleControl = new WebSocket(`${origin.replace(/^http/, "ws")}/ws/projects/${data.project}?after=999`, { family: 4, headers: { Cookie: `cce_session=${data.ownerToken}`, Origin: origin } });
    const resync = new Promise((resolve) => staleControl.once("message", (data) => resolve(JSON.parse(String(data)))));
    await new Promise((resolve, reject) => { staleControl.once("open", resolve); staleControl.once("error", reject); });
    assert.equal((await resync).type, "RESYNC_REQUIRED"); staleControl.terminate();
    const raw = new WebSocket(`${origin.replace(/^http/, "ws")}/ws/documents/${data.document}`, { family: 4, headers: { Cookie: `cce_session=${data.viewerToken}`, Origin: origin } });
    await new Promise((resolve, reject) => { raw.once("open", resolve); raw.once("error", reject); });
    const viewerError = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("viewer denial timeout")), 5000);
      raw.on("message", (message) => {
        const frame = decodeEnvelope(new Uint8Array(message), "server");
        if (frame.type === FrameType.ERROR) { clearTimeout(timeout); resolve(JSON.parse(Buffer.from(frame.body).toString())); }
      });
    });
    const fake = new Y.Doc(); let update; fake.on("update", (bytes) => { update = bytes; }); fake.getText("content").insert(0, "malicious");
    const body = Buffer.alloc(64 + update.length); randomBytes(16).copy(body); randomBytes(16).copy(body, 16); createHash("sha256").update(update).digest().copy(body, 32); Buffer.from(update).copy(body, 64);
    raw.send(encodeEnvelope(FrameType.DURABLE_UPDATE, body));
    assert.equal((await viewerError).code, "FORBIDDEN"); raw.terminate(); fake.destroy();
    const viewerContext = await browser.newContext();
    await viewerContext.addCookies([{ name: "cce_session", value: data.viewerToken, domain: "localhost", path: "/", httpOnly: true, sameSite: "Lax" }]);
    const viewerPage = await viewerContext.newPage();
    await viewerPage.goto(url);
    await viewerPage.getByRole("button", { name: "File: main.py" }).click();
    await viewerPage.locator(".editor-breadcrumb span").getByText("Synced").waitFor();
    assert.equal(await viewerPage.getByRole("button", { name: "New file" }).count(), 0);
    const revoked = new WebSocket(`${origin.replace(/^http/, "ws")}/ws/documents/${data.document}`, { family: 4, headers: { Cookie: `cce_session=${data.viewerToken}`, Origin: origin } });
    await new Promise((resolve, reject) => { revoked.once("open", resolve); revoked.once("error", reject); });
    const revocation = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("reader revocation timeout")), 6000);
      revoked.on("message", (message) => {
        const frame = decodeEnvelope(new Uint8Array(message), "server");
        if (frame.type === FrameType.ERROR) { clearTimeout(timeout); resolve(JSON.parse(Buffer.from(frame.body).toString())); }
      });
    });
    await pool.query("DELETE FROM project_members WHERE project_id=$1 AND user_id=(SELECT user_id FROM sessions WHERE token_hash=$2)", [data.project, createHash("sha256").update(data.viewerToken).digest()]);
    assert.equal((await revocation).code, "FORBIDDEN"); revoked.terminate();
    await viewerPage.getByRole("heading", { name: "Workspace unavailable" }).waitFor();
    const persisted = await pool.query("SELECT count(*)::int AS n FROM document_updates WHERE document_id=$1", [data.document]);
    assert.ok(persisted.rows[0].n > 0);
    await pageB.locator(".editor-breadcrumb span").getByText("Saved", { exact: true }).waitFor();
    if (process.env.CCE_E2E_RESTART === "1") {
      console.log("browser acceptance: worker restart begins");
      const expected = await pageA.locator(".view-line").first().textContent();
      const compose = ["compose", "-f", "infra/compose/compose.yaml", "-f", "infra/compose/compose.test.yaml"];
      execFileSync("docker", [...compose, "kill", "-s", "SIGKILL", "collab"], { stdio: "pipe", timeout: 30000 });
      // A dead worker does not release ownership. Wait for the real DB lease.
      await new Promise(resolve => setTimeout(resolve, 16000));
      // Start the existing killed worker only. `up` may recreate dependencies
      // and invalidate live test connections to PostgreSQL during this scenario.
      execFileSync("docker", [...compose, "start", "--wait", "--wait-timeout", "30", "collab"], { stdio: "pipe", timeout: 45000 });
      console.log("browser acceptance: worker healthy, reloading contexts");
      await Promise.all([pageA.reload(), pageB.reload()]);
      await Promise.all([pageA.getByRole("button", { name: "File: main.py" }).click(), pageB.getByRole("button", { name: "File: main.py" }).click()]);
      try { await Promise.all([pageA.locator(".editor-breadcrumb span").getByText("Synced", { exact: true }).waitFor(), pageB.locator(".editor-breadcrumb span").getByText("Synced", { exact: true }).waitFor()]); }
      catch (error) { console.log("restart connection diagnostic", { a: await pageA.locator(".editor-breadcrumb span").textContent(), b: await pageB.locator(".editor-breadcrumb span").textContent(), errors }); throw error; }
      assert.equal(await pageA.locator(".view-line").first().textContent(), expected);
      assert.equal(await pageB.locator(".view-line").first().textContent(), expected);
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM document_updates WHERE document_id=$1", [data.document])).rows[0].n, persisted.rows[0].n);
      console.log("browser acceptance: restart recovery verified");
    }
    if (process.env.CCE_E2E_STORAGE_FAILURE === "1") {
      console.log("browser acceptance: scoped database failure begins");
      const barrier = await pool.connect();
      const trigger = `phase04_browser_${randomUUID().replaceAll("-", "")}`;
      const expectedPeer = await pageB.locator(".view-line").first().textContent();
      try {
        await pool.query(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.document_id::text=TG_ARGV[0] THEN PERFORM pg_advisory_xact_lock(73004,3); END IF; RETURN NEW; END $$`);
        await pool.query(`CREATE TRIGGER ${trigger} BEFORE INSERT ON document_updates FOR EACH ROW EXECUTE FUNCTION ${trigger}('${data.document}')`);
        await barrier.query("SELECT pg_advisory_lock(73004,3)");
        await pageA.locator(".monaco-editor").click(); await pageA.keyboard.type("unsaved");
        const end = Date.now() + 10000;
        while (!(await pool.query("SELECT 1 FROM pg_stat_activity WHERE wait_event='advisory' AND query LIKE 'SELECT cce_append_document%'")).rowCount) {
          if (Date.now() > end) throw new Error("Browser append barrier timeout");
          await new Promise(resolve => setTimeout(resolve, 30));
        }
        await pageA.locator(".editor-breadcrumb span").getByText("Saving", { exact: true }).waitFor();
        await pool.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE wait_event='advisory' AND query LIKE 'SELECT cce_append_document%'");
        await pageA.locator(".editor-breadcrumb span").getByText("Storage unavailable", { exact: true }).waitFor();
        assert.equal(await pageA.locator(".editor-breadcrumb span").getByText("Saved", { exact: true }).count(), 0);
        assert.equal(await pageB.locator(".view-line").first().textContent(), expectedPeer);
        assert.equal((await pool.query("SELECT count(*)::int AS n FROM document_updates WHERE document_id=$1", [data.document])).rows[0].n, persisted.rows[0].n);
        console.log("browser acceptance: storage error without Saved or broadcast verified");
      } finally {
        await barrier.query("SELECT pg_advisory_unlock(73004,3)").catch(() => {}); barrier.release();
        await pool.query(`DROP TRIGGER IF EXISTS ${trigger} ON document_updates`);
        await pool.query(`DROP FUNCTION IF EXISTS ${trigger}()`);
      }
    }
    await contextA.close(); await contextB.close(); await viewerContext.close();
  } finally { await browser?.close(); await pool.end(); }
});
