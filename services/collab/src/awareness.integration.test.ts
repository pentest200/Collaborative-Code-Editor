import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {Pool} from 'pg';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import {encodeEnvelope,FrameType} from '@cce/protocol';
import {attachRealtime} from './realtime.js';
import {fixture,secret,connect,frame,sync} from './testing/fixture.js';

function presence(id:number,clock:number,state:unknown) {
  const e=encoding.createEncoder();encoding.writeVarUint(e,1);encoding.writeVarUint(e,id);encoding.writeVarUint(e,clock);encoding.writeVarString(e,JSON.stringify(state));return encodeEnvelope(FrameType.AWARENESS,encoding.toUint8Array(e));
}
function decoded(bytes:Uint8Array) {
  const d=decoding.createDecoder(bytes);assert.equal(decoding.readVarUint(d),1);const id=decoding.readVarUint(d);const clock=decoding.readVarUint(d);const state=JSON.parse(decoding.readVarString(d));assert.equal(d.pos,bytes.length);return{id,clock,state};
}
test('authenticated awareness rejects identity/client spoofing and isolates rooms; disconnect removes cursor', {skip:!process.env.TEST_DATABASE_URL},async()=>{
  const pool=new Pool({connectionString:process.env.TEST_DATABASE_URL});const scope=await fixture(pool);const otherScope=await fixture(pool);
  const server=createServer();const service=attachRealtime(server,process.env.TEST_COLLAB_DATABASE_URL??process.env.TEST_DATABASE_URL!,secret);server.listen(0,'127.0.0.1');await once(server,'listening');const port=(server.address() as {port:number}).port;
  const sockets=[];const local=new Y.Doc();const content=local.getText('content');
  try {
    const sender=await connect(port,scope);const observer=await connect(port,scope);const isolated=await connect(port,otherScope);sockets.push(sender,observer,isolated);
    await sync(sender);await sync(observer);await sync(isolated);
    const selection={anchor:Y.createRelativePositionFromTypeIndex(content,0),head:Y.createRelativePositionFromTypeIndex(content,0)};
    const received=frame(observer,FrameType.AWARENESS);sender.send(presence(123,1,{selection}));
    const value=decoded(await received);assert.equal(value.id,123);assert.equal(value.state.user.id,scope.sub);assert.equal(value.state.user.name,'Durability test');assert.equal(value.state.user.role,undefined);
    assert.deepEqual(value.state.selection,JSON.parse(JSON.stringify(selection)));
    const replay=await connect(port,scope);sockets.push(replay);const replayed=frame(replay,FrameType.AWARENESS);await sync(replay);assert.equal(decoded(await replayed).id,123);
    const forged=frame(observer,FrameType.ERROR);observer.send(presence(123,2,{selection}));assert.equal(JSON.parse(Buffer.from(await forged).toString()).code,'FORBIDDEN');
    const identity=frame(sender,FrameType.ERROR);sender.send(presence(123,2,{selection,user:{id:otherScope.sub,role:'owner'}}));assert.equal(JSON.parse(Buffer.from(await identity).toString()).code,'FORBIDDEN');
    const changed=frame(sender,FrameType.ERROR);sender.send(presence(124,2,{selection}));assert.equal(JSON.parse(Buffer.from(await changed).toString()).code,'FORBIDDEN');
    const clock=frame(sender,FrameType.ERROR);sender.send(presence(123,4000000,{selection}));assert.equal(JSON.parse(Buffer.from(await clock).toString()).code,'FRAME_INVALID');
    const invalidPosition=frame(sender,FrameType.ERROR);sender.send(presence(123,2,{selection:{...selection,anchor:{...selection.anchor,assoc:'0'}}}));assert.equal(JSON.parse(Buffer.from(await invalidPosition).toString()).code,'FRAME_INVALID');
    const isolatedStates:number[]=[];isolated.on('message',raw=>{const bytes=raw as Buffer;if(bytes[1]===FrameType.AWARENESS)isolatedStates.push(bytes[1]);});
    const refreshed=frame(observer,FrameType.AWARENESS);sender.send(presence(123,2,{selection}));await refreshed;
    const removed=frame(observer,FrameType.AWARENESS);sender.terminate();assert.equal(decoded(await removed).state,null);
    assert.equal(isolatedStates.length,0,'Different projects cannot observe presence');
    assert.equal((await pool.query('SELECT count(*)::int n FROM document_updates WHERE document_id=$1',[scope.document_id])).rows[0].n,0,'Awareness never appends document state');
    if(process.env.TEST_COLLAB_DATABASE_URL) {
      const worker=new Pool({connectionString:process.env.TEST_COLLAB_DATABASE_URL});
      try {await worker.query('SELECT id,display_name FROM users LIMIT 1');await assert.rejects(worker.query('SELECT provider_subject FROM users LIMIT 1'),/permission denied/);}finally{await worker.end();}
    }
  } finally {for(const socket of sockets)socket.terminate();local.destroy();await service.close();await new Promise<void>(resolve=>server.close(()=>resolve()));await pool.end();}
});
