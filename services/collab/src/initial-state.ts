import { timingSafeEqual } from "node:crypto";
import type { RequestListener } from "node:http";
import * as Y from "yjs";

export const initialStateHandler: RequestListener = (request, response) => {
  const expected = process.env.COLLAB_INTERNAL_TOKEN ?? (process.env.NODE_ENV === "production" ? "" : "cce_dev_internal_only");
  const supplied = request.headers["x-internal-token"];
  const left = Buffer.from(typeof supplied === "string" ? supplied : "");
  const right = Buffer.from(expected);
  if (!expected || left.length !== right.length || !timingSafeEqual(left, right)) {
    response.writeHead(403).end();
    return;
  }
  if (request.method !== "GET") {
    response.writeHead(405).end();
    return;
  }
  const doc = new Y.Doc();
  doc.getText("content");
  const encodedState = Y.encodeStateAsUpdate(doc);
  const stateVector = Y.encodeStateVector(doc);
  doc.destroy();
  response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify({ encoded_state: Buffer.from(encodedState).toString("base64"), state_vector: Buffer.from(stateVector).toString("base64") }));
};
