import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
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
  const session = async (user) => {
    const token = randomBytes(32).toString("base64url");
    const csrf = createHash("sha256").update("cce-csrf-v1:" + token).digest("base64url");
    await pool.query("INSERT INTO sessions(user_id,token_hash,csrf_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')", [user, createHash("sha256").update(token).digest(), createHash("sha256").update(csrf).digest()]);
    return token;
  };
  const ownerToken = await session(owner); const viewerToken = await session(viewer);
  const tx = await pool.connect(); let project;
  try {
    await tx.query("BEGIN");
    project = (await tx.query("INSERT INTO projects(owner_id,name) VALUES($1,'Realtime browser fixture') RETURNING id::text", [owner])).rows[0].id;
    await tx.query("INSERT INTO project_members(project_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'viewer')", [project, owner, viewer]);
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
  return { project, file, document, ownerToken, viewerToken, ownerCSRF: createHash("sha256").update("cce-csrf-v1:" + ownerToken).digest("base64url") };
}

test("two independent browsers edit through Go and raw viewer writes are rejected", { skip: !databaseURL, timeout: 120_000 }, async () => {
  const pool = new Pool({ connectionString: databaseURL });
  const data = await fixture(pool);
  let browser;
  try {
    const handshakeStatus = (headers, document = data.document) => new Promise((resolve, reject) => {
      const socket = new WebSocket(`${origin.replace(/^http/, "ws")}/ws/documents/${document}`, { headers });
      socket.on("error", () => {});
      socket.once("unexpected-response", (request, response) => { const status = response.statusCode; response.destroy(); request.destroy(); resolve(status); });
      socket.once("open", () => { socket.terminate(); reject(new Error("unauthorized upgrade accepted")); });
    });
    assert.equal(await handshakeStatus({ Origin: origin }), 401);
    assert.equal(await handshakeStatus({ Cookie: `cce_session=${data.ownerToken}`, Origin: "https://evil.example" }), 403);
    assert.equal(await handshakeStatus({ Cookie: `cce_session=${data.ownerToken}`, Origin: origin }, randomUUID()), 404);
    browser = await chromium.launch({ executablePath: browserPath, headless: true, args: ["--no-sandbox", "--disable-gpu"] });
    const contextA = await browser.newContext(); const contextB = await browser.newContext();
    for (const context of [contextA, contextB]) await context.addCookies([{ name: "cce_session", value: data.ownerToken, domain: "localhost", path: "/", httpOnly: true, sameSite: "Lax" }]);
    const pageA = await contextA.newPage(); const pageB = await contextB.newPage();
    const errors = [];
    for (const page of [pageA, pageB]) { page.on("pageerror", (error) => errors.push(error.message)); page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); }); }
    const url = `${origin}/projects/${data.project}/workspace`;
    await Promise.all([pageA.goto(url), pageB.goto(url)]);
    await Promise.all([pageA.getByRole("button", { name: "File: main.ts" }).click(), pageB.getByRole("button", { name: "File: main.ts" }).click()]);
    await Promise.all([pageA.locator(".editor-breadcrumb span").getByText("Synced · in-memory only").waitFor(), pageB.locator(".editor-breadcrumb span").getByText("Synced · in-memory only").waitFor()]);
    await pageA.locator(".monaco-editor").click(); await pageA.keyboard.type("alpha");
    await pageA.locator(".view-line").getByText("alpha").waitFor();
    try { await pageB.locator(".view-line").getByText("alpha").waitFor({ timeout: 5000 }); }
    catch (error) { console.log("realtime diagnostic", { a: await pageA.locator(".editor-breadcrumb span").textContent(), b: await pageB.locator(".editor-breadcrumb span").textContent(), aText: await pageA.locator(".view-line").first().textContent(), bText: await pageB.locator(".view-line").first().textContent(), errors }); throw error; }
    await pageB.locator(".monaco-editor").click(); await pageB.keyboard.type("beta");
    await pageA.locator(".view-line").getByText(/alpha.*beta|beta.*alpha/).waitFor();
    assert.match(await pageB.locator(".view-line").first().textContent(), /alpha.*beta|beta.*alpha/);
    assert.match(await pageA.locator(".editor-breadcrumb span").textContent(), /not saved/);
    const rename = await fetch(`${origin}/api/v1/projects/${data.project}/tree/${data.file}`, { method: "PATCH", headers: { Cookie: `cce_session=${data.ownerToken}`, Origin: origin, "X-CSRF-Token": data.ownerCSRF, "If-Match": "0", "Content-Type": "application/json" }, body: JSON.stringify({ name: "main.py" }) });
    assert.equal(rename.status, 200, await rename.text());
    await Promise.all([pageA.getByRole("tab", { name: "main.py" }).waitFor(), pageB.getByRole("tab", { name: "main.py" }).waitFor()]);
    assert.match(await pageA.locator(".view-line").first().textContent(), /alpha.*beta|beta.*alpha/);
    const control = new WebSocket(`${origin.replace(/^http/, "ws")}/ws/projects/${data.project}?after=0`, { headers: { Cookie: `cce_session=${data.ownerToken}`, Origin: origin } });
    const replayed = new Promise((resolve) => control.once("message", (data) => resolve(JSON.parse(String(data)))));
    await new Promise((resolve, reject) => { control.once("open", resolve); control.once("error", reject); });
    const event = await replayed;
    assert.equal(event.type, "EVENT"); assert.equal(event.sequence, "1"); control.terminate();
    const staleControl = new WebSocket(`${origin.replace(/^http/, "ws")}/ws/projects/${data.project}?after=999`, { headers: { Cookie: `cce_session=${data.ownerToken}`, Origin: origin } });
    const resync = new Promise((resolve) => staleControl.once("message", (data) => resolve(JSON.parse(String(data)))));
    await new Promise((resolve, reject) => { staleControl.once("open", resolve); staleControl.once("error", reject); });
    assert.equal((await resync).type, "RESYNC_REQUIRED"); staleControl.terminate();
    const raw = new WebSocket(`${origin.replace(/^http/, "ws")}/ws/documents/${data.document}`, { headers: { Cookie: `cce_session=${data.viewerToken}`, Origin: origin } });
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
    await viewerPage.locator(".editor-breadcrumb span").getByText("Synced · in-memory only").waitFor();
    assert.equal(await viewerPage.getByRole("button", { name: "New file" }).count(), 0);
    const revoked = new WebSocket(`${origin.replace(/^http/, "ws")}/ws/documents/${data.document}`, { headers: { Cookie: `cce_session=${data.viewerToken}`, Origin: origin } });
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
    assert.equal(persisted.rows[0].n, 0);
    await contextA.close(); await contextB.close(); await viewerContext.close();
  } finally { await browser?.close(); await pool.end(); }
});
