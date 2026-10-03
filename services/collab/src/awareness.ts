import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";

export type CursorState = { selection: { anchor: Record<string, unknown>; head: Record<string, unknown> } | null; user: { id: string; name: string; color: string } };
export type Presence = { id: number; clock: number; state: CursorState | null; at: number };
const integer = (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 4294967295;
function position(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some(key => !['type','tname','item','assoc'].includes(key))) return false;
  const assoc=row.assoc === undefined ? 0 : row.assoc;
  if (row.tname !== 'content' || row.type != null || typeof assoc!=='number' || ![-1,0,1].includes(assoc)) return false;
  const item = row.item as Record<string, unknown> | null;
  return item == null || typeof item === 'object' && Object.keys(item).length === 2 && integer(item.client) && integer(item.clock);
}
export function decodePresence(bytes: Uint8Array) {
  const decoder = decoding.createDecoder(bytes);
  if (decoding.readVarUint(decoder) !== 1) throw new Error('FRAME_INVALID');
  const id = decoding.readVarUint(decoder); const clock = decoding.readVarUint(decoder);
  const json = decoding.readVarString(decoder);
  if (decoder.pos !== bytes.length || !integer(id) || !integer(clock)) throw new Error('FRAME_INVALID');
  const state = JSON.parse(json) as unknown;
  if (state === null) return { id, clock, selection: null, removed: true };
  if (!state || typeof state !== 'object' || Array.isArray(state) || Object.keys(state).some(key => key !== 'selection')) throw new Error('FORBIDDEN');
  const selection = (state as { selection?: unknown }).selection;
  if (selection == null) return { id, clock, selection: null, removed: false };
  if (typeof selection !== 'object' || Array.isArray(selection) || Object.keys(selection).length !== 2) throw new Error('FRAME_INVALID');
  const {anchor,head} = selection as { anchor: unknown; head: unknown };
  if (!position(anchor) || !position(head)) throw new Error('FRAME_INVALID');
  return { id, clock, selection: { anchor, head }, removed: false };
}
export function encodePresence(value: Presence): Uint8Array {
  const encoder = encoding.createEncoder(); encoding.writeVarUint(encoder,1); encoding.writeVarUint(encoder,value.id); encoding.writeVarUint(encoder,value.clock); encoding.writeVarString(encoder,JSON.stringify(value.state));
  return encoding.toUint8Array(encoder);
}
export const cursorColor = (user: string) => ['#8db5ff','#e5ad70','#b49cff','#71c4a5','#e995b7'][Number.parseInt(user.slice(0,8),16)%5];
