// Interactive acceptance: GitHub credentials/consent are entered by the user,
// never by this test. No tokens, cookies, callback queries or identity are logged.
import assert from "node:assert/strict";
import {chromium} from "playwright-core";
import {mkdirSync,writeFileSync} from "node:fs";
import {setTimeout as sleep} from "node:timers/promises";
const reportDir=process.env.CCE_REPORT_DIR??"docs/measurements";
const report={date:new Date().toISOString(),kind:"live GitHub OAuth; manual authentication and consent",status:"pending",configured:false,redirectVerified:false,callbackVerified:false,sessionVerified:false,protectedProjectsVerified:false,logoutVerified:false};
let browser;
try{
 const config=await (await fetch("http://127.0.0.1:3000/api/v1/auth/config")).json();report.configured=config.github_enabled;assert.equal(config.github_enabled,true,"Live GitHub OAuth is not configured");
 browser=await chromium.launch({executablePath:process.env.CCE_BROWSER_PATH??"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",headless:false,args:["--host-resolver-rules=MAP localhost 127.0.0.1"]});
 const context=await browser.newContext(),page=await context.newPage();
 page.on("response",response=>{const url=new URL(response.url());if(url.origin==="http://localhost:3000"&&url.pathname==="/api/v1/auth/github/callback"){report.issuerParameterPresent=url.searchParams.has("iss");report.issuerMatched=report.issuerParameterPresent?url.searchParams.get("iss")==="https://github.com/login/oauth":null;if(response.status()===302)report.callbackVerified=true;}});
 await page.goto("http://localhost:3000");const startResponse=page.waitForResponse(r=>new URL(r.url()).pathname==="/api/v1/auth/github/start"&&r.status()===302);await page.getByRole("link",{name:"Sign in with GitHub",exact:true}).click();
 await page.waitForURL(url=>url.hostname==="github.com",{timeout:30000});
 const redirect=new URL((await startResponse).headers()["location"]);assert.equal(redirect.origin,"https://github.com");assert.ok(redirect.searchParams.get("client_id"));assert.equal(redirect.searchParams.get("redirect_uri"),"http://localhost:3000/api/v1/auth/github/callback");assert.equal(redirect.searchParams.get("code_challenge_method"),"S256");assert.equal(redirect.searchParams.get("scope")??"","");assert.ok(redirect.searchParams.get("state"));report.redirectVerified=true;
 console.log("Complete GitHub sign-in and consent yourself in the opened Edge window. Waiting up to ten minutes; no authentication fields are automated.");
 const deadline=Date.now()+600000;let completed=false;
 while(Date.now()<deadline){if(page.isClosed())throw new Error("Interactive browser closed before verification");const url=new URL(page.url());if(url.origin==="http://localhost:3000"&&url.pathname==="/"){completed=true;break;}if(url.origin==="http://localhost:3000"&&url.pathname==="/api/v1/auth/github/callback"){throw new Error("Live OAuth callback failed; review the displayed safe application error");}await sleep(500);}
 assert.ok(completed,"Manual GitHub authentication did not finish within ten minutes");assert.equal(report.callbackVerified,true);
 const session=await context.request.get("http://localhost:3000/api/v1/session");assert.equal(session.status(),200);const current=await session.json();assert.ok(current.user.id);assert.ok(current.csrf_token);
 const cookie=(await context.cookies()).find(c=>c.name==="cce_session");assert.ok(cookie?.httpOnly);assert.equal(cookie.sameSite,"Lax");report.sessionVerified=true;
 assert.equal((await context.request.get("http://localhost:3000/api/v1/projects")).status(),200);report.protectedProjectsVerified=true;
 await page.reload();await page.getByRole("button",{name:"Sign out",exact:true}).waitFor();await page.getByRole("button",{name:"Sign out",exact:true}).click();await page.getByRole("link",{name:"Sign in with GitHub",exact:true}).waitFor();assert.equal((await context.request.get("http://localhost:3000/api/v1/session")).status(),401);assert.equal((await context.request.get("http://localhost:3000/api/v1/projects")).status(),401);report.logoutVerified=true;report.status="passed";
 console.log("Live GitHub callback, application session, protected project read and logout passed.");
}catch(error){report.status="blocked_or_failed";report.reason=error.message.includes("Manual GitHub")?"manual authentication pending":error.message.includes("callback")?"live callback failed":error.message.includes("configured")?"credentials unavailable":"interactive flow did not complete";console.error(report.reason);process.exitCode=1;}
finally{await browser?.close();mkdirSync(reportDir,{recursive:true});writeFileSync(`${reportDir}/live-oauth.json`,JSON.stringify(report,null,2)+"\n");}
