import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";
import { decodeEnvelope, encodeEnvelope, FrameError, FrameType } from "./frame.js";

const fixturePath = fileURLToPath(new URL("../fixtures/frame-v1.json", import.meta.url));
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as { durable_ack_hex: string };
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
