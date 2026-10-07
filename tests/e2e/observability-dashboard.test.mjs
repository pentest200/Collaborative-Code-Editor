import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { mkdirSync, writeFileSync } from "node:fs";
import {setTimeout as delay} from "node:timers/promises";

test("Phase 09 authenticated provisioned Grafana dashboard queries and actual screenshot", {timeout:60000}, async(t)=>{
 const password=process.env.GRAFANA_ADMIN_PASSWORD;assert.ok(password,"GRAFANA_ADMIN_PASSWORD required; no silent skip");
 const keepAlive=setInterval(()=>{},1000);t.after(()=>clearInterval(keepAlive));
 const origin="http://127.0.0.1:3001",auth="Basic "+Buffer.from("cce_operator:"+password).toString("base64");
 let healthy=false;for(let n=0;n<30;n++){try{healthy=(await fetch(origin+"/api/health",{signal:AbortSignal.timeout(1000)})).ok;}catch{/* bounded process-start readiness retry */}if(healthy)break;await delay(250);}assert.ok(healthy,"Grafana did not become healthy");
 const response=await fetch(origin+"/api/dashboards/uid/cce-release",{headers:{Authorization:auth}});assert.equal(response.status,200);const data=await response.json();assert.equal(data.dashboard.panels.length,9);
 // Separate selector series preserve metric names. PromQL `or` would silently
 // discard rooms/queue bytes when their labels match the left-hand series.
 for(const id of [2,4])assert.match(data.dashboard.panels.find(p=>p.id===id).targets[0].expr,/__name__=~/);
 const browser=await chromium.launch({executablePath:process.env.CCE_BROWSER_PATH??"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",headless:true,args:["--no-sandbox","--disable-gpu"]});
 try{
  const context=await browser.newContext({viewport:{width:1600,height:1900}});const login=await context.request.post(origin+"/login",{data:{user:"cce_operator",password}});assert.equal(login.status(),200);
  const page=await context.newPage(),errors=[],pending=[];let queries=0;
  page.on("response",response=>{if(response.url().includes("/api/ds/query")){queries++;pending.push((async()=>{assert.equal(response.status(),200);const body=await response.json();for(const result of Object.values(body.results??{}))if(result.error)errors.push(result.error);})());}});
  await page.goto(origin+"/d/cce-release");await page.getByText("CCE measured operations",{exact:true}).first().waitFor();await page.waitForTimeout(6000);await Promise.all(pending);assert.ok(queries>=9);assert.deepEqual(errors,[]);assert.equal(await page.getByText("Panel plugin not found",{exact:false}).count(),0);
  mkdirSync("docs/screenshots",{recursive:true});await page.screenshot({path:"docs/screenshots/phase09-observability.png",fullPage:true});mkdirSync("docs/measurements",{recursive:true});writeFileSync("docs/measurements/phase09-dashboard.json",JSON.stringify({date:new Date().toISOString(),authenticatedDashboard:true,provisionedPanels:data.dashboard.panels.length,successfulQueryRequests:queries,queryErrors:errors,missingPanelPlugins:0},null,2)+"\n");
 }finally{await browser.close();}
});
