export const VERSION = 1;
export const HEADER_BYTES = 6;
export const MAX_SEQUENCE = 9223372036854775807n;

export enum FrameType {
  HELLO = 1,
  SYNC_REQUEST,
  SYNC_STATE,
  DURABLE_UPDATE,
  UPDATE_COMMITTED,
  DURABLE_ACK,
  AWARENESS,
  ERROR
}

const clientTypes = new Set([FrameType.SYNC_REQUEST, FrameType.DURABLE_UPDATE, FrameType.AWARENESS]);
const serverTypes = new Set([FrameType.HELLO, FrameType.SYNC_STATE, FrameType.UPDATE_COMMITTED, FrameType.DURABLE_ACK, FrameType.AWARENESS, FrameType.ERROR]);
const limits: Record<FrameType, { min: number; max: number }> = {
  [FrameType.HELLO]: { min: 2, max: 4096 },
  [FrameType.SYNC_REQUEST]: { min: 0, max: 65536 },
  [FrameType.SYNC_STATE]: { min: 16, max: 16 + 65536 + 2097152 },
  [FrameType.DURABLE_UPDATE]: { min: 65, max: 64 + 524288 },
  [FrameType.UPDATE_COMMITTED]: { min: 73, max: 72 + 524288 },
  [FrameType.DURABLE_ACK]: { min: 72, max: 72 },
  [FrameType.AWARENESS]: { min: 1, max: 2048 },
  [FrameType.ERROR]: { min: 2, max: 4096 }
};

export class FrameError extends Error {}

export function decodeEnvelope(input: Uint8Array, direction: "client" | "server") {
  if (input.byteLength < HEADER_BYTES) throw new FrameError("truncated header");
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  if (view.getUint8(0) !== VERSION) throw new FrameError("unsupported version");
  const type = view.getUint8(1) as FrameType;
  const limit = limits[type];
  if (!limit) throw new FrameError("unknown type");
  if (!(direction === "client" ? clientTypes : serverTypes).has(type)) throw new FrameError("wrong direction");
  const length = view.getUint32(2, false);
  if (length < limit.min || length > limit.max) throw new FrameError("invalid body length");
  if (input.byteLength !== HEADER_BYTES + length) throw new FrameError("message length mismatch");
  const body = input.subarray(HEADER_BYTES);
  validateBody(type, body);
  return { type, body };
}

export function encodeEnvelope(type: FrameType, body: Uint8Array): Uint8Array {
  const limit = limits[type];
  if (!limit || body.byteLength < limit.min || body.byteLength > limit.max) throw new FrameError("invalid body length");
  validateBody(type, body);
  const output = new Uint8Array(HEADER_BYTES + body.byteLength);
  const view = new DataView(output.buffer);
  view.setUint8(0, VERSION);
  view.setUint8(1, type);
  view.setUint32(2, body.byteLength, false);
  output.set(body, HEADER_BYTES);
  return output;
}

function readSequence(body: Uint8Array): bigint {
  const value = new DataView(body.buffer, body.byteOffset, body.byteLength).getBigUint64(0, false);
  if (value > MAX_SEQUENCE) throw new FrameError("sequence exceeds signed int64");
  return value;
}

function validateBody(type: FrameType, body: Uint8Array): void {
  if (type === FrameType.DURABLE_ACK || type === FrameType.UPDATE_COMMITTED || type === FrameType.SYNC_STATE) readSequence(body);
  if (type === FrameType.SYNC_STATE) {
    const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
    const vectorLength = view.getUint32(8, false);
    if (vectorLength > 65536 || body.byteLength < 16 + vectorLength) throw new FrameError("invalid vector length");
    const updateLength = view.getUint32(12 + vectorLength, false);
    if (updateLength > 2097152 || body.byteLength !== 16 + vectorLength + updateLength) throw new FrameError("invalid update length");
  }
}
