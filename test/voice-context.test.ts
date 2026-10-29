import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {Context} from '@deepseek-ai/cordis';
import type {UserMessage} from '@deepseek-ai/dsh-llm';
import {MeetingStore,type MeetingMeta} from '../src/voice/store.js';
import {CONTEXT_CHARS,CONTEXT_INTERVAL_MS,CONTEXT_SECTION,MeetingContextFeed,renderMeetingSnapshot} from '../src/voice/context.js';
import {isProducerSource} from '../src/shared/host-source.js';

/** A stand-in for the session agent: only `inject` is on the path under test. */
function listener(){const injected:UserMessage[]=[];return {injected,inject:(message:UserMessage)=>{injected.push(message);}};}
/** Cordis reaches services through `ctx.get`; a plain property would throw for real. */
const stubCtx=(agent:unknown)=>({get:(name:string)=>name==='agents'&&agent!==undefined?{get:()=>agent}:undefined} as unknown as Context);

function fixture(){
  const root=mkdtempSync(join(tmpdir(),'mesh-context-'));
  const store=new MeetingStore(root);
  const meta=store.create('session-a');
  meta.startedAt=1_000_000;meta.state='recording';
  store.save(meta);
  return {store,meta,word:(text:string,ms:number)=>{meta.segments++;store.append(meta,{text,wallTs:1_000_000+ms,beginMs:ms,endMs:ms+500});store.save(meta);},cleanup(){rmSync(root,{recursive:true,force:true});}};
}

test('the snapshot is a bounded view of the meeting, and says what it left out',()=>{
  const mk=(segments:number,closed=false):MeetingMeta=>({id:'0'.repeat(36),sessionId:'s',startedAt:1_000_000,endedAt:closed?1_300_000:null,state:closed?'stopped':'recording',segments,audioBytes:0,error:null,reconnects:0,droppedBytes:0,untranscribedBytes:0,wsState:'ready'} as MeetingMeta);
  assert.match(renderMeetingSnapshot(mk(0),[],1_100_000),/^会议「\d\d:\d\d:\d\d 开始」进行中 · 已转写 0 句 · 时长 1:40\n（尚无转写内容）$/);
  assert.match(renderMeetingSnapshot(mk(3,true),[],1_300_000),/已结束 · 已转写 3 句 · 时长 5:00/);

  const entries=Array.from({length:3},(_,i)=>({line:i+1,ts:1_000_000+i*60_000,startMs:i*60_000,endMs:i*60_000+500,text:`第${i+1}句`}));
  const shown=renderMeetingSnapshot(mk(3),entries,1_200_000);
  assert.match(shown,/\n\[0:00\] 第1句\n\[1:00\] 第2句\n\[2:00\] 第3句$/,'timestamps are relative to the meeting start');
  assert.doesNotMatch(shown,/未列出/,'nothing is omitted when the window covers the meeting');
  const trimmed=renderMeetingSnapshot(mk(40),entries,1_200_000);
  assert.match(trimmed,/仅列出最近 3 句，此前 37 句未列出/);
  assert.match(trimmed,/voice_log/,'a trimmed snapshot points at the full record');
});

test('the character budget bounds what enters the session log, but never drops the newest line',()=>{
  const meta={startedAt:0,endedAt:null,state:'recording',segments:3} as MeetingMeta;
  const entries=[
    {line:1,ts:0,startMs:0,endMs:1,text:'A'.repeat(CONTEXT_CHARS)},
    {line:2,ts:1,startMs:1,endMs:2,text:'B'.repeat(200)},
    {line:3,ts:2,startMs:2,endMs:3,text:'C'.repeat(50)},
  ];
  const text=renderMeetingSnapshot(meta,entries,10);
  assert.ok(text.includes('C'.repeat(50)),'the newest line survives');
  assert.ok(!text.includes('A'.repeat(CONTEXT_CHARS)),'an oversized older line is dropped');
  const only={startedAt:0,endedAt:null,state:'recording',segments:1} as MeetingMeta;
  assert.ok(renderMeetingSnapshot(only,[entries[0]!],10).includes('A'.repeat(CONTEXT_CHARS)),'a single oversized line is still shown');
});

