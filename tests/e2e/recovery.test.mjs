import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { Pool } from "pg";
import * as Y from "yjs";
import { decodeEnvelope, FrameType } from "@cce/protocol";

const origin = process.env.CCE_E2E_ORIGIN ?? "http://localhost:3000";
const databaseURL = process.env.TEST_DATABASE_URL;
const compose = ["compose", "-f", "infra/compose/compose.yaml", "-f", "infra/compose/compose.test.yaml"];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, message, timeout=15000) { const end=Date.now()+timeout; while (!await predicate()) { if (Date.now()>end) throw new Error(message); await delay(80); } }
async function seed(pool) {
  const identities=[];
  for (const name of ["Recovery owner","Recovery editor"]) {
    const user=(await pool.query("INSERT INTO users(provider,provider_subject,display_name) VALUES('github',$1,$2) RETURNING id::text",[randomUUID(),name])).rows[0].id;
    const token=randomBytes(32).toString("base64url"); const csrf=createHash('sha256').update('cce-csrf-v1:'+token).digest('base64url');
    await pool.query("INSERT INTO sessions(user_id,token_hash,csrf_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",[user,createHash('sha256').update(token).digest(),createHash('sha256').update(csrf).digest()]);
    identities.push({user,token});
  }
  const tx=await pool.connect(); let project,file,document;
  try {
    await tx.query('BEGIN'); project=(await tx.query("INSERT INTO projects(owner_id,name) VALUES($1,'Recovery acceptance') RETURNING id::text",[identities[0].user])).rows[0].id;
    await tx.query("INSERT INTO project_members(project_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'editor')",[project,...identities.map(item=>item.user)]);
    file=(await tx.query("INSERT INTO files(project_id,name,kind,language) VALUES($1,'main.js','file','javascript') RETURNING id::text",[project])).rows[0].id;
    document=(await tx.query("INSERT INTO documents(file_id,generation) VALUES($1,1) RETURNING id::text",[file])).rows[0].id;
    await tx.query("UPDATE files SET current_document_id=$1 WHERE id=$2",[document,file]);
    await tx.query("INSERT INTO document_snapshots(document_id,through_sequence,encoded_state,state_vector,checksum) VALUES($1,0,$2,$3,$4)",[document,Buffer.from([0,0]),Buffer.from([0]),createHash('sha256').update(Buffer.from([0,0])).digest()]);
    await tx.query('COMMIT');
  } catch(error) {await tx.query('ROLLBACK');throw error;} finally {tx.release();}
  return {project,file,document,identities};
}
function transport(context) {
  const control={offline:false,holdAck:false,duplicate:false,routes:[],updates:[],acks:[]};
  control.cut=() => { control.offline=true; for (const {client,server} of control.routes) { client.close({code:1012,reason:'Test transport interruption'}); server?.close(); } control.routes=[]; };
  control.restore=() => {control.offline=false;};
  control.ready=context.routeWebSocket(/\/ws\/documents\//, client => {
    if (control.offline) { client.close({code:1012}); return; }
    const server=client.connectToServer(); const route={client,server,url:client.url(),synced:false};control.routes.push(route);
    const remove=()=>{control.routes=control.routes.filter(route=>route.client!==client);};
    client.onClose(()=>{server.close();remove();});
    server.onClose(()=>{client.close();remove();});
    client.onMessage(message => {
      const frame=decodeEnvelope(new Uint8Array(message),'client');
      if (frame.type===FrameType.DURABLE_UPDATE) { control.updates.push(Buffer.from(frame.body.subarray(0,64)).toString('hex')); server.send(message); if(control.duplicate) server.send(message); }
      else server.send(message);
    });
    server.onMessage(message => {
      const frame=decodeEnvelope(new Uint8Array(message),'server');
      if(frame.type===FrameType.SYNC_STATE) route.synced=true;
      if (frame.type===FrameType.DURABLE_ACK) { control.acks.push(Buffer.from(frame.body).toString('hex')); if(control.holdAck) return; }
      client.send(message);
    });
  });
  return control;
}
async function readRows(page) {
  return page.evaluate(() => new Promise((resolve,reject) => {
    const request=indexedDB.open('cce-drafts-v1',1); request.onerror=()=>reject(request.error);
    request.onsuccess=()=>{const db=request.result;const tx=db.transaction('drafts','readonly');const rows=tx.objectStore('drafts').getAll();tx.oncomplete=()=>{db.close();resolve(rows.result.map(row=>({...row,state:Array.from(row.state),pending:row.pending.map(item=>({...item,hash:Array.from(item.hash),update:Array.from(item.update)}))})));};};
  }));
}
function retainedText(row) { const doc=new Y.Doc();doc.getText('content');Y.applyUpdate(doc,Uint8Array.from(row.state));const text=doc.getText('content').toString();doc.destroy();return text; }
async function visible(page) { return (await page.locator('.view-lines').innerText()).replace(/[\s\u200b]+/g,''); }
async function append(page,text) { await page.locator('.monaco-editor').click();await page.keyboard.press('Control+End');await page.keyboard.insertText(text); }
async function settled(page) { await until(async()=>['Synced','Saved'].includes(await page.locator('.editor-breadcrumb span').textContent()),'Document did not settle'); }
async function offlineRetained(page) { await page.locator('.editor-breadcrumb span').getByText('Offline — draft retained',{exact:true}).waitFor();return (await readRows(page))[0]; }
async function open(page,data) { await page.goto(`${origin}/projects/${data.project}/workspace`);await page.getByRole('button',{name:'File: main.js'}).click(); }
async function pair(browser,pool) {
  const data=await seed(pool); const contexts=[]; const pages=[]; const controls=[];
  for (const identity of data.identities) {
    const context=await browser.newContext();contexts.push(context);
    await context.addCookies([{name:'cce_session',value:identity.token,domain:'localhost',path:'/',httpOnly:true,sameSite:'Lax'}]);
    const control=transport(context);controls.push(control);await control.ready;
    const page=await context.newPage();pages.push(page);await open(page,data);await settled(page);
  }
  return {data,contexts,pages,controls,close:()=>Promise.all(contexts.map(context=>context.close()))};
}

