import type { RequestListener } from "node:http";

export const healthHandler: RequestListener = (request, response) => {
  if (request.method !== "GET" || request.url !== "/internal/healthz") {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify({ status: "ok", service: "collab", phase: "02" }));
};
