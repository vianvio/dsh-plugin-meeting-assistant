import test from 'node:test';
import assert from 'node:assert/strict';
import {ResilientAsrSession} from '../../src/vendor/voice-kernel/resilient-asr-session.mjs';

test('stop during connection cancels the pending stream and never resurrects capture',async()=>{
  let rejectStart;let drops=0;
  const stream={state:'connecting',start:()=>new Promise((_resolve,reject)=>{rejectStart=reject;}),forceDrop(){drops++;this.state='failed';rejectStart(new Error('closed'));}};
  const session=new ResilientAsrSession({createStream:()=>stream});
  const starting=session.start();await session.stop();await starting;
  assert.equal(session.stream,null);assert.equal(session.wsState,'stopped');assert.ok(drops>=1);
  session.feedAudio(Buffer.alloc(3200));assert.equal(session.fedBytes,0);
});
test('reconnection replays all buffered audio when the outage exceeds the 30 second tail',async()=>{
  const sent=[];const stream={state:'connecting',startedAt:Date.now(),async start(){this.state='ready';},sendAudio:b=>sent.push(b),async stop(){this.state='finished';},forceDrop(){}};
  const session=new ResilientAsrSession({createStream:()=>stream});
  session.feedAudio(Buffer.alloc(60*32000));await session.start();
  assert.equal(sent[0].length,60*32000);assert.equal(session.bufferedBytes,0);await session.stop();
});