test('Phase 05 real browser recovery, selective undo, awareness and privacy', {skip:!databaseURL,timeout:300000},async t=>{
  const pool=new Pool({connectionString:databaseURL});
  const browser=await chromium.launch({executablePath:process.env.CCE_BROWSER_PATH??'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',headless:true,args:['--no-sandbox','--disable-gpu','--host-resolver-rules=MAP localhost 127.0.0.1']});
  try {
    await t.test('offline concurrent edits, two tabs, relative cursors, selective undo and causal replay on reload',async()=>{
      const f=await pair(browser,pool);const [a,b]=f.pages;const [ca]=f.controls;
      try {
        await append(a,'owner');await settled(a);await until(async()=>await visible(b)==='owner','Initial convergence');
        await append(b,'peer');await settled(b);await until(async()=>await visible(a)==='ownerpeer','Peer convergence');
        await a.getByRole('list',{name:'Collaborators in this file'}).getByText('Recovery editor').waitFor();
        await a.locator('[class*="cce-cursor-"]').first().waitFor();
        await a.keyboard.press('Control+z');await settled(a);
        await until(async()=>await visible(a)==='peer'&&await visible(b)==='peer','Undo changed a remote edit');
        await a.keyboard.press('Control+Shift+z');await settled(a);await until(async()=>await visible(b)==='ownerpeer','Selective redo');
        ca.cut();await a.locator('.editor-breadcrumb span').getByText('Offline — draft retained',{exact:true}).waitFor();
        await append(a,'one');await append(a,'two');
        await a.locator('.editor-breadcrumb span').getByText('Offline — draft retained',{exact:true}).waitFor();
        const before=await offlineRetained(a);assert.ok(before.pending.length>=2);assert.match(retainedText(before),/onetwo/);
        await append(b,'online');await settled(b);
        // Reverse causally related retained entries. The server/Yjs must resolve
        // pending structs without replacing committed peer source.
        await a.evaluate(()=>new Promise(resolve=>{const r=indexedDB.open('cce-drafts-v1');r.onsuccess=()=>{const db=r.result;const tx=db.transaction('drafts','readwrite');const s=tx.objectStore('drafts');const q=s.getAll();q.onsuccess=()=>{const row=q.result[0];row.pending.reverse();s.put(row);};tx.oncomplete=()=>{db.close();resolve();};};}));
        await a.reload();await a.getByRole('button',{name:'File: main.js'}).click();
        await until(async()=> (await readRows(a))[0]?.pending.length===before.pending.length,'Reload lost outbox');
        await offlineRetained(a);
        assert.match(await visible(a),/onetwo/);
        ca.restore();await a.evaluate(()=>window.dispatchEvent(new Event('online')));await settled(a);
        await until(async()=>await visible(a)===await visible(b),'Offline changes diverged');
        assert.match(await visible(a),/online/);assert.match(await visible(a),/onetwo/);
        const original=before.pending.map(item=>item.instance.replaceAll('-','')+item.message.replaceAll('-','')+Buffer.from(item.hash).toString('hex'));
        assert.ok(original.every(id=>ca.updates.includes(id)),'Original receipt identities changed on replay');
        const tab=await f.contexts[0].newPage();await open(tab,f.data);await settled(tab);
        await append(tab,'tab');await settled(tab);await until(async()=>await visible(a)===await visible(tab)&&await visible(b)===await visible(tab),'Two tabs diverged');
        await tab.close();
        await until(async()=>await b.getByRole('list',{name:'Collaborators in this file'}).getByText('Recovery owner').count()===1,'Closed tab left ghost cursor');
        await f.contexts[0].close();
        await until(async()=>await b.getByRole('list',{name:'Collaborators in this file'}).getByText('Recovery owner').count()===0,'Ghost cursor after disconnect');
      } finally {await f.close();}
    });
    await t.test('lost acknowledgement and duplicate delivery preserve one original durable receipt',async()=>{
      const f=await pair(browser,pool);const [a,b]=f.pages;const [ca]=f.controls;
      try {
        ca.holdAck=true;ca.duplicate=true;await append(a,'once');await until(()=>ca.acks.length>=2,'Lost receipt barrier');
        assert.equal(await a.locator('.editor-breadcrumb span').textContent(),'Saving');
        const retained=(await readRows(a))[0];assert.ok(retained.pending.length>0);
        const first=ca.acks[0];ca.cut();ca.holdAck=false;ca.restore();await a.evaluate(()=>window.dispatchEvent(new Event('online')));
        await settled(a);await until(async()=>await visible(b)==='once','Lost receipt peer state');
        assert.equal((await readRows(a))[0].pending.length,0);assert.ok(ca.acks.filter(ack=>ack===first).length>=3);
        assert.equal((await pool.query('SELECT count(*)::int n FROM document_updates WHERE document_id=$1',[f.data.document])).rows[0].n,retained.pending.length);
      } finally {await f.close();}
    });
    await t.test('unrepresented retained state is reconciled with a persisted identified delta',async()=>{
      const f=await pair(browser,pool);const [a,b]=f.pages;const [ca]=f.controls;
      try {
        ca.cut();await append(a,'reconcile');await offlineRetained(a);
        await a.evaluate(()=>new Promise(resolve=>{const r=indexedDB.open('cce-drafts-v1');r.onsuccess=()=>{const db=r.result;const tx=db.transaction('drafts','readwrite');const s=tx.objectStore('drafts');const q=s.getAll();q.onsuccess=()=>{const row=q.result[0];row.pending=[];s.put(row);};tx.oncomplete=()=>{db.close();resolve();};};}));
        await a.reload();await a.getByRole('button',{name:'File: main.js'}).click();ca.restore();await a.evaluate(()=>window.dispatchEvent(new Event('online')));
        await settled(a);await until(async()=>await visible(b)==='reconcile','Reconciliation lost state');
        assert.equal((await pool.query('SELECT count(*)::int n FROM document_updates WHERE document_id=$1',[f.data.document])).rows[0].n,1);
      } finally {await f.close();}
    });
    await t.test('offline role downgrade and expiry keep outboxes without later appends',async()=>{
      for(const kind of ['role','expiry']) {
        const f=await pair(browser,pool);const b=f.pages[1];const cb=f.controls[1];
        try {
          cb.cut();await append(b,kind);const retained=await offlineRetained(b);
          if(kind==='role') await pool.query("UPDATE project_members SET role='viewer' WHERE project_id=$1 AND user_id=$2",[f.data.project,f.data.identities[1].user]);
          else await pool.query("UPDATE sessions SET expires_at=now()-interval '1 second' WHERE user_id=$1",[f.data.identities[1].user]);
          cb.restore();await b.evaluate(()=>window.dispatchEvent(new Event('online')));
          await b.locator('.editor-breadcrumb span').getByText('Access changed',{exact:true}).waitFor();
          assert.equal((await readRows(b))[0].pending.length,retained.pending.length);assert.equal((await pool.query('SELECT count(*)::int n FROM document_updates WHERE document_id=$1',[f.data.document])).rows[0].n,0);
          const download=b.waitForEvent('download');await b.getByRole('button',{name:'Download visible draft'}).click();assert.ok((await download).suggestedFilename().startsWith('draft-'));
        } finally {await f.close();}
      }
    });
    await t.test('offline generation replacement and deletion retain separately exportable drafts',async()=>{
      for(const kind of ['replace','delete']) {
        const f=await pair(browser,pool);const a=f.pages[0];const ca=f.controls[0];
        try {
          ca.cut();await append(a,'oldversion');const retained=await offlineRetained(a);
          if(kind==='delete') await pool.query('UPDATE files SET tombstoned_at=now() WHERE id=$1',[f.data.file]);
          else {const tx=await pool.connect();try {await tx.query('BEGIN');const doc=(await tx.query('INSERT INTO documents(file_id,generation) VALUES($1,2) RETURNING id',[f.data.file])).rows[0].id;await tx.query('UPDATE files SET generation=2,current_document_id=$1 WHERE id=$2',[doc,f.data.file]);await tx.query('COMMIT');}finally{tx.release();}}
          ca.restore();await a.evaluate(()=>window.dispatchEvent(new Event('online')));await a.locator('.editor-breadcrumb span').getByText('Version replaced/deleted',{exact:true}).waitFor();
          assert.equal((await readRows(a))[0].pending.length,retained.pending.length);assert.match(retainedText((await readRows(a))[0]),/oldversion/);
          await a.getByRole('button',{name:'Recover drafts'}).click();await a.getByRole('dialog',{name:'Recover browser drafts'}).getByText(/Version replaced\/deleted/).waitFor();
          assert.equal((await pool.query('SELECT count(*)::int n FROM document_updates WHERE document_id=$1',[f.data.document])).rows[0].n,0);
        } finally {await f.close();}
      }
    });
    await t.test('browser storage failure/full is visible, stops sending and exports the visible draft',async()=>{
      for(const failure of ['unavailable','full']) {
        const f=await pair(browser,pool);const a=f.pages[0];
        try {
          if(failure==='unavailable') {
            await a.addInitScript(()=>{indexedDB.open=()=>{throw new DOMException('Browser storage unavailable','SecurityError');};});
            await a.reload();await a.getByRole('button',{name:'File: main.js'}).click();
          } else {
            await a.evaluate(()=>{IDBObjectStore.prototype.put=function(){throw new DOMException('Browser storage full','QuotaExceededError');};});
            await append(a,'unsavedvisible');
          }
          await a.locator('.editor-breadcrumb span').getByText('Storage unavailable',{exact:true}).waitFor();
          assert.equal((await pool.query('SELECT count(*)::int n FROM document_updates WHERE document_id=$1',[f.data.document])).rows[0].n,0);
          if(failure==='full') assert.match(await visible(a),/unsavedvisible/);
          const download=a.waitForEvent('download');await a.getByRole('button',{name:'Download visible draft'}).click();assert.ok((await download).suggestedFilename().startsWith('draft-'));
        } finally {await f.close();}
      }
    });
    await t.test('logout clears account caches and closes another tab without cross-account reuse',async()=>{
      const f=await pair(browser,pool);const a=f.pages[0];
      try {
        const marker='logout-source-sentinel';await append(a,marker);await settled(a);assert.ok((await visible(a)).includes(marker));
        const home=await f.contexts[0].newPage();await home.goto(origin);await home.getByRole('button',{name:'Sign out'}).click();
        await until(async()=>(await readRows(home)).length===0,'Logout did not purge account cache');
        // The provider clears its model, while project revalidation may remove
        // the editor altogether. Both must remove source, caches and transports.
        await until(async()=>{const count=await a.locator('.view-lines').count();return count===0||await visible(a)==='';},'Other tab retained source after logout');
        assert.equal((await a.content()).includes(marker),false,'Logged-out source remains in the DOM');
        await until(()=>f.controls[0].routes.length===0,'Document transport survived logout');
        await f.contexts[0].addCookies([{name:'cce_session',value:f.data.identities[1].token,domain:'localhost',path:'/'}]);
        await a.reload();await a.getByRole('button',{name:'File: main.js'}).click();await settled(a);
        const rows=await readRows(a);assert.ok(rows.every(row=>row.scope.userID===f.data.identities[1].user));
      } finally {await f.close();}
    });
    await t.test('outbox ceiling fails visibly and repeated file switching disposes transports and models',async()=>{
      const f=await pair(browser,pool);const a=f.pages[0];const ca=f.controls[0];
      try {
        const created=await a.evaluate(async project=>{
          const session=await (await fetch('/api/v1/session')).json();const tree=await (await fetch(`/api/v1/projects/${project}/tree`)).json();
          const response=await fetch(`/api/v1/projects/${project}/tree`,{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':session.csrf_token,'If-Match':tree.tree_version},body:JSON.stringify({kind:'file',name:'second.js',parent_id:null})});return {status:response.status,body:await response.json()};
        },f.data.project);assert.equal(created.status,201);
        await a.getByRole('button',{name:'File: second.js'}).waitFor();
        await append(a,'switchdraft');
        await a.getByRole('button',{name:'File: second.js'}).click();
        await until(()=>ca.routes.some(route=>route.url.endsWith(created.body.entry.document_id)&&route.synced),'New file sync');
        await a.getByRole('button',{name:'File: main.js'}).click();
        await until(()=>ca.routes.some(route=>route.url.endsWith(f.data.document)&&route.synced),'Original file resync');await settled(a);
        await until(async()=>(await visible(f.pages[1])).includes('switchdraft'),'Switch lost queued local retention');
        for(let index=0;index<12;index++) {
          await a.getByRole('button',{name:index%2?'File: main.js':'File: second.js'}).click();
          const documentID=index%2?f.data.document:created.body.entry.document_id;
          await until(()=>ca.routes.length===1 && ca.routes[0].url.endsWith(documentID) && ca.routes[0].synced,'File switch leaked transports or did not sync');await settled(a);
          assert.equal(await a.locator('.monaco-editor').count(),1);
          assert.equal(await a.locator('style').evaluateAll(elements=>elements.filter(element=>element.textContent.includes('.cce-cursor-')).length)<=1,true,'Cursor styles leaked');
        }
        ca.cut();await append(a,'bounded');await offlineRetained(a);
        await a.evaluate(()=>new Promise(resolve=>{const r=indexedDB.open('cce-drafts-v1');r.onsuccess=()=>{const db=r.result;const tx=db.transaction('drafts','readwrite');const s=tx.objectStore('drafts');const q=s.getAll();q.onsuccess=()=>{const row=q.result.find(row=>row.pending.length);const item=row.pending[0];row.pending=Array.from({length:4096},()=>({...item,message:crypto.randomUUID()}));s.put(row);};tx.oncomplete=()=>{db.close();resolve();};};}));
        await append(a,'overflow');await a.locator('.editor-breadcrumb span').getByText('Storage unavailable',{exact:true}).waitFor();
        assert.match(await a.locator('.draft-tools [role=status]').textContent(),/full|storage/i);
        assert.match(await visible(a),/overflow/);
        assert.equal((await readRows(a)).find(row=>row.pending.length).pending.length,4096,'Storage-full transaction must not clear prior entries');
      } finally {await f.close();}
    });
    if(process.env.CCE_E2E_RESTART==='1') await t.test('worker SIGKILL reconnects automatically after real lease expiry, Redis loss does not lose edits',async()=>{
      const f=await pair(browser,pool);const [a,b]=f.pages;
      try {
        await append(a,'before');await settled(a);
        execFileSync('docker',[...compose,'kill','-s','SIGKILL','collab'],{stdio:'pipe',timeout:30000});
        await a.locator('.editor-breadcrumb span').getByText('Offline — draft retained',{exact:true}).waitFor();await append(a,'restartdraft');
        assert.ok((await offlineRetained(a)).pending.length>0);
        await delay(16000);execFileSync('docker',[...compose,'start','--wait','--wait-timeout','30','collab'],{stdio:'pipe',timeout:45000});
        await settled(a);await settled(b);await until(async()=>await visible(a)===await visible(b)&& (await visible(b)).includes('restartdraft'),'Automatic restart recovery',25000);
        execFileSync('docker',[...compose,'stop','redis'],{stdio:'pipe',timeout:30000});
        try {await append(b,'redisdown');await settled(b);await until(async()=>(await visible(a)).includes('redisdown'),'Redis failure lost committed edits');}
        finally {execFileSync('docker',[...compose,'start','--wait','redis'],{stdio:'pipe',timeout:30000});}
      } finally {await f.close();}
    });
  } finally {await browser.close();await pool.end();}
});
