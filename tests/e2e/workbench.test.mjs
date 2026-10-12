import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';
import test from 'node:test';

test('IDE workbench preserves editor, terminal sessions, role controls and pane bounds', { skip: process.env.CCE_WORKSPACE_TESTS !== '1', timeout: 180000 }, async () => {
const keepAlive = setInterval(() => {}, 1000);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const sql = input => execFileSync('docker', ['exec', '-i', 'collaborative-code-editor-postgres-1', 'psql', '-U', 'cce', '-d', 'cce', '-At', '-v', 'ON_ERROR_STOP=1'], { input, encoding: 'utf8', timeout: 30000 }).trim();
const sha = value => createHash('sha256').update(value).digest('hex');
const user = randomUUID(), token = randomBytes(32).toString('base64url'), csrf = createHash('sha256').update('cce-csrf-v1:' + token).digest('base64url');
const viewer = randomUUID(), viewerToken = randomBytes(32).toString('base64url'), viewerCSRF = createHash('sha256').update('cce-csrf-v1:' + viewerToken).digest('base64url');
let project, browser;
async function request(method, path, body, headers = {}) {
 const response = await fetch('http://127.0.0.1:3000' + path, { method, signal: AbortSignal.timeout(90000), headers: { Origin: 'http://localhost:3000', Cookie: `cce_session=${token}`, 'X-CSRF-Token': csrf, ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
 return { status: response.status, body: response.status === 204 ? null : await response.json() };
}
async function until(fn, timeout = 30000) { const end = Date.now() + timeout; while (!await fn()) { if (Date.now() > end) throw new Error('Workbench check timed out'); await pause(200); } }
try {
 sql(`INSERT INTO users(id,provider,provider_subject,display_name) VALUES('${user}','github','${user}','Workbench review'); INSERT INTO sessions(user_id,token_hash,csrf_hash,expires_at) VALUES('${user}',decode('${sha(token)}','hex'),decode('${sha(csrf)}','hex'),now()+interval '1 hour');`);
 const created = await request('POST', '/api/v1/projects', { name: 'collaborative-workspace' }); assert.equal(created.status, 201); project = created.body.id;
 const base = `/api/v1/projects/${project}`;
 sql(`INSERT INTO users(id,provider,provider_subject,display_name) VALUES('${viewer}','github','${viewer}','Workbench viewer'); INSERT INTO sessions(user_id,token_hash,csrf_hash,expires_at) VALUES('${viewer}',decode('${sha(viewerToken)}','hex'),decode('${sha(viewerCSRF)}','hex'),now()+interval '1 hour'); INSERT INTO project_members VALUES('${project}','${viewer}','viewer');`);
 const files = [
  { path: 'src/main.py', text: '# Collaborative Code Editor\n# Your team shares source; each teammate has their own shell.\n\ndef greet(name: str) -> str:\n    return f"Hello, {name}!"\n\n\nif __name__ == "__main__":\n    print(greet("collaborative workspace"))\n' },
  { path: 'src/requirements.txt', text: '' },
  { path: 'README.md', text: '# Collaborative workspace\n\nEdit together. Run in your project environment.\n' },
 ];
 const imported = await request('POST', `${base}/import`, { files }, { 'If-Match': '0' }); assert.equal(imported.status, 201);
 browser = await chromium.launch({ executablePath: process.env.CCE_BROWSER_PATH ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true, args: ['--no-sandbox', '--disable-gpu', '--host-resolver-rules=MAP localhost 127.0.0.1'] });
 const context = await browser.newContext({ viewport: { width: 1440, height: 900 } }); await context.addCookies([{ name: 'cce_session', value: token, domain: 'localhost', path: '/', httpOnly: true, sameSite: 'Lax' }]);
 const page = await context.newPage(); const errors = []; page.on('pageerror', error => errors.push(error.message));
 mkdirSync('.tmp/workbench-review', { recursive: true });
 await page.goto(`http://localhost:3000/projects/${project}/workspace`);
 await page.getByRole('button', { name: 'File: main.py', exact: true }).click();
 await page.getByRole('button', { name: 'Download visible draft', exact: true }).waitFor();
 await until(async () => (await page.locator('.monaco-editor').innerText()).includes('greet'));
 await page.screenshot({ path: '.tmp/workbench-review/editor.png', fullPage: true });
 await page.getByRole('button', { name: 'Development workspace', exact: true }).click();
 await page.getByLabel('Project folder', { exact: true }).fill('src'); await page.getByLabel('Entrypoint', { exact: true }).fill('main.py');
 await page.getByRole('button', { name: 'Create environment', exact: true }).click();
 await page.getByRole('button', { name: 'Save configuration', exact: true }).waitFor({ timeout: 30000 });
 await page.getByRole('button', { name: 'Sync saved source', exact: true }).click();
 await until(async () => await page.getByRole('button', { name: 'Build', exact: true }).isEnabled());
 await page.screenshot({ path: '.tmp/workbench-review/environment.png', fullPage: true });
 await page.getByRole('button', { name: 'Run workspace', exact: true }).click();
 await until(async () => (await page.locator('.workspace-task-log').innerText()).includes('Hello, collaborative workspace!'));
 await page.screenshot({ path: '.tmp/workbench-review/output.png', fullPage: true });
 await page.getByRole('tab', { name: /^Terminal/ }).click();
 await page.locator('.terminal-tabbar').getByRole('button', { name: 'New terminal', exact: true }).click();
 await page.getByText('Connected · your shell session', { exact: true }).waitFor();
 await page.locator('.xterm-helper-textarea').pressSequentially("printf 'SHELL_PRESERVED\\n'\n", { delay: 4 });
 await until(async () => (await page.locator('.xterm-accessibility').innerText()).includes('SHELL_PRESERVED'));
 const count = (await request('GET', `${base}/workspace`)).body.terminals; assert.equal(count, 1);
 await page.getByRole('tab', { name: 'Environment', exact: true }).click(); assert.equal((await request('GET', `${base}/workspace`)).body.terminals, 1);
 await page.getByRole('tab', { name: /^Terminal/ }).click();
 await page.getByRole('button', { name: 'Close bottom panel', exact: true }).click(); assert.equal((await request('GET', `${base}/workspace`)).body.terminals, 1);
 await page.keyboard.press('Control+j'); await page.getByText('Connected · your shell session', { exact: true }).waitFor();
 const resize = page.getByRole('separator', { name: 'Resize bottom panel', exact: true }); await resize.focus(); await page.keyboard.press('ArrowUp');
 await page.screenshot({ path: '.tmp/workbench-review/terminal.png', fullPage: true });
 await page.getByRole('button', { name: 'Close terminal 1', exact: true }).click();
 await until(async () => (await request('GET', `${base}/workspace`)).body.terminals === 0);
 await page.getByRole('button', { name: 'Development workspace', exact: true }).click();
 async function bounds() { return page.evaluate(() => { const editor = document.querySelector('.editor-surface').getBoundingClientRect(); const panel = document.querySelector('.ide-bottom-panel').getBoundingClientRect(); const footer = document.querySelector('.workspace-status').getBoundingClientRect(); return { editorBottom: editor.bottom, panelTop: panel.top, panelBottom: panel.bottom, footerTop: footer.top, documentWidth: document.documentElement.scrollWidth, viewport: innerWidth }; }); }
 for (const [name, width, height] of [['desktop', 1920, 1080], ['laptop', 1024, 768], ['mobile', 390, 844]]) {
  await page.setViewportSize({ width, height }); await pause(300); const rect = await bounds(); assert.ok(rect.editorBottom <= rect.panelTop + 1, JSON.stringify(rect)); assert.ok(rect.panelBottom <= rect.footerTop + 1, JSON.stringify(rect)); assert.ok(rect.documentWidth <= rect.viewport, JSON.stringify(rect));
  await page.screenshot({ path: `.tmp/workbench-review/${name}.png`, fullPage: true });
 }
 await page.setViewportSize({ width: 1440, height: 900 });
 await page.getByRole('button', { name: 'Import files', exact: true }).waitFor();
 await page.getByLabel('Select local files', { exact: true }).setInputFiles({ name: 'new-file.py', mimeType: 'text/plain', buffer: Buffer.from("print('imported')\n") });
 await page.getByRole('dialog', { name: 'Import from your device', exact: true }).waitFor(); await page.screenshot({ path: '.tmp/workbench-review/import.png', fullPage: true });
 await page.keyboard.press('Shift+Tab'); assert.equal(await page.evaluate(() => Boolean(document.activeElement.closest('[aria-modal="true"]'))), true);
 await page.getByRole('button', { name: 'Import selected files', exact: true }).click(); await page.getByRole('button', { name: 'File: new-file.py', exact: true }).waitFor();
 await page.getByRole('button', { name: 'New folder', exact: true }).click(); await page.getByLabel('Name', { exact: true }).fill('tests'); await page.getByRole('button', { name: 'Save', exact: true }).click(); await page.getByRole('button', { name: 'Folder: tests', exact: true }).waitFor();
 const home = await context.newPage(); await home.goto('http://localhost:3000'); await home.getByRole('heading', { name: 'Your projects', exact: true }).waitFor(); await home.screenshot({ path: '.tmp/workbench-review/projects.png', fullPage: true }); await home.close();
 const viewerContext = await browser.newContext({ viewport: { width: 1440, height: 900 } }); await viewerContext.addCookies([{ name: 'cce_session', value: viewerToken, domain: 'localhost', path: '/', httpOnly: true, sameSite: 'Lax' }]); const viewerPage = await viewerContext.newPage(); await viewerPage.goto(`http://localhost:3000/projects/${project}/workspace`); await viewerPage.getByRole('heading', { name: 'Explorer', exact: true }).waitFor(); assert.equal(await viewerPage.getByRole('button', { name: 'Import files', exact: true }).count(), 0); assert.equal(await viewerPage.getByRole('button', { name: 'New file', exact: true }).count(), 0); await viewerPage.getByRole('button', { name: 'Development workspace', exact: true }).click(); await viewerPage.getByRole('tab', { name: /^Terminal/ }).click(); assert.equal(await viewerPage.getByRole('button', { name: 'New terminal', exact: true }).count(), 0); await viewerContext.close();
 assert.deepEqual(errors, []); console.log('Passed: live editing, environment configuration/sync/run, task output, persistent terminal tabs/hide, keyboard resizing, imports/new folder, dialog focus, viewer permissions, and desktop/laptop/mobile bounds.');
} finally {
 await browser?.close(); if (project) { await pause(1200); await request('PUT', `/api/v1/projects/${project}/workspace`, { action: 'stop', language: 'python', root: '.', entrypoint: '' }).catch(() => {}); await request('DELETE', `/api/v1/projects/${project}/workspace`).catch(() => {}); await request('DELETE', `/api/v1/projects/${project}`).catch(() => {}); }
 sql(`UPDATE sessions SET revoked_at=now() WHERE user_id IN ('${user}','${viewer}');`); clearInterval(keepAlive);
}

});
