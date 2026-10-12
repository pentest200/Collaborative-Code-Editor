"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import MonacoPreview from "./monaco-preview";
import Checkpoints from "./checkpoints";
import Runs from "./runs";
import ProjectSearch from "./search";
import ImportFiles from "./import-files";
import DevelopmentWorkspace from "./development";
import Icon from "./workbench-icon";
import { useDialogFocus } from "./dialog-focus";
import AssetPreview from "./asset-preview";
import type { ConnectionState } from "@/collaboration/provider";
import { DraftRecovery } from "@/collaboration/draft-recovery";

type Project = { id: string; name: string; role: "owner" | "editor" | "viewer" };
type Session = { user: { id: string }; csrf_token: string };
type Entry = { id: string; parent_id: string | null; name: string; kind: "file" | "folder"; language: string | null; document_id: string | null; generation: string; storage_kind?: string; byte_size?: number; media_type?: string };
type Tree = { tree_version: string; event_sequence: string; entries: Entry[] };
type Action = "file" | "folder" | "rename" | "move" | null;

function flatten(entries: Entry[], collapsed: Set<string>, query: string) {
  const children = new Map<string, Entry[]>();
  for (const entry of entries) {
    const key = entry.parent_id ?? "root";
    children.set(key, [...(children.get(key) ?? []), entry]);
  }
  for (const list of children.values()) list.sort((a, b) => Number(b.kind === "folder") - Number(a.kind === "folder") || a.name.localeCompare(b.name));
  const rows: { entry: Entry; depth: number }[] = [];
  const visit = (parent: string, depth: number) => {
    for (const entry of children.get(parent) ?? []) {
      if (!query || entry.name.toLowerCase().includes(query.toLowerCase())) rows.push({ entry, depth: query ? 0 : depth });
      if (query || !collapsed.has(entry.id)) visit(entry.id, depth + 1);
    }
  };
  visit("root", 0);
  return rows;
}

