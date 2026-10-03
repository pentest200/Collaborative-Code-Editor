import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";
import { decodeEnvelope, encodeEnvelope, FrameError, FrameType } from "./frame.js";

const fixturePath = fileURLToPath(new URL("../fixtures/frame-v1.json", import.meta.url));
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as { durable_ack_hex: string; pending_update_hex: string };
const ack = Uint8Array.from(Buffer.from(fixture.durable_ack_hex, "hex"));

test("shared durable ACK fixture decodes and re-encodes", () => {
  const decoded = decodeEnvelope(ack, "server");
  assert.equal(decoded.type, FrameType.DURABLE_ACK);
  assert.equal(Buffer.from(encodeEnvelope(decoded.type, decoded.body)).toString("hex"), fixture.durable_ack_hex);
});

test("wrong direction and trailing data are rejected", () => {
  assert.throws(() => decodeEnvelope(ack, "client"), FrameError);
  assert.throws(() => decodeEnvelope(Uint8Array.from([...ack, 0]), "server"), FrameError);
});

test("shared pending update fixture is server-only and has exact length", () => {
  const bytes = Uint8Array.from(Buffer.from(fixture.pending_update_hex, "hex"));
  const decoded = decodeEnvelope(bytes, "server");
  assert.equal(decoded.type, FrameType.PENDING_UPDATE);
  assert.equal(Buffer.from(encodeEnvelope(decoded.type, decoded.body)).toString("hex"), fixture.pending_update_hex);
  assert.throws(() => decodeEnvelope(bytes, "client"), FrameError);
  assert.throws(() => decodeEnvelope(bytes.subarray(0, -1), "server"), FrameError);
});
