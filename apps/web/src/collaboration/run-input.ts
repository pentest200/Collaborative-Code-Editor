import { DocumentProvider } from "./provider";
import { listDrafts } from "./drafts";

// Flush active providers plus retained pending edits from closed files. Frozen
// generations stay separate: they cannot be silently included in a new run.
export async function flushProject(userID: string, projectID: string) {
  const active = [...DocumentProvider.active].filter((provider) => provider.scope.userID === userID && provider.scope.projectID === projectID);
  try {
    for (const provider of active) await provider.waitForReceipts();
    const rows = await listDrafts(userID, projectID);
    const inactive = rows.filter((draft) => draft.pending.length && !draft.frozen && !active.some((provider) => provider.scope.documentID === draft.scope.documentID));
    // Preserve the one active document transport per tab contract while draining
    // closed-file outboxes, then resynchronize the bound editor before capture.
    if (inactive.length) for (const provider of active) provider.pauseTransport();
    for (const row of inactive) {
      const provider = new DocumentProvider(row.scope, true, () => {});
      try { await provider.waitForReceipts(); } finally { provider.close(); }
    }
    for (const provider of active) provider.resumeTransport();
    for (const provider of active) await provider.waitForReceipts();
    const remaining = await listDrafts(userID, projectID);
    if (remaining.some((row) => row.pending.length && !row.frozen)) throw new Error("Run stopped: local edits are still pending. Try again after saving completes.");
  } finally { for (const provider of active) provider.resumeTransport(); }
}
