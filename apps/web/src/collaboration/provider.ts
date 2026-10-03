import * as Y from "yjs";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from "y-protocols/awareness";
import { decodeEnvelope, encodeEnvelope, FrameType } from "@cce/protocol";
import { DraftStore, draftChannel, draftKey, sameBytes, type DraftScope, type OutboxItem } from "./drafts";

export type ConnectionState = "Connecting" | "Synced" | "Saving" | "Saved" | "Offline — draft retained" | "Access changed" | "Version replaced/deleted" | "Storage unavailable" | "Collaboration unavailable";
export const remoteOrigin = Symbol("committed-or-retained-state");
function uuidBytes(id: string) { return Uint8Array.from((id.replaceAll("-", "").match(/../g) ?? []).map((part) => Number.parseInt(part, 16))); }
function uuid(bytes: Uint8Array) { const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(""); return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`; }

// State vectors omit deletes. Compare delete-set coverage as well, so recovery
// catches unrepresented deletions without repeatedly submitting known deletes.
function missingState(local: Y.Doc, represented: Y.Doc) {
  const delta = Y.encodeStateAsUpdate(local, Y.encodeStateVector(represented));
  const decoded = Y.decodeUpdate(delta);
  const known = Y.decodeUpdate(Y.encodeStateAsUpdate(represented)).ds.clients;
  const missingDelete = [...decoded.ds.clients].some(([client, ranges]) => ranges.some((range) => {
    let end = range.clock;
    for (const interval of known.get(client) ?? []) {
      if (interval.clock > end) break;
      end = Math.max(end, interval.clock + interval.len);
      if (end >= range.clock + range.len) return false;
    }
    return true;
  }));
  return decoded.structs.length || missingDelete ? delta : null;
}

export class DocumentProvider {
  readonly doc = new Y.Doc();
  readonly awareness = new Awareness(this.doc);
  readonly store: DraftStore;
  private committed = new Y.Doc();
  private socket: WebSocket | null = null;
  private instance = crypto.randomUUID();
  private synced = false;
  private initialized = false;
  private storageReady = false;
  private writable: boolean;
  private pending: OutboxItem[] = [];
  private localWork = 0;
  private localBytes = 0;
  private closed = false;
  private discarded = false;
  private terminal: ConnectionState | null = null;
  private storageFailure = false;
  private attempt = 0;
  private receivedReceipt = false;
  private connecting = false;
  private retry?: ReturnType<typeof setTimeout>;
  private pumpTimer?: ReturnType<typeof setTimeout>;
  private awarenessTimer?: ReturnType<typeof setTimeout>;
  private deadline?: ReturnType<typeof setTimeout>;
  private receiptDeadline?: ReturnType<typeof setTimeout>;
  private sent = new Set<string>();
  private queue = Promise.resolve();
  private channel = draftChannel();
  private state: ConnectionState = "Connecting";
  detail = "Restoring the account-scoped browser draft.";

  constructor(readonly scope: DraftScope, canEdit: boolean, private onState: (state: ConnectionState) => void) {
    this.writable = canEdit; this.store = new DraftStore(scope); this.doc.getText("content"); this.committed.getText("content");
    this.awareness.setLocalState(null);
    this.doc.on("update", this.localUpdate); this.awareness.on("update", this.awarenessUpdate);
    this.channel.onmessage = (event) => {
      if (event.data?.type === "logout" && event.data.userID === scope.userID) { this.logout(); return; }
      if (event.data?.key === draftKey(scope)) this.run(async () => {
        const row = await this.store.read(); if (this.closed) return;
        Y.applyUpdate(this.doc, row.state, remoteOrigin); this.pending = row.pending;
        if (row.frozen) { this.deny(row.frozen as ConnectionState); return; }
        this.publish(); this.pump();
      });
    };
    window.addEventListener("online", this.online); window.addEventListener("cce-logout", this.localLogout);
    this.run(async () => {
      const row = await this.store.read(); if (this.closed) return;
      Y.applyUpdate(this.doc, row.state, remoteOrigin); this.pending = row.pending; this.storageReady = true;
      this.initialized = row.state.length > 2;
      if (row.frozen) { this.deny(row.frozen as ConnectionState); return; }
      void this.connect();
    });
  }
  private emit(state: ConnectionState, detail?: string) { this.state = state; if (detail) this.detail = detail; if (!this.closed) this.onState(state); }
  private publish() {
    if (this.closed || this.terminal) return;
    if (this.storageFailure) { this.emit("Storage unavailable"); return; }
    if (!this.synced) { this.emit(this.localWork ? "Saving" : this.storageReady && this.initialized ? "Offline — draft retained" : "Connecting", this.initialized ? "Retaining local changes; reconnecting with fresh authorization." : "Connecting to committed source."); return; }
    this.emit(this.pending.length || this.localWork ? "Saving" : this.receivedReceipt ? "Saved" : "Synced", "Saved confirms server receipts. Browser retention completes separately.");
  }
  private run(work: () => Promise<void>) {
    this.queue = this.queue.then(work).catch((error) => {
      if (this.closed) return;
      this.storageFailure = true; this.storageReady = false; this.disconnect();
      this.emit("Storage unavailable", error instanceof Error ? error.message : "Browser draft storage failed. Download the visible draft.");
    });
  }
  private notifyDraft() {
    if (this.discarded) return;
    const channel = this.closed ? draftChannel() : this.channel;
    channel.postMessage({ key: draftKey(this.scope) });
    if (this.closed) channel.close();
  }
  private localUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin === remoteOrigin || this.closed) return;
    if (this.localWork >= 128 || this.localBytes + update.length > 4194304) {
      this.storageFailure = true; this.storageReady = false; this.disconnect();
      this.emit("Storage unavailable", "Browser retention queue full. Download the visible draft; the latest change was not retained."); return;
    }
    this.localBytes += update.length;
    this.localWork++; this.publish();
    this.run(async () => {
      try {
        if (this.discarded) return;
        if (update.length > 524288) throw new Error("Local update exceeds 512 KiB. Download the visible draft.");
        const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(update)));
        if (this.discarded) return;
        const item = { instance: this.instance, message: crypto.randomUUID(), hash, update };
        const row = await this.store.retain(update, item); this.pending = row.pending;
        this.notifyDraft(); this.pump();
      } finally { this.localWork--; this.localBytes -= update.length; this.publish(); }
    });
  };
  private online = () => { if (!this.closed && !this.terminal && !this.storageFailure) { clearTimeout(this.retry); if (!this.socket) void this.connect(); } };
  private localLogout = (event: Event) => { if ((event as CustomEvent<string>).detail === this.scope.userID) this.logout(); };
  private logout() {
    this.discarded = true; this.terminal = "Access changed"; this.disconnect();
    this.doc.transact(() => this.doc.getText("content").delete(0, this.doc.getText("content").length), remoteOrigin);
    this.emit("Access changed", "Signed out. Account caches are no longer accessible."); this.close();
  }
  private deny(reason: ConnectionState) {
    if (this.terminal === reason) return;
    this.terminal = reason; this.disconnect(); this.emit(reason, "Automatic replay stopped. Download the draft or find it in Recover drafts.");
    this.run(async () => { if (!this.discarded) { await this.store.freeze(reason); this.notifyDraft(); } });
  }
  private async connect() {
    if (this.closed || this.terminal || this.storageFailure || this.socket || this.connecting) return;
    this.connecting = true;
    try {
      const signal = AbortSignal.timeout(5000);
      const session = await fetch("/api/v1/session", { cache: "no-store", signal });
      if (this.closed) return;
      if (session.status === 401) { this.deny("Access changed"); return; }
      if (!session.ok) throw new Error("Session check unavailable");
      const identity = await session.json() as { user: { id: string } };
      if (identity.user.id !== this.scope.userID) { this.logout(); return; }
      const base = `/api/v1/projects/${this.scope.projectID}`;
      const [project, tree] = await Promise.all([fetch(base, { cache: "no-store", signal }), fetch(`${base}/tree`, { cache: "no-store", signal })]);
      if (this.closed) return;
      if ([project.status, tree.status].some((status) => status === 401 || status === 403 || status === 404)) { this.deny("Access changed"); return; }
      if (!project.ok || !tree.ok) throw new Error("Access check unavailable");
      const metadata = await project.json() as { role: string };
      const files = await tree.json() as { entries: { id: string; document_id: string; generation: string }[] };
      const file = files.entries.find((entry) => entry.id === this.scope.fileID);
      if (!file || file.document_id !== this.scope.documentID || file.generation !== this.scope.generation) { this.deny("Version replaced/deleted"); return; }
      this.writable = metadata.role === "owner" || metadata.role === "editor";
      if (!this.writable && this.pending.length) { this.deny("Access changed"); return; }
      if (this.closed || this.terminal) return;
      const endpoint = new URL(`/ws/documents/${this.scope.documentID}`, location.href); endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(endpoint); this.socket = socket; socket.binaryType = "arraybuffer";
      this.deadline = setTimeout(() => { if (!this.synced) socket.close(); }, 10000);
      socket.onopen = () => this.send(FrameType.SYNC_REQUEST, Y.encodeStateVector(this.committed));
      socket.onmessage = (event) => { if (this.socket !== socket || this.closed || !(event.data instanceof ArrayBuffer)) return; this.run(() => this.receive(new Uint8Array(event.data))); };
      socket.onerror = () => {}; // onclose schedules the bounded retry.
      socket.onclose = () => { if (this.socket !== socket) return; this.disconnect(); this.publish(); this.schedule(); };
    } catch { if (!this.closed) { this.publish(); this.schedule(); } }
    finally { this.connecting = false; }
  }
  private schedule() {
    if (this.closed || this.terminal || this.storageFailure) return;
    clearTimeout(this.retry);
    const delay = Math.min(10000, 300 * 2 ** Math.min(this.attempt++, 6)) * (0.75 + Math.random() * 0.5);
    this.retry = setTimeout(() => { void this.connect(); }, delay);
  }
  private async receive(bytes: Uint8Array) {
    if (this.closed || this.terminal) return;
    const { type, body } = decodeEnvelope(bytes, "server");
    if (type === FrameType.HELLO) {
      const hello = JSON.parse(new TextDecoder().decode(body));
      if (hello.document_id !== this.scope.documentID || hello.file_id !== this.scope.fileID || String(hello.generation) !== this.scope.generation) this.deny("Version replaced/deleted");
    }
    if (type === FrameType.SYNC_STATE) {
      const view = new DataView(body.buffer, body.byteOffset, body.byteLength); const length = view.getUint32(8); const update = body.subarray(16 + length);
      Y.applyUpdate(this.committed, update, remoteOrigin); Y.applyUpdate(this.doc, update, remoteOrigin); this.initialized = true;
      const row = await this.store.retain(Y.encodeStateAsUpdate(this.doc)); this.pending = row.pending;
      if (this.writable) {
        const represented = new Y.Doc(); represented.getText("content"); Y.applyUpdate(represented, Y.encodeStateAsUpdate(this.committed));
        for (const item of this.pending) Y.applyUpdate(represented, item.update);
        const delta = missingState(this.doc, represented); represented.destroy();
        if (delta) {
          if (delta.length > 524288) throw new Error("Reconciliation exceeds 512 KiB. Download retained draft; bytes were not truncated.");
          const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(delta)));
          this.pending = (await this.store.retain(delta, { instance: this.instance, message: crypto.randomUUID(), hash, update: delta })).pending;
        }
      }
      this.synced = true; this.attempt = 0; clearTimeout(this.deadline); this.publish(); this.pump(); this.sendAwareness();
    }
    if (type === FrameType.UPDATE_COMMITTED) {
      const update = body.subarray(72); Y.applyUpdate(this.committed, update, remoteOrigin); Y.applyUpdate(this.doc, update, remoteOrigin); await this.store.retain(update);
    }
    if (type === FrameType.DURABLE_ACK) {
      const instance = uuid(body.subarray(8,24)); const message = uuid(body.subarray(24,40));
      const item = this.pending.find((entry) => entry.instance === instance && entry.message === message);
      if (item && !sameBytes(item.hash, body.subarray(40,72))) { this.deny("Collaboration unavailable"); return; }
      if (item) Y.applyUpdate(this.committed, item.update, remoteOrigin);
      const row = await this.store.acknowledge(instance, message, body.subarray(40,72)); this.pending = row.pending;
      if (item) this.receivedReceipt = true;
      this.sent.delete(instance + message); clearTimeout(this.receiptDeadline);
      this.channel.postMessage({ key: draftKey(this.scope) }); this.publish(); this.pump();
    }
    if (type === FrameType.AWARENESS) applyAwarenessUpdate(this.awareness, body, remoteOrigin);
    if (type === FrameType.ERROR) {
      const error = JSON.parse(new TextDecoder().decode(body)) as { code: string };
      if (error.code === "AUTH_REQUIRED" || error.code === "FORBIDDEN") {
        this.deny("Access changed");
        // A gateway read revalidation may use FORBIDDEN for both revocation and
        // invalidated generations. Refine the UI only from authorized metadata.
        if (error.code === "FORBIDDEN") {
          try {
            const response = await fetch(`/api/v1/projects/${this.scope.projectID}/tree`, { cache: "no-store", signal: AbortSignal.timeout(5000) });
            if (response.ok) {
              const tree = await response.json() as { entries: { id: string; document_id: string; generation: string }[] };
              const file = tree.entries.find(entry => entry.id === this.scope.fileID);
              if (!file || file.document_id !== this.scope.documentID || file.generation !== this.scope.generation) this.deny("Version replaced/deleted");
            }
          } catch { /* Already denied; the retained draft is still exportable. */ }
        }
        return;
      }
      if (error.code === "STALE_GENERATION") { this.deny("Version replaced/deleted"); return; }
      if (["ROOM_MOVED", "HEAD_CHANGED", "RATE_LIMITED", "STORAGE_UNAVAILABLE"].includes(error.code)) {
        this.emit(error.code === "STORAGE_UNAVAILABLE" ? "Storage unavailable" : "Offline — draft retained", "Server did not confirm saving. Browser draft retained; retry uses original identities.");
        this.disconnect(); this.schedule(); return;
      }
      this.deny("Collaboration unavailable");
    }
  }
  private send(type: FrameType, body: Uint8Array) {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    if (this.socket.bufferedAmount + body.length > 4194304) { this.socket.close(); return; }
    this.socket.send(encodeEnvelope(type, body));
  }
  private pump() {
    if (this.closed || this.terminal || !this.synced || !this.writable || this.pumpTimer || this.sent.size) return;
    this.pumpTimer = setTimeout(() => {
      this.pumpTimer = undefined;
      if (this.closed || this.terminal || !this.synced || this.socket?.readyState !== WebSocket.OPEN) return;
      const item = this.pending[0]; if (!item) return;
      const body = new Uint8Array(64 + item.update.length); body.set(uuidBytes(item.instance)); body.set(uuidBytes(item.message),16); body.set(item.hash,32); body.set(item.update,64);
      this.sent.add(item.instance + item.message); this.send(FrameType.DURABLE_UPDATE, body);
      this.receiptDeadline = setTimeout(() => { this.disconnect(); this.publish(); this.schedule(); }, 10000);
    }, 40);
  }
  private awarenessUpdate = (_change: unknown, origin: unknown) => {
    if (origin === remoteOrigin || this.closed || this.awarenessTimer) return;
    this.awarenessTimer = setTimeout(() => { this.awarenessTimer = undefined; this.sendAwareness(); }, 110);
  };
  private sendAwareness() {
    if (this.synced && !this.closed && !this.terminal) { const update = encodeAwarenessUpdate(this.awareness, [this.doc.clientID]); if (update.length <= 2048) this.send(FrameType.AWARENESS, update); }
  }
  private clearPeers() { removeAwarenessStates(this.awareness, [...this.awareness.getStates().keys()].filter((id) => id !== this.doc.clientID), remoteOrigin); }
  private disconnect() {
    const socket = this.socket; this.socket = null; this.synced = false; this.sent.clear();
    clearTimeout(this.deadline); clearTimeout(this.receiptDeadline); socket?.close(); this.clearPeers();
  }
  get canType() { return this.storageReady && this.initialized && this.writable && !this.storageFailure && !this.terminal && !this.closed; }
  get isSynced() { return this.synced && !this.terminal && !this.closed; }
  get status() { return this.state; }
  invalidateGeneration() { this.deny("Version replaced/deleted"); }
  close() {
    if (this.closed) return;
    this.awareness.setLocalState(null); this.sendAwareness(); this.closed = true;
    clearTimeout(this.retry); clearTimeout(this.pumpTimer); clearTimeout(this.awarenessTimer); this.disconnect();
    window.removeEventListener("online", this.online); window.removeEventListener("cce-logout", this.localLogout); this.channel.close();
    this.doc.off("update", this.localUpdate); this.awareness.off("update", this.awarenessUpdate);
    void this.queue.finally(() => this.store.close()); this.awareness.destroy(); this.committed.destroy(); this.doc.destroy();
  }
}
