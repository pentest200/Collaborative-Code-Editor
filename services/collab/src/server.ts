import { createServer } from "node:http";
import { healthHandler } from "./health.js";

const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? "8081");
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("invalid PORT");

createServer(healthHandler).listen(port, host);
