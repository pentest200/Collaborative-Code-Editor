"use client";

import { useEffect, useRef, useState } from "react";
import Icon from "./workbench-icon";
import { useDialogFocus } from "./dialog-focus";

type Candidate = { path: string; text?: string; data_base64?: string; size: number; selected: boolean };
function encodeBytes(bytes: Uint8Array) { let binary = ""; for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768)); return btoa(binary); }
function textType(file: File) { return !file.type || file.type.startsWith("text/") || /(?:json|javascript|xml|svg)/.test(file.type); }

export default function ImportFiles({ base, csrf, version, folders, disabled, onImported }: { base: string; csrf: string; version: string; folders: { id: string; name: string }[]; disabled: boolean; onImported: () => Promise<unknown> }) {
 const filesInput = useRef<HTMLInputElement>(null); const folderInput = useRef<HTMLInputElement>(null);
 const [candidates, setCandidates] = useState<Candidate[]>([]); const [skipped, setSkipped] = useState<string[]>([]);
 const [parent, setParent] = useState(""); const [busy, setBusy] = useState(false); const [message, setMessage] = useState("");
 useDialogFocus(candidates.length > 0, "Import from your device");
 useEffect(() => { const close = (event: KeyboardEvent) => { if (event.key === "Escape" && !busy) setCandidates([]); }; window.addEventListener("keydown", close); return () => window.removeEventListener("keydown", close); }, [busy]);
 async function select(files: FileList | null) {
  if (!files) return; setBusy(true); setMessage(""); const next: Candidate[] = []; const excluded: string[] = []; let bytes = 0;
  try {
   for (const file of Array.from(files)) {
    const path = file.webkitRelativePath || file.name;
    if (file.size > 25 * 1024 * 1024) { excluded.push(`${path}: exceeds 25 MiB`); continue; }
    const data = new Uint8Array(await file.arrayBuffer());
    let text: string | undefined;
    if (data.length <= 262144 && textType(file)) { try { const decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data); if (!decoded.includes("\0")) text = decoded; } catch { /* Preserve non-UTF-8 bytes as an asset. */ } }
    bytes += data.length;
    if (next.length >= 200 || bytes > 100 * 1024 * 1024) throw new Error("Selection exceeds 200 files or 100 MiB. Choose a smaller folder.");
    const secret = /^\.env(?:\.|$)/.test(file.name) && !/\.(example|sample|template)$/.test(file.name) || /\.(pem|key|p12|pfx)$/.test(file.name);
    next.push({ path, ...(text === undefined ? { data_base64: encodeBytes(data) } : { text }), size: data.length, selected: !secret });
   }
   setCandidates(next); setSkipped(excluded); if (!next.length) setMessage(excluded.length ? "Selected files exceed the 25 MiB per-file limit." : "No files selected.");
  } catch (error) { setCandidates([]); setMessage(error instanceof Error ? error.message : "Could not read files."); }
  finally { setBusy(false); if (filesInput.current) filesInput.current.value = ""; if (folderInput.current) folderInput.current.value = ""; }
 }
 async function submit() {
  setBusy(true); setMessage("");
  try {
   const response = await fetch(`${base}/import`, { method: "POST", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf, "If-Match": version }, body: JSON.stringify({ parent_id: parent || null, files: candidates.filter(file => file.selected).map(({ path, text, data_base64 }) => ({ path, ...(text === undefined ? { data_base64 } : { text }) })) }) });
   const result = await response.json();
   if (!response.ok) { if (response.status === 409) await onImported(); throw new Error(result.message ?? "Import failed."); }
   const count = candidates.filter(file => file.selected).length; setCandidates([]); await onImported(); setMessage(`Imported ${count} files.`);
  } catch (error) { setMessage(error instanceof Error ? error.message : "Import failed. Refresh the tree before retrying."); }
  finally { setBusy(false); }
 }
 return <section className="import-panel" aria-label="Import codebase">
  <div className="import-toolbar"><span>Import</span><button type="button" aria-label="Import files" title="Import files from your device" disabled={disabled || busy} onClick={() => filesInput.current?.click()}><Icon name="upload" size={13} />Files</button><button type="button" aria-label="Import folder" title="Import folder from your device" disabled={disabled || busy} onClick={() => folderInput.current?.click()}><Icon name="folder" size={13} />Folder</button></div>
  <input ref={filesInput} aria-label="Select local files" type="file" multiple hidden onChange={event => void select(event.target.files)} />
  <input ref={folderInput} aria-label="Select local folder" type="file" multiple hidden {...{ webkitdirectory: "" }} onChange={event => void select(event.target.files)} />
  {candidates.length > 0 && <div className="ide-modal-backdrop"><div className="ide-dialog import-dialog" role="dialog" aria-modal="true" aria-label="Import from your device"><div className="dialog-heading"><div><h3>Import from your device</h3><p>{candidates.filter(file => file.selected).length} of {candidates.length} files selected</p></div><button className="icon-button" type="button" aria-label="Close import preview" disabled={busy} onClick={() => setCandidates([])}><Icon name="close" /></button></div><label htmlFor="import-parent">Destination</label><select id="import-parent" value={parent} onChange={event => setParent(event.target.value)} disabled={busy}><option value="">Project root</option>{folders.map(folder => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</select>
   <p className="context-hint">All file types are supported, including images, documents, archives and binaries. Folder structure is preserved. Likely secret files are unchecked.</p>
   <div className="import-list">{candidates.map((file, index) => <label key={file.path}><input type="checkbox" aria-label={file.path} checked={file.selected} disabled={busy} onChange={event => setCandidates(current => current.map((item, i) => i === index ? { ...item, selected: event.target.checked } : item))} /><span>{file.path}</span><small className="import-file-type">{file.text === undefined ? "File" : "Editable text"} · {file.size < 1024 ? `${file.size} B` : `${Math.ceil(file.size / 1024)} KiB`}</small></label>)}</div>
   {skipped.length > 0 && <details className="import-skipped"><summary>{skipped.length} skipped files</summary><ul>{skipped.slice(0, 100).map(path => <li key={path}>{path}</li>)}</ul></details>}
   <small className="import-limits">Any file type · 25 MiB/file · 100 MiB/import · 200 project entries. Small UTF-8 files are collaboratively editable.</small>
   <div className="dialog-actions"><button type="button" disabled={busy} onClick={() => setCandidates([])}>Cancel</button><button className="primary" type="button" disabled={busy || disabled || !candidates.some(file => file.selected)} onClick={() => void submit()}>{busy ? "Importing…" : "Import selected files"}</button></div>
   {message && <p role="status" className="import-message">{message}</p>}
  </div></div>}
  {message && candidates.length === 0 && <p role="status" className="import-message">{message}</p>}
 </section>;
}
