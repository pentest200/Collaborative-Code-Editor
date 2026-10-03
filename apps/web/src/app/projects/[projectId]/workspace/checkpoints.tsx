"use client";

import { useCallback, useEffect, useState } from "react";

type Checkpoint = { id: string; name: string; state: "captured" | "materializing" | "ready" | "failed"; created_at: string; failure_code: string | null };
type Manifest = { captured_tree_version: string; files: { file_id: string; path: string; through_sequence: string; checksum: string; text_bytes: number }[] };

export default function Checkpoints({ projectId, role, csrf, treeVersion, onRestore, onClose }: {
  projectId: string; role: "owner" | "editor" | "viewer"; csrf: string; treeVersion: string;
  onRestore: () => Promise<unknown>; onClose: () => void;
}) {
  const base = `/api/v1/projects/${projectId}/checkpoints`;
  const [list, setList] = useState<Checkpoint[]>([]);
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<Checkpoint | null>(null);
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const load = useCallback(async () => {
    const response = await fetch(base, { cache: "no-store" });
    if (!response.ok) throw new Error("Checkpoint access or storage is unavailable.");
    const body = await response.json() as { checkpoints: Checkpoint[] };
    setList(body.checkpoints);
  }, [base]);
  useEffect(() => {
    let alive = true;
    const refresh = () => { void load().catch((cause: Error) => { if (alive) setError(cause.message); }); };
    refresh(); const timer = setInterval(refresh, 2000);
    return () => { alive = false; clearInterval(timer); };
  }, [load]);

  async function mutate(path: string, body?: object, restoring = false) {
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch(path, { method: "POST", headers: { "X-CSRF-Token": csrf, ...(body ? { "Content-Type": "application/json" } : {}), ...(restoring ? { "If-Match": treeVersion } : {}) }, body: body ? JSON.stringify(body) : undefined });
      if (!response.ok) {
        if (response.status === 409 && restoring) await onRestore();
        const detail = await response.json().catch(() => null) as { message?: string } | null;
        throw new Error(detail?.message ?? "Checkpoint action failed.");
      }
      if (restoring) {
        const result = await response.json() as { previous_checkpoint_name: string };
        await onRestore();
        setNotice(`Restored. The previous committed state is retained as “${result.previous_checkpoint_name}”. Preview becomes available when materialization succeeds. Old local drafts remain separate in Recover drafts.`);
      } else { setName(""); setNotice("Checkpoint captured. Preview becomes available after materialization succeeds."); }
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Checkpoint action failed."); }
    finally { setBusy(false); }
  }
  async function preview(cp: Checkpoint) {
    setBusy(true); setError(""); setText(""); setManifest(null); setSelected(cp);
    try {
      const response = await fetch(`${base}/${cp.id}`, { cache: "no-store" });
      if (!response.ok) throw new Error("Checkpoint is incomplete or its manifest could not be verified.");
      setManifest(await response.json() as Manifest);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Preview failed."); }
    finally { setBusy(false); }
  }
  async function showFile(fileId: string) {
    if (!selected) return;
    setBusy(true); setError(""); setText("");
    try {
      const response = await fetch(`${base}/${selected.id}/files/${fileId}`, { cache: "no-store" });
      if (!response.ok) throw new Error("Captured file could not be authorized or verified.");
      setText(await response.text());
    } catch (cause) { setError(cause instanceof Error ? cause.message : "File preview failed."); }
    finally { setBusy(false); }
  }
  return <aside className="checkpoint-panel" aria-label="Checkpoints">
    <div className="checkpoint-heading"><h2>Checkpoints</h2><button type="button" onClick={onClose} aria-label="Close checkpoints">×</button></div>
    <p>Captures committed server text. Unsaved local drafts are excluded.</p>
    {role !== "viewer" && <form onSubmit={(event) => { event.preventDefault(); void mutate(base, { name }); }}><label htmlFor="checkpoint-name">Checkpoint name</label><input id="checkpoint-name" required maxLength={120} value={name} onChange={(event) => setName(event.target.value)} /><button type="submit" disabled={busy || !name.trim()}>Capture checkpoint</button></form>}
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    <ul>{list.map((cp) => <li key={cp.id}><strong>{cp.name}</strong><span>{cp.state}</span>{cp.state === "ready" && <button type="button" disabled={busy} onClick={() => void preview(cp)} aria-label={`Preview ${cp.name}`}>Preview</button>}{cp.state === "failed" && <><p>Materialization failed. The captured cut remains retained.</p>{role !== "viewer" && <button type="button" disabled={busy} onClick={() => void mutate(`${base}/${cp.id}/retry`)}>Retry materialization</button>}</>}</li>)}</ul>
    {!list.length && <p>No checkpoints yet.</p>}
    {manifest && selected && <section aria-label="Checkpoint preview"><h3>{selected.name}</h3><p>Captured tree version {manifest.captured_tree_version}</p>{manifest.files.map((file) => <div key={file.file_id}><button type="button" disabled={busy} onClick={() => void showFile(file.file_id)} aria-label={`Preview file ${file.path}`}>{file.path}</button><span> · sequence {file.through_sequence}</span><a href={`${base}/${selected.id}/files/${file.file_id}`} download>Download</a></div>)}<section aria-label="Captured file text"><pre>{text}</pre></section>{role === "owner" && <button type="button" disabled={busy} onClick={() => { if (window.confirm(`Restore ${selected.name}? The current committed state will be preserved as another checkpoint. Local drafts from the replaced version will remain separate.`)) void mutate(`${base}/${selected.id}/restore`, undefined, true); }}>Restore checkpoint</button>}</section>}
  </aside>;
}
