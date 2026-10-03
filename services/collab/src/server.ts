import { createServer } from "node:http";
import { healthHandler } from "./health.js";
import { initialStateHandler } from "./initial-state.js";
import { attachRealtime } from "./realtime.js";
import { checkpointHandler } from "./checkpoints.js";

const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? "8081");
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("invalid PORT");

const checkpoints = checkpointHandler(process.env.DATABASE_URL ?? "", process.env.COLLAB_INTERNAL_TOKEN ?? (process.env.NODE_ENV === "production" ? "" : "cce_dev_internal_only"));
const server = createServer((request, response) => {
  if (request.url === "/internal/checkpoints/materialize" || request.url === "/internal/checkpoints/prepare") {
    void checkpoints(request, response);
    return;
  }
  if (request.url === "/internal/documents/empty") {
    initialStateHandler(request, response);
    return;
  }
  healthHandler(request, response);
});
attachRealtime(server, process.env.DATABASE_URL ?? "", process.env.COLLAB_INTERNAL_TOKEN ?? (process.env.NODE_ENV === "production" ? "" : "cce_dev_internal_only"));
server.listen(port, host);
