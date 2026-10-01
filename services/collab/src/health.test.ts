import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { healthHandler } from "./health.js";

test("private health route reports liveness, other routes stay closed", async () => {
  const server = createServer(healthHandler).listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing TCP address");
    const origin = `http://127.0.0.1:${address.port}`;
    const health = await fetch(`${origin}/internal/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: "ok", service: "collab", phase: "00" });
    const other = await fetch(`${origin}/rooms`);
    assert.equal(other.status, 404);
  } finally {
    server.close();
  }
});
