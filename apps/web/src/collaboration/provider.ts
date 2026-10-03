import * as Y from "yjs";
import { decodeEnvelope, encodeEnvelope, FrameType } from "@cce/protocol";

export type ConnectionState = "Connecting" | "Synced" | "Saving" | "Saved" | "Disconnected · unsaved edits not retained" | "Access changed" | "Storage unavailable" | "Collaboration unavailable";

function uuidBytes(id: string): Uint8Array { return Uint8Array.from((id.replaceAll("-", "").match(/../g) ?? []).map((value) => Number.parseInt(value, 16))); }
function randomID(): string { return crypto.randomUUID(); }

export class DocumentProvider {
  readonly doc = new Y.Doc();
  private socket: WebSocket;
  private instance = randomID();
  private synced = false;
  private pending = new Map<string, Uint8Array | null>();
  private closed = false;
  private terminal: ConnectionState | null = null;
  private readonly onState: (state: ConnectionState) => void;

  constructor(documentID: string, onState: (state: ConnectionState) => void) {
    this.onState = onState;
    this.doc.getText("content");
    const endpoint = new URL(`/ws/documents/${documentID}`, location.href);
    endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
    this.socket = new WebSocket(endpoint);
    this.socket.binaryType = "arraybuffer";
    this.socket.onopen = () => this.send(FrameType.SYNC_REQUEST, Y.encodeStateVector(this.doc));
    this.socket.onmessage = (event) => {
      if (!(event.data instanceof ArrayBuffer)) return;
      try {
        const { type, body } = decodeEnvelope(new Uint8Array(event.data), "server");
        if (type === FrameType.SYNC_STATE) {
          const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
          const vectorLength = view.getUint32(8);
          const updateLength = view.getUint32(12 + vectorLength);
          Y.applyUpdate(this.doc, body.subarray(16 + vectorLength, 16 + vectorLength + updateLength), "remote");
          this.synced = true;
          if (!this.terminal) this.onState(this.pending.size ? "Saving" : "Synced");
        }
        if (type === FrameType.UPDATE_COMMITTED) Y.applyUpdate(this.doc, body.subarray(72), "remote");
        if (type === FrameType.DURABLE_ACK) {
          const key = Array.from(body.subarray(8,40)).join(",");
          if (!this.pending.has(key)) return;
          const hash = this.pending.get(key);
          if (!hash?.every((byte, index) => byte === body[40+index])) {
            this.terminal = "Collaboration unavailable"; this.onState(this.terminal); return;
          }
          this.pending.delete(key);
          if (!this.terminal) this.onState(this.pending.size ? "Saving" : "Saved");
        }
        if (type === FrameType.ERROR) {
          const detail = JSON.parse(new TextDecoder().decode(body)) as { code?: string };
          this.terminal = detail.code === "FORBIDDEN" || detail.code === "AUTH_REQUIRED" || detail.code === "STALE_GENERATION" ? "Access changed" : detail.code === "STORAGE_UNAVAILABLE" ? "Storage unavailable" : "Collaboration unavailable";
          this.onState(this.terminal);
        }
      } catch { this.onState("Collaboration unavailable"); }
    };
    this.socket.onerror = () => { this.terminal ??= "Collaboration unavailable"; this.onState(this.terminal); };
    this.socket.onclose = () => { if (!this.closed) this.onState(this.terminal ?? "Disconnected · unsaved edits not retained"); };
    this.doc.on("update", this.localUpdate);
  }

  private send(type: FrameType, body: Uint8Array) {
    if (this.socket.readyState === WebSocket.OPEN) this.socket.send(encodeEnvelope(type, body));
  }

  private localUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin === "remote" || !this.synced) return;
    if (update.byteLength > 524288) { this.onState("Collaboration unavailable"); return; }
    const id = uuidBytes(randomID());
    const body = new Uint8Array(64 + update.byteLength);
    body.set(uuidBytes(this.instance)); body.set(id, 16); body.set(update, 64);
    const key = Array.from(body.subarray(0,32)).join(",");
    this.pending.set(key,null);
    if (!this.terminal) this.onState("Saving");
    crypto.subtle.digest("SHA-256", Uint8Array.from(update)).then((hash) => {
      if (this.closed) return;
      body.set(new Uint8Array(hash), 32);
      this.pending.set(key,new Uint8Array(hash));
      this.send(FrameType.DURABLE_UPDATE, body);
    }).catch(() => { this.terminal = "Collaboration unavailable"; this.onState(this.terminal); });
  };

  get isSynced() { return this.synced && !this.terminal && !this.closed && this.socket.readyState === WebSocket.OPEN; }
  close() { this.closed = true; this.doc.off("update", this.localUpdate); this.socket.close(); this.doc.destroy(); }
}
