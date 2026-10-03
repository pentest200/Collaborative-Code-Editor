// Test subprocess only; production server never imports this file. IPC barriers
// pause the actual store return path, without exposing a network fault endpoint.
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { DocumentStore, type OwnedState } from "../persistence.js";
import { attachRealtime } from "../realtime.js";

class CrashStore extends DocumentStore {
  async barrier(stage: string) {
    if (process.env.CRASH_STAGE !== stage) return;
    process.send?.({ stage });
    await new Promise<void>(() => {});
  }
  override async append(...args: Parameters<DocumentStore['append']>) {
    const sequence = await super.append(...args);
    await this.barrier("after-commit"); return sequence;
  }
  override async snapshot(document: string, fence: bigint, value: OwnedState) {
    await super.snapshot(document,fence,value); await this.barrier("after-snapshot");
  }
  override async renew(document: string, fence: bigint) {
    const result = await super.renew(document,fence); await this.barrier("renewal"); return result;
  }
}
const store = new CrashStore(process.env.TEST_COLLAB_DATABASE_URL!,randomUUID());
const server = createServer((_request,response) => response.writeHead(404).end());
attachRealtime(server,process.env.TEST_COLLAB_DATABASE_URL!,process.env.TEST_ASSERTION_SECRET!,store);
server.listen(0,"127.0.0.1",() => process.send?.({ port: (server.address() as { port: number }).port }));
