const screenshotDir = process.env.CCE_SCREENSHOT_DIR ?? "docs/screenshots";
const reportDir = process.env.CCE_REPORT_DIR ?? "docs/measurements";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { Pool } from "pg";
import * as Y from "yjs";
import { fixture, until, origin, summary, sleep } from "../load/workload.mjs";

async function retainedText(page) {
 const row=await page.evaluate(()=>new Promise((resolve,reject)=>{const request=indexedDB.open("cce-drafts-v1",1);request.onerror=()=>reject(request.error);request.onsuccess=()=>{const db=request.result,tx=db.transaction("drafts","readonly"),rows=tx.objectStore("drafts").getAll();tx.oncomplete=()=>{db.close();resolve(rows.result.map(r=>({state:Array.from(r.state),pending:r.pending.length})));};};}));
 assert.equal(row.length,1);const doc=new Y.Doc();Y.applyUpdate(doc,Uint8Array.from(row[0].state));const text=doc.getText("content").toString();doc.destroy();return {text,pending:row[0].pending};
}

test("Phase 09 independent browsers measure render/receipt/sync and capture actual workspace",{timeout:120000},async()=>{
 assert.ok(process.env.TEST_DATABASE_URL,"TEST_DATABASE_URL is required; this measurement must not silently skip");
 const pool=new Pool({connectionString:process.env.TEST_DATABASE_URL}),data=await fixture(pool,2,1,1024,"// Measured local workspace\n");
 const browser=await chromium.launch({executablePath:process.env.CCE_BROWSER_PATH??"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",headless:true,args:["--no-sandbox","--disable-gpu","--host-resolver-rules=MAP localhost 127.0.0.1"]});
 const contexts=[],pages=[],errors=[],peer=[];
 try{
  for(const user of data.users){const context=await browser.newContext({viewport:{width:1440,height:1000}});contexts.push(context);await context.addCookies([{name:"cce_session",value:user.token,domain:"localhost",path:"/",httpOnly:true,sameSite:"Lax"}]);await context.addInitScript(()=>sessionStorage.setItem("cce-measure","1"));const page=await context.newPage();pages.push(page);page.on("pageerror",error=>errors.push(error.message));await page.goto(`${origin}/projects/${data.project}/workspace`);await page.getByRole("button",{name:"File: file0.js"}).click();await until(async()=>["Saved","Synced"].includes(await page.locator(".editor-breadcrumb span").textContent()),"browser not synced");}
  const [owner,editor]=pages;
  await owner.locator(".monaco-editor").click();await owner.keyboard.press("Control+End");
  for(let n=0;n<12;n++){const at=performance.now();await owner.keyboard.type(String.fromCharCode(97+n));await until(async()=> (await editor.locator(".view-line").nth(1).textContent()).replace(/[\s\u200b]+/g,"") === "abcdefghijkl".slice(0,n+1),"peer did not render edit");peer.push(performance.now()-at);await until(async()=>await owner.locator(".editor-breadcrumb span").textContent()==="Saved","browser receipt missing");}
  await contexts[0].setOffline(true);await owner.keyboard.type("offline");await until(async()=>await owner.locator(".editor-breadcrumb span").textContent()==="Offline — draft retained","draft not retained");await editor.locator(".monaco-editor").click();await editor.keyboard.press("Control+End");await editor.keyboard.type("peer");await until(async()=>await editor.locator(".editor-breadcrumb span").textContent()==="Saved","peer receipt missing");
  const reconnectAt=performance.now();await contexts[0].setOffline(false);await until(async()=>await owner.locator(".editor-breadcrumb span").textContent()==="Saved","reconnect incomplete");await until(async()=>{const a=await retainedText(owner),b=await retainedText(editor);return a.text===b.text && a.pending===0 && b.pending===0;},"browser retained convergence mismatch");
  const expected=(await retainedText(owner)).text.replace(/[\s\u200b]+/g,"");
  // Monaco may defer a background tab's DOM paint. Inspect each independent
  // account's visible foreground rendering against its exact retained state.
  for(const [index,page] of pages.entries()) {
    await page.bringToFront();
    try { await until(async()=>(await page.locator(".view-lines").innerText()).replace(/[\s\u200b]+/g,"")===expected,"rendered browser differs from converged retained state",5000); }
    catch(error) { mkdirSync(".tmp",{recursive:true});await page.screenshot({path:`.tmp/phase09-render-failure-${index}.png`,fullPage:true});const download=page.waitForEvent("download");await page.getByRole("button",{name:"Download visible draft",exact:true}).click();const source=readFileSync(await (await download).path(),"utf8");const committed=new Y.Doc();Y.applyUpdate(committed,data.files[0].state);for(const row of (await pool.query("SELECT update_bytes FROM document_updates WHERE document_id=$1 ORDER BY sequence",[data.files[0].document])).rows)Y.applyUpdate(committed,row.update_bytes);writeFileSync(`.tmp/phase09-render-failure-${index}.json`,JSON.stringify({expected,visible:await page.locator(".view-lines").innerText(),liveYDoc:source,committed:committed.getText("content").toString()},null,2));committed.destroy();throw error; }
  }
  const reconnectMs=performance.now()-reconnectAt;
  const committed=new Y.Doc();Y.applyUpdate(committed,data.files[0].state);for(const row of (await pool.query("SELECT update_bytes FROM document_updates WHERE document_id=$1 ORDER BY sequence",[data.files[0].document])).rows)Y.applyUpdate(committed,row.update_bytes);assert.equal(committed.getText("content").toString(),(await retainedText(owner)).text);committed.destroy();
  await sleep(100);const samples=await owner.evaluate(()=>window.cceMeasurements);assert.ok(samples.local_render_ms.length>=12);assert.ok(samples.durable_ack_ms.length>=12);assert.ok(samples.connect_sync_ms.length>=2);
  assert.deepEqual(errors,[]);mkdirSync(screenshotDir,{recursive:true});await owner.screenshot({path:`${screenshotDir}/phase09-workspace-desktop.png`,fullPage:true});await owner.setViewportSize({width:390,height:844});await owner.screenshot({path:`${screenshotDir}/phase09-workspace-narrow.png`,fullPage:true});assert.equal(await owner.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  mkdirSync(reportDir,{recursive:true});writeFileSync(`${reportDir}/phase09-browser.json`,JSON.stringify({date:new Date().toISOString(),browser:browser.version(),headless:true,viewport:"1440x1000 then 390x844",typing:"12 sequential characters; wait for receipt between characters, plus offline interval",renderDefinition:"local edit keydown to second requestAnimationFrame, rendering opportunity proxy, not physical pixel presentation",peerDefinition:"keyboard dispatch through observed peer Monaco DOM text, includes Playwright polling",peerRenderMs:summary(peer),reconnectIncludingOutboxMs:reconnectMs,measurements:Object.fromEntries(Object.entries(samples).map(([name,values])=>[name,summary(values)])),converged:true,pageErrors:errors},null,2)+"\n");
 }finally{await Promise.all(contexts.map(c=>c.close()));await browser.close();await pool.query("UPDATE sessions SET revoked_at=clock_timestamp() WHERE user_id=ANY($1::uuid[])",[data.users.map(u=>u.id)]);await pool.end();}
});
