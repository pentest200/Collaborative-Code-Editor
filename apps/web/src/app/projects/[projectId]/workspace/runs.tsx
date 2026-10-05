"use client";

import { useEffect, useRef, useState } from "react";
import { flushProject } from "@/collaboration/run-input";
type File = { id: string; name: string; parent_id: string | null; kind: string };
type Run = { id: string; checkpoint_id: string; runtime: string; entrypoint: string; state: string; event_sequence: string; exit_code: number | null; failure_code: string | null; truncated: boolean };
const terminal = (state: string) => ["succeeded", "failed", "timed_out", "cancelled"].includes(state);
export default function Runs({ projectID, userID, csrf, canEdit, files, open, onBusy, onStart }: { projectID: string; userID: string; csrf: string; canEdit: boolean; files: File[]; open: boolean; onBusy: (busy: boolean) => void; onStart: () => void }) {
  const [runtime, setRuntime] = useState("python"); const [entrypoint, setEntrypoint] = useState(""); const [stdin, setStdin] = useState("");
  const [run, setRun] = useState<Run | null>(null); const [output, setOutput] = useState(""); const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const request = useRef<{ key: string; body: string } | null>(null);
  const base = `/api/v1/projects/${projectID}/runs`;
  const runID = run?.id;
  const paths = files.filter((file) => file.kind === "file").map((file) => { const parts = [file.name]; let parent = file.parent_id; while (parent) { const folder = files.find((item) => item.id === parent); if (!folder) break; parts.unshift(folder.name); parent = folder.parent_id; } return parts.join("/"); });
  useEffect(() => {
    if (!runID) return;
    // Each selected job owns its cursor. Late callbacks from an earlier stream
    // must never consume events or close the replacement stream.
    let stopped = false; let after = "0"; let stream: EventSource | null = null;
    const connect = () => {
      const source = new EventSource(`${base}/${runID}/events?after=${after}`);
      stream = source;
      source.onmessage = (event) => {
        if (stopped || source !== stream || BigInt(event.lastEventId) <= BigInt(after)) return;
        const data = JSON.parse(event.data) as { kind: string; text: string };
        if (data.kind === "stdout" || data.kind === "stderr") setOutput((current) => (current + data.text).slice(0, 200000));
        after = event.lastEventId;
      };
      source.onerror = () => { source.close(); };
    };
    connect();
    const timer = setInterval(async () => {
      try {
        const response = await fetch(`${base}/${runID}`, { cache: "no-store" });
        if (!response.ok) throw new Error("Run access changed or status is unavailable.");
        const next = await response.json() as Run;
        if (stopped) return; setRun(next);
        if (terminal(next.state) && BigInt(after) >= BigInt(next.event_sequence)) { clearInterval(timer); stream?.close(); }
        else if (stream?.readyState === EventSource.CLOSED) connect();
      } catch (cause) { if (!stopped) { setError(cause instanceof Error ? cause.message : "Run unavailable"); stream?.close(); clearInterval(timer); } }
    }, 1000);
    return () => { stopped = true; clearInterval(timer); stream?.close(); };
  }, [base, runID]);
  async function start(event: React.FormEvent) {
    event.preventDefault(); if (!entrypoint) return; setBusy(true); onBusy(true); setError("");
    try {
      if (new TextEncoder().encode(stdin).length > 16384) throw new Error("Stdin must be at most 16 KiB.");
      await flushProject(userID, projectID);
      const body = JSON.stringify({ runtime, entrypoint, stdin });
      if (request.current?.body !== body) request.current = { key: crypto.randomUUID(), body };
      const response = await fetch(base, { method: "POST", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf, "Idempotency-Key": request.current.key }, body });
      const result = await response.json() as Run & { message?: string };
      if (!response.ok) throw new Error(result.message ?? "Run could not be created.");
      setOutput(""); setRun(result); request.current = null; onStart();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Run failed"); }
    finally { setBusy(false); onBusy(false); }
  }
  async function cancel() { if (!run) return; const response = await fetch(`${base}/${run.id}`, { method: "DELETE", headers: { "X-CSRF-Token": csrf } }); if (!response.ok) setError("Cancellation could not be requested. Refresh the run status."); }
  return <section className="output-panel run-output" aria-label="Output panel"><div className="output-heading"><strong>Output</strong><span>{busy ? "Waiting for edit receipts" : run?.state ?? "No run selected"}</span></div>
    {open && canEdit && <form onSubmit={start} aria-label="Run captured source">
      <div className="run-control"><label htmlFor="run-runtime">Runtime</label><select id="run-runtime" value={runtime} onChange={(event) => setRuntime(event.target.value)} disabled={busy}><option value="python">Python</option><option value="javascript">JavaScript</option></select></div>
      <div className="run-control"><label htmlFor="run-entrypoint">Entrypoint</label><select id="run-entrypoint" value={entrypoint} onChange={(event) => setEntrypoint(event.target.value)} required disabled={busy}><option value="">Choose a file</option>{paths.map((path) => <option key={path} value={path}>{path}</option>)}</select></div>
      <div className="run-control"><label htmlFor="run-stdin">Stdin</label><textarea id="run-stdin" value={stdin} onChange={(event) => setStdin(event.target.value)} maxLength={16384} disabled={busy} /></div>
      <button type="submit" disabled={busy || Boolean(run && !terminal(run.state))}>Run captured source</button></form>}
    {run && <><p>Input checkpoint <code>{run.checkpoint_id}</code> · {run.runtime} · {run.entrypoint} · {run.exit_code === null ? run.state : `Exit ${run.exit_code}`} {run.failure_code && `· ${run.failure_code}`}</p>{canEdit && !terminal(run.state) && <button type="button" onClick={() => void cancel()}>Cancel run</button>}{run.truncated && <p role="status">Output truncated at 64 KiB; execution stopped.</p>}<section aria-label="Run output"><pre>{output}</pre></section></>}
    <p>Restricted private demo · 5 seconds · 128 MiB · no network. Run waits for your edits to save, then captures committed source. Recoverable drafts from replaced versions stay separate.</p>{error && <p role="alert">{error}</p>}
  </section>;
}
