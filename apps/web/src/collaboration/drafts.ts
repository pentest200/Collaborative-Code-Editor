import * as Y from "yjs";

export type DraftScope = { userID: string; projectID: string; fileID: string; documentID: string; generation: string };
export type OutboxItem = { instance: string; message: string; hash: Uint8Array; update: Uint8Array };
export type Draft = { key: string; scope: DraftScope; state: Uint8Array; pending: OutboxItem[]; frozen?: string };
export const draftKey = (scope: DraftScope) => [scope.userID, scope.projectID, scope.fileID, scope.documentID, scope.generation].join("/");
export const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((byte, index) => byte === b[index]);
const databaseName = "cce-drafts-v1";

// Atomic read/modify/write prevents tabs replacing state or clearing unrelated receipts.
export class DraftStore {
  private database: IDBDatabase | null = null;
  private opening: Promise<IDBDatabase> | null = null;
  constructor(readonly scope: DraftScope) {}
  private open(): Promise<IDBDatabase> {
    if (this.database) return Promise.resolve(this.database);
    if (!this.opening) this.opening = new Promise((resolve, reject) => {
      const request = indexedDB.open(databaseName, 1);
      request.onupgradeneeded = () => request.result.createObjectStore("drafts", { keyPath: "key" });
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("Draft database is blocked"));
      request.onsuccess = () => { this.database = request.result; this.database.onversionchange = () => this.close(); resolve(request.result); };
    });
    return this.opening;
  }
  async change(work: (row: Draft) => void): Promise<Draft> {
    const database = await this.open();
    return new Promise((resolve, reject) => {
      const tx = database.transaction("drafts", "readwrite", { durability: "strict" });
      const table = tx.objectStore("drafts"); const request = table.get(draftKey(this.scope));
      let row: Draft; let failure: unknown;
      request.onsuccess = () => {
        try {
          row = request.result ?? { key: draftKey(this.scope), scope: this.scope, state: new Uint8Array([0, 0]), pending: [] };
          work(row);
          if (row.state.length > 2097152 || row.pending.length > 4096 || row.pending.reduce((sum, item) => sum + item.update.length + 64, 0) > 8388608) throw new Error("Draft storage full (2 MiB state / 8 MiB outbox / 4096 items)");
          table.put(row);
        } catch (error) { failure = error; tx.abort(); }
      };
      tx.oncomplete = () => resolve(row);
      tx.onabort = tx.onerror = () => reject(failure ?? tx.error ?? new Error("Browser draft storage failed"));
    });
  }
  read() { return this.change(() => {}); }
  retain(update: Uint8Array, item?: OutboxItem) {
    return this.change((row) => {
      row.state = Y.mergeUpdates([row.state, update]);
      if (item && !row.pending.some((other) => other.instance === item.instance && other.message === item.message)) row.pending.push(item);
    });
  }
  acknowledge(instance: string, message: string, hash: Uint8Array) {
    return this.change((row) => {
      const item = row.pending.find((entry) => entry.instance === instance && entry.message === message);
      if (item && !sameBytes(item.hash, hash)) throw new Error("Receipt hash mismatch");
      row.pending = row.pending.filter((entry) => entry !== item);
    });
  }
  freeze(reason: string) { return this.change((row) => { row.frozen = reason; }); }
  close() { this.database?.close(); this.database = null; this.opening = null; }
}
export function draftChannel() { return new BroadcastChannel("cce-account-drafts-v1"); }
async function accountTransaction<T>(mode: IDBTransactionMode, work: (table: IDBObjectStore) => () => T): Promise<T> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("drafts", { keyPath: "key" });
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result; const tx = database.transaction("drafts", mode);
      const result = work(tx.objectStore("drafts"));
      tx.oncomplete = () => { database.close(); resolve(result()); };
      tx.onabort = () => { database.close(); reject(tx.error); };
    };
  });
}
export function listDrafts(userID: string, projectID: string): Promise<Draft[]> {
  return accountTransaction("readonly", (table) => { const rows = table.getAll(); return () => (rows.result as Draft[]).filter((row) => row.scope.userID === userID && row.scope.projectID === projectID); });
}
export async function purgeAccountDrafts(userID: string) {
  const channel = draftChannel(); channel.postMessage({ type: "logout", userID }); channel.close();
  window.dispatchEvent(new CustomEvent("cce-logout", { detail: userID }));
  await accountTransaction("readwrite", (table) => {
    const cursor = table.openCursor();
    cursor.onsuccess = () => { const row = cursor.result; if (row) { if ((row.value as Draft).scope.userID === userID) row.delete(); row.continue(); } };
    return () => undefined;
  });
}
export function downloadDraft(text: string, name = "recoverable-draft.txt") {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  const link = document.createElement("a"); link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
