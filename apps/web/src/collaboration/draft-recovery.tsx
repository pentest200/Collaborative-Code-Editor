"use client";

import { useState } from "react";
import * as Y from "yjs";
import { listDrafts, downloadDraft, type Draft } from "./drafts";

export function DraftRecovery({ userID, projectID }: { userID: string; projectID: string }) {
  const [rows, setRows] = useState<Draft[] | null>(null);
  const [error, setError] = useState("");
  const load = async () => { try { setRows(await listDrafts(userID,projectID)); setError(""); } catch { setError("Browser drafts could not be read."); } };
  return <div className="draft-recovery"><button type="button" onClick={load}>Recover drafts</button>{error && <p role="alert">{error}</p>}{rows && <div role="dialog" aria-label="Recover browser drafts"><p>Drafts belong to this account and project. Replaced or access-denied drafts are downloaded separately; they are never replayed into a different version.</p><ul>{rows.map((row) => <li key={row.key}>File {row.scope.fileID.slice(0,8)} · generation {row.scope.generation} · {row.pending.length} pending {row.frozen && `· ${row.frozen}`} <button type="button" onClick={() => { const doc = new Y.Doc(); try { doc.getText("content"); Y.applyUpdate(doc,row.state); downloadDraft(doc.getText("content").toString(),`draft-${row.scope.fileID}-generation-${row.scope.generation}.txt`); } finally { doc.destroy(); } }}>Download generation {row.scope.generation} draft</button></li>)}</ul>{!rows.length && <p>No retained drafts.</p>}<button type="button" onClick={() => setRows(null)}>Close recovery</button></div>}</div>;
}
