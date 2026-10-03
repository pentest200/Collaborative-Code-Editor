"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import MonacoPreview from "./monaco-preview";
import Checkpoints from "./checkpoints";
import type { ConnectionState } from "@/collaboration/provider";
import { DraftRecovery } from "@/collaboration/draft-recovery";

type Project = { id: string; name: string; role: "owner" | "editor" | "viewer" };
type Session = { user: { id: string }; csrf_token: string };
type Entry = { id: string; parent_id: string | null; name: string; kind: "file" | "folder"; language: string | null; document_id: string | null; generation: string };
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
  const [action, setAction] = useState<Action>(null);
  const [name, setName] = useState("");
  const [parent, setParent] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [cursor, setCursor] = useState({ line: 1, column: 1 });
  const [connection, setConnection] = useState<ConnectionState>("Connecting");
  const [checkpointsOpen, setCheckpointsOpen] = useState(false);
  const eventSequence = useRef("0");

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
        const [sessionResponse, projectResponse] = await Promise.all([fetch("/api/v1/session", { cache: "no-store" }), fetch(base, { cache: "no-store" })]);
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
    setSelectedId(entry.id);
    if (entry.kind === "folder") { setCollapsed((previous) => { const next = new Set(previous); if (next.has(entry.id)) next.delete(entry.id); else next.add(entry.id); return next; }); return; }
    setTabs((current) => current.includes(entry.id) ? current : [...current, entry.id]);
    setActiveId(entry.id);
    setCursor({ line: 1, column: 1 });
  }

  function closeTab(id: string) {
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
    <header className="workspace-topbar"><div className="workspace-title"><Link href="/" aria-label="Back to projects">←</Link><span className="workspace-logo">CCE</span><strong>{project.name}</strong><span className="workspace-state">{activeFile ? connection : "File tree ready"}</span></div><nav aria-label="Project actions"><Link href={`/projects/${projectId}`}>Team</Link>{project.role === "owner" && <Link href={`/projects/${projectId}`}>Share</Link>}<button type="button" onClick={() => setCheckpointsOpen((open) => !open)} aria-expanded={checkpointsOpen}>Checkpoints</button><button type="button" disabled title="Code execution is not available yet">Run</button></nav></header>
    <div className="workspace-body">
      <aside className="explorer" aria-label="File explorer"><div className="explorer-heading"><h2>Explorer</h2><span>{tree.entries.length} entries</span></div><label className="sr-only" htmlFor="file-search">Find files</label><input id="file-search" type="search" placeholder="Find files" value={query} onChange={(event) => setQuery(event.target.value)} />
        {session && <DraftRecovery userID={session.user.id} projectID={projectId} />}
        {canEdit && <div className="explorer-actions"><button type="button" onClick={() => beginAction("file")}>New file</button><button type="button" onClick={() => beginAction("folder")}>New folder</button></div>}
        {canEdit && selected && <div className="explorer-actions"><button type="button" onClick={() => beginAction("rename")}>Rename</button><button type="button" onClick={() => beginAction("move")}>Move</button><button type="button" onClick={deleteSelected}>Delete</button></div>}
        {action && <form className="tree-form" aria-label="File tree action" onSubmit={submitAction}><h3>{action === "file" ? "New file" : action === "folder" ? "New folder" : action === "rename" ? "Rename entry" : "Move entry"}</h3>{action !== "move" && <><label htmlFor="entry-name">Name</label><input id="entry-name" value={name} onChange={(event) => setName(event.target.value)} required maxLength={255} /></>}{action !== "rename" && <><label htmlFor="entry-parent">Parent folder</label><select id="entry-parent" value={parent} onChange={(event) => setParent(event.target.value)}><option value="">Project root</option>{folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</select></>}<div><button type="submit" disabled={busy}>Save</button><button type="button" onClick={() => setAction(null)} disabled={busy}>Cancel</button></div></form>}
        <nav aria-label="Project files" className="tree-list">{rows.length ? rows.map(({ entry, depth }) => <button key={entry.id} type="button" className={`tree-row${selectedId === entry.id ? " selected" : ""}`} style={{ paddingLeft: `${12 + depth * 17}px` }} onClick={() => openEntry(entry)} aria-label={`${entry.kind === "folder" ? "Folder" : "File"}: ${entry.name}`}><span aria-hidden="true">{entry.kind === "folder" ? collapsed.has(entry.id) ? "▸" : "▾" : "·"}</span><span>{entry.name}</span></button>) : <p className="explorer-empty">{query ? "No matching files." : "No files yet. Create a file or folder to begin."}</p>}</nav>
      </aside>
      <section className="editor-area" aria-label="Code preview"><div className="tab-strip" role="tablist" aria-label="Open files">{tabs.map((id) => { const item = tree.entries.find((entry) => entry.id === id); return item && <div key={id} className={`tab-item${activeId === id ? " active" : ""}`}><button type="button" role="tab" aria-selected={activeId === id} onClick={() => setActiveId(id)}>{item.name}</button><button type="button" aria-label={`Close ${item.name}`} onClick={() => closeTab(id)}>×</button></div>; })}</div>
        {activeFile && session ? <><div className="editor-breadcrumb">{activeFile.name}<span>{connection}</span></div><MonacoPreview userId={session.user.id} projectId={projectId} file={activeFile} canEdit={Boolean(canEdit)} onState={setConnection} onCursor={(line, column) => setCursor({ line, column })} /><div className="editor-notice">Saved confirms server receipts. Offline draft retention completes after browser storage succeeds; download your draft if storage fails.</div></> : <div className="editor-empty"><div className="empty-glyph">{`{ }`}</div><h2>Choose a file</h2><p>Browse the project tree, or create a file to open its code preview.</p></div>}
        <section className="output-panel" aria-label="Output panel"><div className="output-heading"><strong>Output</strong><span>Unavailable</span></div><p>Code execution and output will appear here when runs are available.</p></section>
      </section>
      {checkpointsOpen && session && <Checkpoints projectId={projectId} role={project.role} csrf={session.csrf_token} treeVersion={tree.tree_version} onRestore={loadTree} onClose={() => setCheckpointsOpen(false)} />}
    </div>
    {error && <div role="alert" className="workspace-error">{error}<button type="button" onClick={() => setError("")} aria-label="Dismiss error">×</button></div>}
    <footer className="workspace-status"><span>{project.role} access</span><span>{activeFile?.language ?? "No file"}</span><span>{activeFile ? `Ln ${cursor.line}, Col ${cursor.column}` : ""}</span><span>{activeFile ? connection : `Tree version ${tree.tree_version}`}</span></footer>
  </main>;
}
