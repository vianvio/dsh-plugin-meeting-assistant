import assert from 'node:assert/strict';
import test,{type TestContext} from 'node:test';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {acquireMeetingRuntime} from '../src/voice/runtime.js';
import {saveConfig} from '../src/voice/config.js';
import type {Context} from '@deepseek-ai/cordis';
import type {GenerateAdvice} from '../src/voice/coach-types.js';

const delay=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
async function until(check:()=>boolean){const end=Date.now()+1500;while(!check()&&Date.now()<end)await delay(2);assert.ok(check(),'expected runtime lifecycle transition');}
const response=(summary:string)=>JSON.stringify({summary,askedOfMe:[{question:'需要确认什么？',why:'会议目标需要确认。',tactfulReply:'先明确目标，再验证方案。',conciseReply:'先明确目标。',sources:['B_INVITE']}],askOthers:[{question:'差额怎么处理？',purpose:'明确差额处理。',timing:'确认计费时。',sources:['B_INVITE']}],uncertainties:[],carryForward:summary});
function fixture(t:TestContext){
  const root=mkdtempSync(join(tmpdir(),'meeting-runtime-')),leases:ReturnType<typeof acquireMeetingRuntime>[]=[];
  saveConfig(root,{apiKey:'fixture',wsBase:'wss://example.invalid/asr',model:'fixture'});
  const streams:{stops:number;sent:number;hooks:any}[]=[];
  const ctx={get:()=>undefined,logger:{warn(){}}} as unknown as Context;
  const acquire=(generate:GenerateAdvice=async()=>response('当前模型'),factory=acquireMeetingRuntime)=>{
    const lease=factory(root,ctx,generate,{releaseDelayMs:35,createStream:(_config,hooks)=>{
      const counts={stops:0,sent:0,hooks};streams.push(counts);
      return {state:'connecting',startedAt:Date.now(),audioZeroWall:null,refeedMs:0,queuedBytes:0,async start(){this.state='ready';},sendAudio(pcm:Buffer){counts.sent+=pcm.length;},async stop(){counts.stops++;this.state='finished';},forceDrop(){this.state='failed';}};
    }});leases.push(lease);return lease;
  };
  t.after(async()=>{for(const lease of leases)lease.release();await delay(45);await Promise.allSettled(leases.flatMap(lease=>[lease.service.dispose(),lease.coach.dispose()]));assert.ok(root.startsWith(join(tmpdir(),'meeting-runtime-')));rmSync(root,{recursive:true,force:true});});
  const prepare=async(lease:ReturnType<typeof acquire>)=>lease.coach.briefs.save('session-a','',{invitation:'确认计费规则',goal:'确认并发和差额',role:'技术负责人',initialViews:'',autoEnabled:false,filePaths:[]});
  return {root,acquire,prepare,streams};
}

test('profile reload preserves recording identity, PCM order and ASR stream',async t=>{
  const f=fixture(t),first=f.acquire();await f.prepare(first);
  const {recording,token}=first.service.start('session-a');await delay(1);
  first.service.audio(token,0,Buffer.alloc(3200,1).toString('base64'));
  first.release();
  assert.equal(first.service.active?.meta.id,recording.id,'releasing a plugin application must not stop a meeting');
  const next=f.acquire();
  assert.equal(next.reused,true);assert.equal(next.service,first.service);assert.equal(next.coach,first.coach);
  next.service.audio(token,1,Buffer.alloc(3200,2).toString('base64'));
  next.service.audio(token,1,Buffer.alloc(3200,2).toString('base64'));
  assert.equal(f.streams.length,1);assert.equal(f.streams[0]!.stops,0);
  assert.equal(next.service.active?.meta.audioBytes,6400,'retried PCM acknowledgement is deduplicated across reload');
  await delay(45);assert.equal(next.service.active?.meta.id,recording.id,'old release timer cannot stop a reacquired meeting');
  await next.service.stop(token);
  assert.equal(f.streams[0]!.stops,1);assert.equal(next.service.active,undefined);
  const wav=readFileSync(join(next.service.store.dir('session-a',recording.id),'audio.wav'));
  assert.equal(wav.length,6444);assert.equal(wav.readUInt32LE(40),6400);
});

test('an old owner released after its replacement cannot retire the active runtime',async t=>{
  const f=fixture(t),first=f.acquire();await f.prepare(first);const {token}=first.service.start('session-a');
  const next=f.acquire();first.release();first.release();await delay(45);
  assert.ok(next.service.active);assert.equal(f.streams[0]!.stops,0);
  await next.service.stop(token);
});

test('after handoff new advice uses the current model binding without resetting the meeting',async t=>{
  const f=fixture(t);let oldCalls=0,newCalls=0;
  const first=f.acquire(async()=>{oldCalls++;return response('旧模型');});await f.prepare(first);
  const {recording}=first.service.start('session-a');first.release();
  const next=f.acquire(async()=>{newCalls++;return response('新模型');});
  next.coach.request('session-a',recording.id);await next.coach.settled('session-a',recording.id);
  const state=next.coach.state(recording),advice=next.coach.readAdvice('session-a',recording.id,state.latestId!);
  assert.equal(advice.content.summary,'新模型');assert.equal(oldCalls,0);assert.equal(newCalls,1);
  assert.equal(next.service.active?.meta.id,recording.id);
});

test('a runtime with no replacement finalizes instead of leaking a recording',async t=>{
  const f=fixture(t),first=f.acquire();await f.prepare(first);const {token,recording}=first.service.start('session-a');
  first.service.audio(token,0,Buffer.alloc(3200).toString('base64'));first.release();
  await until(()=>!first.service.active);
  assert.equal(f.streams[0]!.stops,1);assert.equal(first.service.store.get('session-a',recording.id).state,'stopped');
  const next=f.acquire();assert.equal(next.reused,false);assert.notEqual(next.service,first.service);
});

test('advice is suspended while no plugin owns the runtime but transcript capture continues',async t=>{
  const f=fixture(t);let generations=0;const first=f.acquire(async()=>{generations++;return response('应由当前模型生成');});await f.prepare(first);
  const {recording}=first.service.start('session-a');await delay(1);
  first.coach.briefs.setAutomatic('session-a',recording.id,true);first.release();
  f.streams[0]!.hooks.onSentence({text:'新'.repeat(600),beginMs:0,endMs:1000,sentenceId:1,wallTs:Date.now()});
  assert.equal(generations,0);assert.equal(recording.segments,1);
  const next=f.acquire(async()=>{generations++;return response('已恢复');});next.coach.tick(recording);
  await next.coach.settled('session-a',recording.id);
  assert.equal(generations,1);assert.ok(next.service.active);assert.equal(next.coach.state(recording).throughLine,1);
});


test('a freshly imported plugin module reconnects to the same host recording runtime',async t=>{
  const f=fixture(t),first=f.acquire();await f.prepare(first);
  const {recording,token}=first.service.start('session-a');await delay(1);
  const replacement=await import(new URL('../src/voice/runtime.ts?reload=fresh-module',import.meta.url).href);
  first.release();const next=f.acquire(async()=>response('新模块'),replacement.acquireMeetingRuntime);
  assert.equal(next.reused,true);assert.equal(next.service,first.service);assert.equal(next.service.active?.meta.id,recording.id);
  next.service.audio(token,0,Buffer.alloc(3200).toString('base64'));
  assert.equal(f.streams.length,1);assert.equal(f.streams[0]!.stops,0);
  await next.service.stop(token);
});