export default function WorkspacePage() {
  const { projectId } = useParams<{ projectId: string }>();
  const base = `/api/v1/projects/${projectId}`;
  const [project, setProject] = useState<Project | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [tree, setTree] = useState<Tree | null>(null);
  const [tabs, setTabs] = useState<string[]>([]);
  const [activeId, setActiveId] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [action, setAction] = useState<Action>(null);
  const [name, setName] = useState("");
  const [parent, setParent] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [cursor, setCursor] = useState({ line: 1, column: 1 });
  const [connection, setConnection] = useState<ConnectionState>("Connecting");
  const [checkpointsOpen, setCheckpointsOpen] = useState(false);
  const [runsOpen, setRunsOpen] = useState(false);
  const [runBusy, setRunBusy] = useState(false);
  const [executionEnabled, setExecutionEnabled] = useState(false);
  const [workspaceEnabled, setWorkspaceEnabled] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelMode, setPanelMode] = useState<"development" | "captured">("development");
  const [developmentTab, setDevelopmentTab] = useState<"environment" | "output" | "terminal">("environment");
  const [developmentRequest, setDevelopmentRequest] = useState(0);
  const [panelHeight, setPanelHeight] = useState(310);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(260);
  const editorArea = useRef<HTMLElement>(null);
  const panelDrag = useRef<{ y: number; height: number } | null>(null);
  const sidebarDrag = useRef<{ x: number; width: number } | null>(null);
  const mobileLayout = useRef(false);
  const eventSequence = useRef("0");

  function openPanel(mode: "development" | "captured", tab: "environment" | "output" | "terminal" = "environment") {
    setPanelOpen(true); setPanelMode(mode); setDevelopmentTab(tab); setDevelopmentRequest(value => value + 1); if (mode === "captured") setRunsOpen(true);
  }
  const clampPanel = useCallback((height: number) => Math.max(140, Math.min(height, (editorArea.current?.clientHeight ?? window.innerHeight - 70) - 120)), []);
  useEffect(() => {
    const resize = () => {
      setPanelHeight(current => clampPanel(current));
      const mobile = window.innerWidth <= 720;
      if (mobile !== mobileLayout.current) { mobileLayout.current = mobile; setSidebarOpen(!mobile); }
    };
    const shortcuts = (event: KeyboardEvent) => {
      if (document.querySelector('[aria-modal="true"]')) { if (event.key === "Escape" && action && !busy) setAction(null); return; }
      const modifier = event.ctrlKey || event.metaKey;
      if (modifier && event.key.toLowerCase() === "b") { event.preventDefault(); setSidebarOpen(open => !open); }
      if (modifier && event.key.toLowerCase() === "j") { event.preventDefault(); setPanelOpen(open => !open); }
      if (modifier && event.shiftKey && event.key.toLowerCase() === "f") { event.preventDefault(); setSidebarOpen(true); setSearchOpen(true); }
      if (modifier && event.shiftKey && event.key.toLowerCase() === "e") { event.preventDefault(); setSidebarOpen(true); setSearchOpen(false); }
      if (modifier && event.key === "`" && workspaceEnabled) { event.preventDefault(); setPanelOpen(true); setPanelMode("development"); setDevelopmentTab("terminal"); setDevelopmentRequest(value => value + 1); }
      if (modifier && event.key.toLowerCase() === "p") { event.preventDefault(); setSidebarOpen(true); setSearchOpen(false); requestAnimationFrame(() => document.getElementById("file-search")?.focus()); }
      if (event.key === "Escape" && action && !busy) setAction(null);
    };
    resize(); window.addEventListener("resize", resize); window.addEventListener("keydown", shortcuts);
    return () => { window.removeEventListener("resize", resize); window.removeEventListener("keydown", shortcuts); };
  }, [workspaceEnabled, action, busy, clampPanel]);
  useDialogFocus(Boolean(action), "File tree action");
  useEffect(() => { if (action) document.getElementById(action === "move" ? "entry-parent" : "entry-name")?.focus(); }, [action]);

  const loadTree = useCallback(async () => {
    const response = await fetch(`${base}/tree`, { cache: "no-store" });
    if (!response.ok) throw new Error(response.status === 404 ? "Project access has changed." : "Could not load the file tree.");
    const next = await response.json() as Tree;
    eventSequence.current = next.event_sequence;
    setTree(next);
    setTabs((current) => current.filter((id) => next.entries.some((entry) => entry.id === id && entry.kind === "file")));
    setActiveId((current) => next.entries.some((entry) => entry.id === current && entry.kind === "file") ? current : "");
    return next;
  }, [base]);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const [sessionResponse, projectResponse, configResponse] = await Promise.all([fetch("/api/v1/session", { cache: "no-store" }), fetch(base, { cache: "no-store" }), fetch("/api/v1/auth/config", { cache: "no-store" })]);
        if (configResponse.ok) { const config = await configResponse.json() as { execution_enabled?: boolean; workspace_enabled?: boolean }; if (active) { setExecutionEnabled(config.execution_enabled === true); setWorkspaceEnabled(config.workspace_enabled === true); } }
        if (!sessionResponse.ok) throw new Error("Sign in to view this workspace.");
        const authenticated = await sessionResponse.json() as Session;
        if (active) setSession(authenticated);
        if (!projectResponse.ok) throw new Error("Project not found or access has changed.");
        const [currentSession, currentProject] = [authenticated, await projectResponse.json() as Project];
        if (!active) return;
        setSession(currentSession); setProject(currentProject);
        await loadTree();
      } catch (cause) { if (active) setError(cause instanceof Error ? cause.message : "Could not load workspace."); }
      finally { if (active) setLoading(false); }
    })();
    return () => { active = false; };
  }, [base, loadTree]);

  const eventsReady = Boolean(project && tree);
  useEffect(() => {
    if (!eventsReady) return;
    let stopped = false;
    let socket: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let refreshing = false;
    let dirty = false;
    const refresh = async () => {
      if (refreshing) { dirty = true; return; }
      refreshing = true;
      try {
        do {
          dirty = false;
          const response = await fetch(base, { cache: "no-store" });
          if (!response.ok) { setProject(null); setError("Project access has changed."); return; }
          setProject(await response.json() as Project);
          await loadTree();
        } while (dirty && !stopped);
      } catch { if (!stopped) setError("Could not refresh project changes."); }
      finally { refreshing = false; }
    };
    const connect = () => {
      if (stopped) return;
      const endpoint = new URL(`/ws/projects/${projectId}?after=${eventSequence.current}`, location.href);
      endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
      const current = new WebSocket(endpoint);
      socket = current;
      current.onmessage = (message) => {
        try {
          const frame = JSON.parse(String(message.data)) as { type?: string };
          if (frame.type === "EVENT" || frame.type === "RESYNC_REQUIRED") void refresh();
          if (frame.type === "ACCESS_CHANGED") { setProject(null); setError("Project access has changed."); current.close(); }
        } catch { setError("Could not read project changes."); }
      };
      current.onclose = () => { if (!stopped) retry = setTimeout(connect, 1000); };
    };
    connect();
    return () => { stopped = true; if (retry) clearTimeout(retry); socket?.close(); };
  }, [base, eventsReady, loadTree, projectId]);

  const selected = tree?.entries.find((entry) => entry.id === selectedId) ?? null;
  const activeFile = tree?.entries.find((entry) => entry.id === activeId && entry.kind === "file") ?? null;
  const folders = useMemo(() => tree?.entries.filter((entry) => entry.kind === "folder").sort((a, b) => a.name.localeCompare(b.name)) ?? [], [tree]);
  const rows = useMemo(() => flatten(tree?.entries ?? [], collapsed, query), [tree, collapsed, query]);
  const canEdit = project?.role === "owner" || project?.role === "editor";

  function openEntry(entry: Entry) {
    if (runBusy) return;
    setSelectedId(entry.id);
    if (entry.kind === "folder") { setCollapsed((previous) => { const next = new Set(previous); if (next.has(entry.id)) next.delete(entry.id); else next.add(entry.id); return next; }); return; }
    setTabs((current) => current.includes(entry.id) ? current : [...current, entry.id]);
    setActiveId(entry.id);
    if (window.innerWidth <= 720) setSidebarOpen(false);
    setCursor({ line: 1, column: 1 });
  }

  function closeTab(id: string) {
    if (runBusy) return;
    setTabs((current) => {
      const next = current.filter((item) => item !== id);
      if (activeId === id) setActiveId(next.at(-1) ?? "");
      return next;
    });
  }

  function beginAction(next: Action) {
    setAction(next); setName(next === "rename" ? selected?.name ?? "" : "");
    setParent(next === "move" ? selected?.parent_id ?? "" : selected?.kind === "folder" ? selected.id : selected?.parent_id ?? "");
    setError("");
  }

  async function sendTree(method: "POST" | "PATCH" | "DELETE", path: string, body?: object) {
    if (!session || !tree) return;
    setBusy(true); setError("");
    try {
      const response = await fetch(path, { method, headers: { "If-Match": tree.tree_version, "X-CSRF-Token": session.csrf_token, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
      if (response.status === 409) { await loadTree(); throw new Error("The file tree changed. Review the latest version and try again."); }
      if (!response.ok) {
        const detail = await response.json().catch(() => null) as { message?: string } | null;
        throw new Error(detail?.message ?? "The file action failed.");
      }
      const result = method === "DELETE" ? null : await response.json() as { entry: Entry };
      await loadTree();
      if (result && result.entry.kind === "file" && method === "POST") openEntry(result.entry);
      if (method === "DELETE" && selected) { setSelectedId(""); if (selected.id === activeId) setActiveId(""); }
      setAction(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The file action failed."); }
    finally { setBusy(false); }
  }

  async function submitAction(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!action) return;
    if (action === "file" || action === "folder") await sendTree("POST", `${base}/tree`, { kind: action, name, parent_id: parent || null });
    if (action === "rename" && selected) await sendTree("PATCH", `${base}/tree/${selected.id}`, { name });
    if (action === "move" && selected) await sendTree("PATCH", `${base}/tree/${selected.id}`, { parent_id: parent || null });
  }

  async function deleteSelected() {
    if (!selected || !window.confirm(`Delete ${selected.name}${selected.kind === "folder" ? " and everything inside it" : ""}? This removes it from the active tree.`)) return;
    await sendTree("DELETE", `${base}/tree/${selected.id}`);
  }

  if (loading) return <main className="workspace-gate"><p role="status">Loading workspace…</p></main>;
  if (!project || !tree) return <main className="workspace-gate"><Link href="/">← Projects</Link><h1>Workspace unavailable</h1><p role="alert">{error || "Could not load this project."}</p>{session && <DraftRecovery userID={session.user.id} projectID={projectId} />}</main>;

  return <main className="workspace">
    <header className="workspace-topbar">
      <div className="titlebar-left"><Link href="/" className="workspace-logo" aria-label="Back to projects"><Icon name="code" size={21} /></Link><Link href="/" className="titlebar-projects">Projects</Link><span className="titlebar-divider" /><span className="titlebar-label">Collaborative Code Editor</span></div>
      <button type="button" className="command-center" title="Find files · Ctrl+P" onClick={() => { setSidebarOpen(true); setSearchOpen(false); requestAnimationFrame(() => document.getElementById("file-search")?.focus()); }}><Icon name="search" size={14} /><span>{project.name}</span><kbd>Ctrl P</kbd></button>
      <nav aria-label="Project actions" className="titlebar-actions"><Link href={`/projects/${projectId}`} title="Team and sharing"><Icon name="people" /><span>Team</span></Link><button type="button" title="Checkpoints" aria-label="Checkpoints" aria-expanded={checkpointsOpen} onClick={() => setCheckpointsOpen(open => !open)}><Icon name="history" /></button>{workspaceEnabled && <button type="button" aria-label="Development workspace" title="Environment settings" className={panelOpen && panelMode === "development" ? "active" : ""} onClick={() => openPanel("development")}><Icon name="settings" /><span>Environment</span></button>}<button type="button" aria-label="Run" title="Run an immutable captured version" disabled={!canEdit || runBusy || !executionEnabled} onClick={() => openPanel("captured")}><Icon name="play" /><span>Run</span></button></nav>
    </header>
    <div className="workspace-body">
      <nav className="activity-bar" aria-label="Workspace views"><div><button type="button" className={sidebarOpen && !searchOpen ? "active" : ""} aria-label="Explorer" title="Explorer · Ctrl+Shift+E" aria-pressed={sidebarOpen && !searchOpen} onClick={() => { setSidebarOpen(!sidebarOpen || searchOpen); setSearchOpen(false); }}><Icon name="files" size={24} /></button><button type="button" className={sidebarOpen && searchOpen ? "active" : ""} aria-label="Search project" title="Search · Ctrl+Shift+F" aria-pressed={sidebarOpen && searchOpen} onClick={() => { setSidebarOpen(!sidebarOpen || !searchOpen); setSearchOpen(true); }}><Icon name="search" size={24} /></button><button type="button" className={checkpointsOpen ? "active" : ""} aria-label="Checkpoint history" title="Checkpoint history" onClick={() => setCheckpointsOpen(open => !open)}><Icon name="history" size={24} /></button>{workspaceEnabled && <button type="button" aria-label="Open terminal panel" title="Terminal · Ctrl+`" onClick={() => openPanel("development", "terminal")}><Icon name="terminal" size={23} /></button>}</div><div>{workspaceEnabled && <button type="button" aria-label="Environment settings" title="Environment settings" onClick={() => openPanel("development")}><Icon name="settings" size={23} /></button>}<Link className="activity-account" href={`/projects/${projectId}`} title={`${project.role} access`}><span>{project.role.slice(0, 1).toUpperCase()}</span></Link></div></nav>
      {sidebarOpen && <>
        <aside className="explorer" aria-label="File explorer" style={{ width: sidebarWidth }}>
          <div className="explorer-heading"><h2>{searchOpen ? "Search" : "Explorer"}</h2>{!searchOpen && canEdit && <div className="sidebar-heading-actions"><button className="icon-button" type="button" aria-label="New file" title="New file" disabled={busy || runBusy} onClick={() => beginAction("file")}><Icon name="file" /></button><button className="icon-button" type="button" aria-label="New folder" title="New folder" disabled={busy || runBusy} onClick={() => beginAction("folder")}><Icon name="folder" /></button></div>}</div>
          {searchOpen ? <div className="sidebar-scroll"><ProjectSearch base={base} treeVersion={tree.tree_version} onOpen={id => { const entry = tree.entries.find(item => item.id === id); if (entry) openEntry(entry); }} /></div> : <>
            {canEdit && session && <ImportFiles base={base} csrf={session.csrf_token} version={tree.tree_version} folders={folders} disabled={busy || runBusy} onImported={loadTree} />}
            <div className="file-filter"><Icon name="search" size={13} /><label className="sr-only" htmlFor="file-search">Find files</label><input id="file-search" type="search" placeholder="Filter files…" value={query} onChange={event => setQuery(event.target.value)} /></div>
            <div className="explorer-project-heading"><Icon name="down" size={13} /><strong>{project.name}</strong><span>{tree.entries.length}</span></div>
            <nav aria-label="Project files" className="tree-list">{rows.length ? rows.map(({ entry, depth }) => <button key={entry.id} type="button" className={`tree-row${selectedId === entry.id ? " selected" : ""}`} style={{ paddingLeft: `${8 + depth * 14}px` }} onClick={() => openEntry(entry)} aria-label={`${entry.kind === "folder" ? "Folder" : "File"}: ${entry.name}`} title={entry.name}><span className="tree-chevron">{entry.kind === "folder" && <Icon name={collapsed.has(entry.id) ? "right" : "down"} size={13} />}</span><span className="file-symbol" data-language={entry.language}>{entry.kind === "folder" ? <Icon name="folder" size={16} /> : entry.language === "python" ? "Py" : entry.language === "typescript" ? "TS" : entry.language === "javascript" ? "JS" : entry.language === "go" ? "Go" : entry.language === "java" ? "J" : entry.language === "cpp" ? "C+" : <Icon name="file" size={15} />}</span><span className="tree-name">{entry.name}</span></button>) : <div className="explorer-empty"><p>{query ? "No matching files." : "Your project is empty."}</p>{!query && canEdit && <button type="button" onClick={() => beginAction("file")}><Icon name="plus" size={13} />Create a file</button>}</div>}</nav>
            {canEdit && selected && <div className="selection-actions"><span title={selected.name}>{selected.name}</span><button type="button" className="icon-button" aria-label="Rename" title="Rename" disabled={busy || runBusy} onClick={() => beginAction("rename")}><Icon name="edit" size={14} /></button><button type="button" className="icon-button" aria-label="Move" title="Move" disabled={busy || runBusy} onClick={() => beginAction("move")}><Icon name="move" size={14} /></button><button type="button" className="icon-button" aria-label="Delete" title="Delete" disabled={busy || runBusy} onClick={deleteSelected}><Icon name="trash" size={14} /></button></div>}
          </>}
          {session && <details className="sidebar-recovery"><summary><Icon name="history" size={13} />Local drafts</summary><DraftRecovery userID={session.user.id} projectID={projectId} /></details>}
        </aside>
        <hr className="sidebar-resizer" aria-label="Resize sidebar" aria-orientation="vertical" aria-valuemin={200} aria-valuemax={440} aria-valuenow={sidebarWidth} tabIndex={0} onKeyDown={event => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); setSidebarWidth(width => Math.max(200, Math.min(440, width + (event.key === "ArrowRight" ? 20 : -20)))); } }} onPointerDown={event => { sidebarDrag.current = { x: event.clientX, width: sidebarWidth }; event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={event => { if (sidebarDrag.current) setSidebarWidth(Math.max(200, Math.min(440, sidebarDrag.current.width + event.clientX - sidebarDrag.current.x))); }} onPointerUp={() => { sidebarDrag.current = null; }} onPointerCancel={() => { sidebarDrag.current = null; }} />
      </>}
      <section className="editor-area" aria-label="Code preview" ref={editorArea}>
        <div className="editor-surface">
          <div className="tab-strip" role="tablist" aria-label="Open files">{tabs.length ? tabs.map(id => { const item = tree.entries.find(entry => entry.id === id); return item && <div key={id} className={`tab-item${activeId === id ? " active" : ""}`}><button type="button" role="tab" aria-selected={activeId === id} disabled={runBusy} onClick={() => setActiveId(id)}><span className="file-symbol" data-language={item.language}><Icon name="file" size={14} /></span>{item.name}</button><button type="button" aria-label={`Close ${item.name}`} onClick={() => closeTab(id)}><Icon name="close" size={13} /></button></div>; }) : <span className="welcome-tab">Welcome</span>}<div className="editor-layout-tools"><button type="button" className="icon-button" aria-label="Toggle sidebar" title="Toggle sidebar · Ctrl+B" onClick={() => setSidebarOpen(open => !open)}><Icon name="layout" size={15} /></button><button type="button" className="icon-button" aria-label="Toggle bottom panel" title="Toggle panel · Ctrl+J" onClick={() => setPanelOpen(open => !open)}><Icon name="terminal" size={15} /></button></div></div>
          {activeFile && session ? <><div className="editor-breadcrumb"><span>{project.name}</span><Icon name="right" size={12} /><span>{activeFile.name}</span><span className="breadcrumb-state">{activeFile.storage_kind === "asset" ? "Original file" : connection}</span></div>{activeFile.storage_kind === "asset" ? <AssetPreview key={`${activeFile.id}:${activeFile.generation}`} projectID={projectId} file={activeFile} /> : <MonacoPreview userId={session.user.id} projectId={projectId} file={activeFile} canEdit={Boolean(canEdit) && !runBusy} onState={setConnection} onCursor={(line, column) => setCursor({ line, column })} />}</> : <div className="editor-empty"><div className="empty-glyph"><Icon name="code" size={110} /></div><h2>Choose a file</h2><p>Open a file from Explorer to start collaborating.</p><div className="welcome-shortcuts"><button type="button" onClick={() => { setSidebarOpen(true); setSearchOpen(false); }}><span>Browse project files</span><kbd>Ctrl Shift E</kbd></button><button type="button" onClick={() => { setSidebarOpen(true); setSearchOpen(true); }}><span>Search in project</span><kbd>Ctrl Shift F</kbd></button>{workspaceEnabled && <button type="button" onClick={() => openPanel("development", "terminal")}><span>Open terminal</span><kbd>Ctrl `</kbd></button>}<button type="button" onClick={() => setPanelOpen(open => !open)}><span>Toggle bottom panel</span><kbd>Ctrl J</kbd></button></div></div>}
        </div>
        <div className="ide-bottom-panel" hidden={!panelOpen} style={{ height: panelHeight }}>
          <hr className="panel-resizer" aria-label="Resize bottom panel" aria-orientation="horizontal" aria-valuemin={140} aria-valuemax={Math.max(140, (editorArea.current?.clientHeight ?? 700) - 120)} aria-valuenow={panelHeight} tabIndex={0} onKeyDown={event => { if (event.key === "ArrowUp" || event.key === "ArrowDown") { event.preventDefault(); setPanelHeight(height => clampPanel(height + (event.key === "ArrowUp" ? 20 : -20))); } }} onPointerDown={event => { panelDrag.current = { y: event.clientY, height: panelHeight }; event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={event => { if (panelDrag.current) setPanelHeight(clampPanel(panelDrag.current.height + panelDrag.current.y - event.clientY)); }} onPointerUp={() => { panelDrag.current = null; }} onPointerCancel={() => { panelDrag.current = null; }} />
          <div className="ide-panel-header"><div className="panel-mode-tabs">{workspaceEnabled && <button type="button" className={panelMode === "development" ? "active" : ""} disabled={runBusy} onClick={() => openPanel("development")}><Icon name="terminal" size={14} />Workspace tools</button>}{executionEnabled && <button type="button" className={panelMode === "captured" ? "active" : ""} disabled={runBusy} onClick={() => openPanel("captured")}><Icon name="play" size={14} />Captured run</button>}</div><div><button type="button" className="icon-button" aria-label="Expand bottom panel" title="Expand panel" onClick={() => setPanelHeight(height => height > 350 ? 310 : clampPanel(600))}><Icon name="expand" size={13} /></button><button type="button" className="icon-button" aria-label="Close bottom panel" title="Hide panel · Ctrl+J" onClick={() => setPanelOpen(false)}><Icon name="close" size={15} /></button></div></div>
          {workspaceEnabled && session && <div className="panel-body" hidden={panelMode !== "development"}><DevelopmentWorkspace projectID={projectId} userID={session.user.id} csrf={session.csrf_token} role={project.role} onBusy={setRunBusy} requestedTab={developmentTab} requestID={developmentRequest} visible={panelOpen && panelMode === "development"} /></div>}
          {session && executionEnabled && <div className="panel-body" hidden={panelMode !== "captured"}><Runs projectID={projectId} userID={session.user.id} csrf={session.csrf_token} canEdit={Boolean(canEdit)} files={tree.entries} open={runsOpen} onBusy={setRunBusy} onStart={() => setRunsOpen(false)} onWorkspace={workspaceEnabled ? () => openPanel("development") : undefined} /></div>}
          {!workspaceEnabled && !executionEnabled && <div className="panel-empty"><h3>Execution unavailable</h3><p>Development environments are not enabled for this server.</p></div>}
        </div>
      </section>
      {checkpointsOpen && session && <Checkpoints projectId={projectId} role={project.role} csrf={session.csrf_token} treeVersion={tree.tree_version} onRestore={loadTree} onClose={() => setCheckpointsOpen(false)} />}
    </div>
    {action && <div className="ide-modal-backdrop"><div className="ide-dialog" role="dialog" aria-modal="true" aria-label="File tree action"><form className="tree-form" aria-label="File tree action" onSubmit={submitAction}><div className="dialog-heading"><h3>{action === "file" ? "New file" : action === "folder" ? "New folder" : action === "rename" ? "Rename entry" : "Move entry"}</h3><button type="button" className="icon-button" aria-label="Close file action" onClick={() => setAction(null)} disabled={busy}><Icon name="close" /></button></div>{action !== "move" && <><label htmlFor="entry-name">Name</label><input id="entry-name" value={name} onChange={event => setName(event.target.value)} required maxLength={255} placeholder={action === "file" ? "e.g. main.py" : "Folder name"} /></>}{action !== "rename" && <><label htmlFor="entry-parent">Parent folder</label><select id="entry-parent" value={parent} onChange={event => setParent(event.target.value)}><option value="">Project root</option>{folders.map(folder => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</select></>}<div className="dialog-actions"><button type="button" onClick={() => setAction(null)} disabled={busy}>Cancel</button><button className="primary" type="submit" disabled={busy}>{busy ? "Saving…" : "Save"}</button></div></form></div></div>}
    {error && <div role="alert" className="workspace-error">{error}<button type="button" onClick={() => setError("")} aria-label="Dismiss error"><Icon name="close" size={14} /></button></div>}
    <footer className="workspace-status"><div><span className="status-remote"><Icon name="code" size={13} /></span><span>{project.role} access</span><span><span className={`state-dot ${connection === "Saved" || !activeFile ? "online" : ""}`} />{activeFile?.storage_kind === "asset" ? "Original file" : activeFile ? connection : "File tree ready"}</span></div><div>{activeFile && <span>Ln {cursor.line}, Col {cursor.column}</span>}<span>{activeFile?.language ?? "Plain text"}</span><span>UTF-8</span><button type="button" title="Saved confirms server receipts. Local drafts are retained after browser storage succeeds." onClick={() => { setSidebarOpen(true); setSearchOpen(false); }}><Icon name="check" size={12} />Autosave</button></div></footer>
  </main>;
}
