import assert from "node:assert/strict";
import { test } from "node:test";
import * as Y from "yjs";
import { encodeCandidate } from "./candidate.js";

test("isolated state encoding enforces schema and records bounded candidate costs", async () => {
  const costs=[];
  for (const size of [1024,262144]) {
    const doc=new Y.Doc();doc.getText('content').insert(0,'x'.repeat(size));
    const start=performance.now();const value=await encodeCandidate(Y.encodeStateAsUpdate(doc));
    costs.push({textBytes:size,wallMs:Number((performance.now()-start).toFixed(2)),workerMs:Number(value.elapsedMs.toFixed(2)),heapBytes:value.heapBytes,stateBytes:value.state.byteLength});
    doc.destroy();
  }
  console.log('candidate samples (single operation, not throughput):',JSON.stringify(costs));
  const huge=new Y.Doc();huge.getText('content').insert(0,'x'.repeat(262145));
  await assert.rejects(encodeCandidate(Y.encodeStateAsUpdate(huge)),/LIMIT_EXCEEDED/);huge.destroy();
  const roots=new Y.Doc();roots.getMap('other').set('bad',true);
  await assert.rejects(encodeCandidate(Y.encodeStateAsUpdate(roots)),/LIMIT_EXCEEDED/);roots.destroy();
  await assert.rejects(encodeCandidate(Uint8Array.from([255])),/LIMIT_EXCEEDED/);
  const delayed=new Y.Doc();const updates:Uint8Array[]=[];delayed.on('update',update=>updates.push(update));
  delayed.getText('content').insert(0,'prefix');delayed.getText('content').insert(6,'formatted',{bold:true});
  await assert.rejects(encodeCandidate(Uint8Array.from([0,0]),[updates[1]]),/LIMIT_EXCEEDED/);delayed.destroy();
  const healthy=await encodeCandidate(Uint8Array.from([0,0]));assert.deepEqual([...healthy.vector],[0]);
});
