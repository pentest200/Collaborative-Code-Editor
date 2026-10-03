import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { chromium } from "playwright-core";

const root = resolve(import.meta.dirname, "../..");
const projectId = "11111111-1111-4111-8111-111111111111";
const folderId = "22222222-2222-4222-8222-222222222222";
const fileId = "33333333-3333-4333-8333-333333333333";
const webPort = process.env.CCE_WORKSPACE_TEST_PORT ?? "3100";
const webOrigin = `http://127.0.0.1:${webPort}`;
const workspaceURL = `${webOrigin}/projects/${projectId}/workspace`;
const browserPath = process.env.CCE_BROWSER_PATH ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

async function waitForWeb(web) {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (web.exitCode !== null) throw new Error(`Test web server exited with code ${web.exitCode}`);
    try { const response = await fetch(webOrigin); if (response.ok) return; } catch { /* waiting for local Next.js */ }
    await delay(300);
  }
  throw new Error("Next.js did not start");
}

test("workspace has semantic controls, role limits, and a single editor while switching tabs", { timeout: 120_000 }, async () => {
  const web = spawn(process.execPath, [resolve(root, "node_modules/next/dist/bin/next"), "start", "apps/web", "--hostname", "127.0.0.1", "--port", webPort], { cwd: root, stdio: "pipe" });
  let browser;
  try {
    await waitForWeb(web);
    browser = await chromium.launch({ executablePath: browserPath, headless: true, args: ["--no-sandbox", "--disable-gpu"] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    let role = "owner";
    const userId = randomUUID();
    let version = 0;
    const entries = [
      { id: folderId, parent_id: null, name: "src", kind: "folder", language: null, document_id: null, generation: "1" },
      { id: fileId, parent_id: folderId, name: "main.ts", kind: "file", language: "typescript", document_id: randomUUID(), generation: "1" }
    ];
    await context.route("**/api/v1/**", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      const json = (value, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
      if (path === "/api/v1/session" && request.method() === "GET") return json({ user: { id: userId, display_name: "Test Owner" }, csrf_token: "fixture-csrf" });
      if (path === `/api/v1/projects/${projectId}` && request.method() === "GET") return json({ id: projectId, name: "Workspace preview", role, tree_version: String(version), event_sequence: String(version) });
      if (path === `/api/v1/projects/${projectId}/tree` && request.method() === "GET") return json({ tree_version: String(version), event_sequence: String(version), entries });
      if (path.startsWith(`/api/v1/projects/${projectId}/tree`) && request.method() !== "GET") {
        assert.equal(request.headers()["x-csrf-token"], "fixture-csrf");
        if (request.headers()["if-match"] !== String(version)) return json({ code: "TREE_VERSION_CONFLICT", message: "Changed", current_version: String(version) }, 409);
        if (role === "viewer") return json({ code: "FORBIDDEN", message: "Editor permission required" }, 403);
        const body = request.method() === "DELETE" ? null : request.postDataJSON();
        const id = path.split("/").at(-1);
        let entry;
        if (request.method() === "POST") {
          entry = { id: randomUUID(), parent_id: body.parent_id, name: body.name, kind: body.kind, language: body.kind === "folder" ? null : body.name.endsWith(".py") ? "python" : "typescript", document_id: body.kind === "folder" ? null : randomUUID(), generation: "1" };
          entries.push(entry);
        } else if (request.method() === "PATCH") {
          entry = entries.find((item) => item.id === id);
          if (!entry) return json({ code: "NOT_FOUND", message: "Missing" }, 404);
          Object.assign(entry, body);
        } else {
          const index = entries.findIndex((item) => item.id === id);
          if (index < 0) return json({ code: "NOT_FOUND", message: "Missing" }, 404);
          entries.splice(index, 1);
          version++;
          return route.fulfill({ status: 204 });
        }
        version++;
        return json({ entry, tree_version: String(version), event_sequence: String(version) }, request.method() === "POST" ? 201 : 200);
      }
      return json({ code: "NOT_FOUND", message: "Not mocked" }, 404);
    });

    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(workspaceURL);
    await page.getByRole("heading", { name: "Explorer" }).waitFor();
    assert.equal(await page.getByRole("button", { name: "New file" }).count(), 1);
    assert.equal(await page.getByRole("button", { name: "Run" }).isDisabled(), true);
    await page.getByRole("button", { name: "File: main.ts" }).click();
    await page.getByRole("tab", { name: "main.ts" }).waitFor();
    await page.getByRole("button", { name: "Download visible draft" }).waitFor();
    await page.locator(".monaco-editor").waitFor();
    assert.equal(await page.getByRole("region", { name: "Output panel" }).getByText("Unavailable").count(), 1);
    await page.getByRole("button", { name: "New file" }).click();
    const form = page.getByRole("form", { name: "File tree action" });
    await form.getByLabel("Name").fill("utils.py");
    await form.getByRole("button", { name: "Save" }).click();
    await page.getByRole("tab", { name: "utils.py" }).waitFor();
    for (let index = 0; index < 6; index++) {
      await page.getByRole("tab", { name: index % 2 ? "utils.py" : "main.ts" }).click();
    }
    assert.equal(await page.locator(".monaco-editor").count(), 1, "tab switching should retain one editor instance");
    assert.deepEqual(errors, [], "browser should not report uncaught errors");
    const artifacts = resolve(root, ".tmp/phase02");
    await mkdir(artifacts, { recursive: true });
    await page.screenshot({ path: resolve(artifacts, "workspace-desktop.png"), fullPage: true });
    await page.getByRole("button", { name: "File: utils.py" }).click();
    await page.getByRole("button", { name: "Rename" }).click();
    await page.getByRole("form", { name: "File tree action" }).getByLabel("Name").fill("helper.py");
    await page.getByRole("form", { name: "File tree action" }).getByRole("button", { name: "Save" }).click();
    await page.getByRole("tab", { name: "helper.py" }).waitFor();
    await page.getByRole("button", { name: "Move" }).click();
    await page.getByRole("form", { name: "File tree action" }).getByLabel("Parent folder").selectOption("");
    await page.getByRole("form", { name: "File tree action" }).getByRole("button", { name: "Save" }).click();
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Delete" }).click();
    await page.getByRole("tab", { name: "helper.py" }).waitFor({ state: "detached" });
    assert.equal(await page.getByRole("tab", { name: "helper.py" }).count(), 0);

    role = "viewer";
    const viewer = await context.newPage();
    await viewer.goto(workspaceURL);
    await viewer.getByRole("heading", { name: "Explorer" }).waitFor();
    assert.equal(await viewer.getByRole("button", { name: "New file" }).count(), 0, "viewer cannot see metadata write controls");
    await viewer.getByRole("button", { name: "File: main.ts" }).click();
    await viewer.getByRole("button", { name: "Download visible draft" }).waitFor();
    await viewer.locator(".monaco-editor").waitFor();
    await viewer.setViewportSize({ width: 390, height: 844 });
    // Monaco's automatic layout uses ResizeObserver; inspect the settled frame.
    await viewer.waitForFunction(() => document.documentElement.scrollWidth <= window.innerWidth);
    assert.equal(await viewer.getByRole("navigation", { name: "Project files" }).isVisible(), true);
    assert.equal(await viewer.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "narrow layout should fit the viewport");
    await viewer.screenshot({ path: resolve(artifacts, "workspace-narrow.png"), fullPage: true });
    await context.close();
  } finally {
    await browser?.close();
    web.kill();
  }
});
