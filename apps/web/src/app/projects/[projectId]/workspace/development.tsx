"use client";

import { useEffect, useRef, useState } from "react";
import { flushProject } from "@/collaboration/run-input";
import WorkspaceTerminal from "./terminal";
import Icon from "./workbench-icon";

type Environment = { state: string; language: string; root: string; entrypoint: string; checkpoint_id?: string; terminals: number; task?: { id: string; action: string; state: string; log: string; exit_code: number } };
const labels: Record<string, string> = { python: "Python", node: "Node.js", typescript: "TypeScript", cpp: "C++", java: "Java", go: "Go" };

export default function DevelopmentWorkspace({ projectID, userID, csrf, role, onBusy, requestedTab = "environment", requestID = 0, visible = true }: { projectID: string; userID: string; csrf: string; role: string; onBusy: (busy: boolean) => void; requestedTab?: "environment" | "output" | "terminal"; requestID?: number; visible?: boolean }) {
 const base = `/api/v1/projects/${projectID}`; const endpoint = `${base}/workspace`;
 const [environment, setEnvironment] = useState<Environment | null>(null); const [language, setLanguage] = useState("python"); const [root, setRoot] = useState("."); const [entrypoint, setEntrypoint] = useState("");
 const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [status, setStatus] = useState(""); const [shells, setShells] = useState<string[]>([]);
 const [view, setView] = useState<"environment" | "output" | "terminal">(requestedTab);
 const [activeShell, setActiveShell] = useState("");
 const lastRequest = useRef(-1);
 useEffect(() => { if (lastRequest.current !== requestID) { lastRequest.current = requestID; setView(requestedTab); } }, [requestedTab, requestID]);
 const canEdit = role === "owner" || role === "editor"; const runningTask = environment?.task?.state === "running";
 useEffect(() => {
  let stopped = false; let initialized = false;
  const refresh = async () => { try { const response = await fetch(endpoint, { cache: "no-store" }); const result = await response.json(); if (!response.ok) throw new Error(result.message ?? "Workspace unavailable"); if (!stopped) { setEnvironment(result); if (!initialized) { setLanguage(result.language); setRoot(result.root); setEntrypoint(result.entrypoint); initialized = true; } } } catch (cause) { if (!stopped) setError(cause instanceof Error ? cause.message : "Workspace unavailable"); } };
  void refresh(); const timer = setInterval(() => void refresh(), 2000); return () => { stopped = true; clearInterval(timer); };
 }, [endpoint]);
 async function request(path: string, method: string, body?: object) {
  const response = await fetch(path, { method, headers: { "X-CSRF-Token": csrf, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  if (response.status === 204) return null; const result = await response.json(); if (!response.ok) throw new Error(result.message ?? "Workspace action failed."); return result;
 }
 async function syncSource() {
  setStatus("Waiting for saved edits…"); await flushProject(userID, projectID);
  const checkpoint = await request(`${base}/checkpoints`, "POST", { name: "Development workspace sync" });
  setStatus("Preparing saved source checkpoint…"); let ready = false;
  for (let attempt = 0; attempt < 120; attempt++) {
   const response = await fetch(`${base}/checkpoints/${checkpoint.id}`, { cache: "no-store" }); const result = await response.json();
   if (response.ok) { ready = true; break; }
   if (result.code !== "CHECKPOINT_NOT_READY") throw new Error(result.message ?? "Checkpoint preparation failed.");
   await new Promise(resolve => setTimeout(resolve, 1000));
  }
  if (!ready) throw new Error("Checkpoint preparation timed out. Retry Sync saved source.");
  setStatus("Syncing saved source…"); setEnvironment(await request(`${endpoint}/sync`, "POST", { checkpoint_id: checkpoint.id }));
 }
 async function act(action: string) {
  setBusy(true); onBusy(true); setError(""); setStatus("");
  try {
   if (action === "delete") {
    if (!window.confirm("Delete the development environment and its installed dependencies and terminal files? Collaborative project files are retained.")) return;
    await request(endpoint, "DELETE"); setEnvironment(null); setStatus("Environment deleted.");
   } else if (action === "start" || action === "stop") {
    setEnvironment(await request(endpoint, "PUT", { action, language, root, entrypoint })); setStatus(action === "start" ? "Environment started. Sync saved source before building or running." : "Environment stopped. Dependencies and files are retained.");
   } else if (action === "sync") {
    if (environment?.checkpoint_id && !window.confirm("Replace the terminal working copy with saved collaborative source? Terminal source edits will be discarded; dependencies are retained.")) return;
    await syncSource(); setStatus("Saved source synced. Workspace source edits stay separate from collaborative documents.");
   } else {
    const task = await request(`${endpoint}/tasks`, "POST", { action }); setEnvironment(current => current ? { ...current, task } : current); setView("output"); setStatus(`${action} started.`);
   }
  } catch (cause) { setError(cause instanceof Error ? cause.message : "Workspace action failed."); }
  finally { setBusy(false); onBusy(false); }
 }
 const blocked = busy || Boolean(runningTask) || Boolean(environment?.terminals) || shells.length > 0;
 const state = environment?.state ?? "loading";
 const started = state === "running";
 const configured = environment && state !== "absent" && state !== "loading";
 const dirty = Boolean(environment && (environment.language !== language || environment.root !== root || environment.entrypoint !== entrypoint));
 const taskBlocked = blocked || !environment?.checkpoint_id || !started || dirty;
 function newTerminal() { const id = crypto.randomUUID(); setShells(current => [...current, id]); setActiveShell(id); setView("terminal"); }
 function closeTerminal(id: string) { setShells(current => { const next = current.filter(item => item !== id); if (activeShell === id) setActiveShell(next.at(-1) ?? ""); return next; }); }
 return <section className="development-panel" aria-label="Development workspace">
  <div className="dev-tabbar"><div role="tablist" aria-label="Development panels">{(["environment", "output", "terminal"] as const).map(tab => <button key={tab} type="button" role="tab" aria-selected={view === tab} onClick={() => setView(tab)}>{tab === "environment" ? "Environment" : tab === "output" ? "Task output" : "Terminal"}{tab === "terminal" && shells.length > 0 && <span className="tab-count">{shells.length}</span>}</button>)}</div><span className={`environment-state ${started ? "online" : ""}`}><span className="state-dot" />{state === "absent" ? "Not created" : state === "exited" ? "Stopped" : state}</span></div>
  {view === "environment" && <div className="environment-content">
   <div className="environment-intro"><div><h3>Project environment</h3><p>Configure once. Sync your files, install dependencies, and run.</p></div><span className="resource-label">2 CPU · 2 GiB</span></div>
   {canEdit ? <>
    <div className="development-config"><label>Toolchain<select value={language} disabled={blocked} onChange={event => setLanguage(event.target.value)}>{Object.entries(labels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>Project folder<input value={root} disabled={blocked} onChange={event => setRoot(event.target.value)} placeholder=". or imported-folder" /></label><label>Entrypoint<input value={entrypoint} disabled={blocked} onChange={event => setEntrypoint(event.target.value)} placeholder={language === "java" ? "Main.java or com.example.Main" : language === "go" ? "main.go or ." : "e.g. main.py"} /></label></div>
    <div className="environment-actionbar"><button className="primary" type="button" disabled={blocked} onClick={() => void act("start")}><Icon name={started ? "check" : "play"} />{started ? "Save configuration" : configured ? "Start environment" : "Create environment"}</button>{started && <button type="button" disabled={busy} onClick={() => void act("stop")}><Icon name="stop" />{runningTask ? "Cancel task" : "Stop"}</button>}{dirty && <span className="inline-hint">Unsaved configuration</span>}</div>
    <div className="workflow-actions"><button type="button" disabled={blocked || !started || dirty} onClick={() => void act("sync")}><Icon name="refresh" /><span>Sync saved source</span>{environment?.checkpoint_id && <Icon name="check" size={13} />}</button><button type="button" disabled={taskBlocked} onClick={() => void act("install")}><Icon name="download" /><span>Install dependencies</span></button><button type="button" disabled={taskBlocked} onClick={() => void act("build")}><Icon name="code" /><span>Build</span></button><button type="button" disabled={taskBlocked || !entrypoint} onClick={() => void act("run")}><Icon name="play" /><span>Run workspace</span></button><button type="button" disabled={busy || runningTask || !started || shells.length >= 4 || dirty} onClick={newTerminal}><Icon name="terminal" /><span>New terminal</span></button></div>
    {!started ? <p className="context-hint">Start the environment to enable builds and terminals.</p> : dirty ? <p className="context-hint">Save the configuration before continuing.</p> : !environment?.checkpoint_id ? <p className="context-hint">Sync saved source to enable dependency installation and builds.</p> : blocked && <p className="context-hint">Close active terminals and finish the task before syncing or changing configuration.</p>}
   </> : <p className="context-hint">Viewer access. Editors and owners can manage this environment.</p>}
   <details className="environment-help"><summary>Runtime details &amp; source sync</summary><p>{language === "python" ? "Install uses requirements.txt. Terminal pip and Run share the project virtual environment. For CPU PyTorch, use the CPU wheel index in requirements.txt." : language === "java" ? "Maven uses pom.xml. Use Gradle wrappers from the terminal. Entrypoint can be a Java source file or compiled main class." : language === "cpp" ? "CMake and GCC are available. Use the terminal for custom native builds and CMake targets." : language === "go" ? "Go dependencies come from go.mod. Use . as the entrypoint to run the complete package." : "Install uses package.json and its lockfile. TypeScript includes tsc; project build scripts are supported."}</p><p>Sync replaces the terminal working copy with saved collaborative source. Terminal edits stay separate. Close all terminals before syncing. Environments stop after 15 minutes idle.</p>{environment?.checkpoint_id && <p className="checkpoint-reference">Synced checkpoint <code>{environment.checkpoint_id}</code></p>}{role === "owner" && configured && <button className="danger-text" type="button" disabled={blocked} onClick={() => void act("delete")}><Icon name="trash" />Delete environment and storage</button>}</details>
  </div>}
  {view === "output" && <section className="task-output-content" aria-label="Workspace task logs">{environment?.task ? <><div className="task-output-toolbar"><span>{environment.task.action}</span><span className={`task-state ${environment.task.state}`}>{environment.task.state}{environment.task.state !== "running" && ` · Exit ${environment.task.exit_code}`}</span>{canEdit && runningTask && <button type="button" onClick={() => void act("stop")} disabled={busy}><Icon name="stop" />Cancel task</button>}</div><pre className="workspace-task-log">{environment.task.log || "Waiting for output…"}</pre></> : <div className="panel-empty"><Icon name="code" size={30} /><h3>No task output yet</h3><p>Install dependencies, build, or run from Environment.</p><button type="button" onClick={() => setView("environment")}>Open environment</button></div>}</section>}
  <div className="terminal-content" hidden={view !== "terminal"}>
   <div className="terminal-tabbar"><div className="terminal-tabs" role="tablist" aria-label="Shell sessions">{shells.map((id, index) => <div className={`terminal-tab ${activeShell === id ? "active" : ""}`} key={id}><button type="button" role="tab" aria-selected={activeShell === id} onClick={() => setActiveShell(id)}><Icon name="terminal" />bash {index + 1}</button><button type="button" aria-label={`Close terminal ${index + 1}`} title="Close terminal" onClick={() => closeTerminal(id)}><Icon name="close" size={13} /></button></div>)}</div>{canEdit && <button type="button" className="icon-button" aria-label="New terminal" title="New terminal" disabled={busy || runningTask || !started || shells.length >= 4 || dirty} onClick={newTerminal}><Icon name="plus" /></button>}</div>
   {shells.length === 0 && <div className="panel-empty"><Icon name="terminal" size={30} /><h3>Your terminal</h3><p>{started ? "Open your own shell. Project files and dependencies are shared." : "Start the project environment to open a terminal."}</p>{canEdit && <button type="button" disabled={!started || busy || runningTask || dirty} onClick={newTerminal}><Icon name="plus" />Open shell</button>}</div>}
   {shells.map(id => <div className="terminal-session" key={id} hidden={activeShell !== id}><WorkspaceTerminal projectID={projectID} visible={visible && view === "terminal" && activeShell === id} /></div>)}
  </div>
  {(status || error) && <div className={`development-notice ${error ? "error" : ""}`} role={error ? "alert" : "status"}>{busy && <span className="busy-dot" />}{error || status}<button type="button" aria-label="Dismiss workspace message" onClick={() => { setError(""); setStatus(""); }}><Icon name="close" size={12} /></button></div>}
 </section>;
}