test('the snapshot is injected as a superseding producer snapshot, not as something the user said',async()=>{
  const f=fixture();try{
    f.word('先把目录理一遍',0);
    const log=listener();
    const feed=new MeetingContextFeed(f.store,stubCtx(log),()=>1_000_000+10_000);
    assert.equal(await feed.refresh(f.meta),true);
    assert.equal(log.injected.length,1);
    const message=log.injected[0]!;
    assert.equal(message.role,'user');
    // 断言的是"宿主认得出这条是我们发的"（`isProducerSource`），而不是某一种拼写：
    // 写死拼写正是这条用例上一版的毛病（`{kind:'plugin'}` 在格式 v4 上直接拒收）。
    assert.ok(isProducerSource(message.source,'dsh-plugin-meeting-assistant'),
      `这条来源两个版本都该认得出是我们发的：${JSON.stringify(message.source)}`);
    assert.equal((message.source as {form:string}).form,'snapshot','only a snapshot supersedes the previous one');
    const sections=(message.source as unknown as {sections:{name:string;text:string}[]}).sections;
    assert.equal(sections.length,1);assert.equal(sections[0]!.name,CONTEXT_SECTION);
    assert.match(sections[0]!.text,/先把目录理一遍/);
    assert.match((message.content[0] as {text:string}).text,/会议「/);
  }finally{f.cleanup();}
});

test('refresh is throttled, skips unchanged meetings, and always lands the closing state',async()=>{
  const f=fixture();try{
    let clock=1_000_000;
    const log=listener();
    const feed=new MeetingContextFeed(f.store,stubCtx(log),()=>clock);
    assert.equal(await feed.refresh(f.meta),true,'the opening snapshot always lands');

    clock+=CONTEXT_INTERVAL_MS-1;
    assert.equal(await feed.refresh(f.meta),false,'inside the interval nothing is pushed');
    clock+=1_000;
    assert.equal(await feed.refresh(f.meta),false,'a quiet meeting pushes nothing even after the interval');

    f.word('预算还有二十万',0);clock+=CONTEXT_INTERVAL_MS;
    assert.equal(await feed.refresh(f.meta),true,'new transcript past the interval is pushed');

    f.meta.state='stopped';f.meta.endedAt=clock;
    assert.equal(await feed.refresh(f.meta),true,'the closing state is pushed regardless of the clock');
    assert.match((log.injected.at(-1)!.content[0] as {text:string}).text,/已结束/);
    assert.equal(log.injected.length,3);
  }finally{f.cleanup();}
});

test('a session with no live agent is skipped silently rather than throwing into the tick',async()=>{
  const f=fixture();try{
    f.word('随便一句',0);
    const feed=new MeetingContextFeed(f.store,stubCtx(undefined),()=>1_000_000);
    assert.equal(await feed.refresh(f.meta),false);

    // A Codex/mesh session still has a DSH agent object, but recordings are not
    // required to; a target without `inject` must not be assumed to have one.
    const hollow=new MeetingContextFeed(f.store,stubCtx({}),()=>1_000_000);
    assert.equal(await hollow.refresh(f.meta),false);
  }finally{f.cleanup();}
});

test('a new recording in the same session pushes its opening snapshot immediately',async()=>{
  const f=fixture();try{
    let clock=1_000_000;
    const log=listener();
    const feed=new MeetingContextFeed(f.store,stubCtx(log),()=>clock);
    await feed.refresh(f.meta);
    f.meta.state='stopped';await feed.refresh(f.meta);
    // A second recording starts well inside the interval; without `forget` its
    // opening view would be withheld for up to a minute.
    feed.forget(f.meta.sessionId);
    f.meta.state='recording';f.meta.endedAt=null;
    assert.equal(await feed.refresh(f.meta),true);
    assert.notEqual(log.injected.length,0);
  }finally{f.cleanup();}
});

test('MESH_VOICE_CONTEXT=off keeps meeting content out of the conversation record',async()=>{
  const f=fixture();try{
    f.word('不该进入会话的一句',0);
    const log=listener();
    process.env.MESH_VOICE_CONTEXT='off';
    try{
      const feed=new MeetingContextFeed(f.store,stubCtx(log),()=>1_000_000);
      assert.equal(await feed.refresh(f.meta),false);
      assert.equal(log.injected.length,0);
      // The pull route is a separate tool and must keep working.
      const {entries}=await f.store.read(f.meta.sessionId,{recordingId:f.meta.id});
      assert.equal(entries[0]!.text,'不该进入会话的一句');
    }finally{delete process.env.MESH_VOICE_CONTEXT;}
  }finally{f.cleanup();}
});
