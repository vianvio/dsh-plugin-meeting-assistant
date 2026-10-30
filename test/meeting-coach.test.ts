import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,realpathSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {MeetingService} from '../src/voice/service.js';
import {MeetingStore} from '../src/voice/store.js';
import {MeetingCoach,automaticReason,countMeetingCharacters} from '../src/voice/coach.js';
import {BriefStore,listMeetingFiles} from '../src/voice/brief.js';
import {parseAdvice} from '../src/voice/coach-prompt.js';
import {saveConfig} from '../src/voice/config.js';
import type {AdviceContent,BriefDraft,CoachState} from '../src/voice/coach-types.js';
import type {StreamHooks} from '../src/vendor/voice-kernel/index.mjs';

const draft:BriefDraft={invitation:'项目评审，讨论周五发布。',role:'我是项目经理，只能协调，不能承诺额外预算。',initialViews:'先做小范围验证，再扩大范围。',filePaths:[],autoEnabled:true};
const content:AdviceContent={summary:'确认发布范围与资源边界。',askedOfMe:[{question:'周五能发布吗？',why:'会邀提到发布时间。',tactfulReply:'我理解大家希望尽快推进。建议先确认验收范围，我会协调现有资源并给出明确进度。',conciseReply:'先确认验收范围，再评估时间。',sources:['B_ROLE','B_INVITE','T1']}],askOthers:[{question:'这次发布的验收标准是什么？',purpose:'明确范围',timing:'讨论发布日期时',sources:['B_INVITE']}],uncertainties:['尚未确认可用资源。'],carryForward:'会议讨论周五发布，用户负责协调，不能承诺额外预算。'};
const baseline:CoachState={throughLine:0,coveredChars:0,lastSuccessAt:1_000_000,lastAttemptAt:0,failedThroughLine:-1,latestId:null,running:null,error:null,history:[]};
const flush=()=>new Promise<void>(resolve=>setImmediate(resolve));

function fixture(respectAbort=true,timeoutMs=90_000){
  const root=mkdtempSync(join(tmpdir(),'mesh-coach-')),workspace=join(root,'workspace');mkdirSync(workspace);
  const store=new MeetingStore(root),briefs=new BriefStore(store);let clock=1_000_000;
  const calls:{input:{system:string;prompt:string};resolve:(text:string)=>void;reject:(reason:Error)=>void}[]=[];
  const coach=new MeetingCoach(store,(input,signal)=>new Promise<string>((resolve,reject)=>{calls.push({input,resolve,reject});if(respectAbort)signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});}),()=>clock,timeoutMs);
  let hooks:StreamHooks;
  saveConfig(root,{apiKey:'fixture',wsBase:'wss://example.invalid/asr',model:'fixture'});
  const service=new MeetingService(root,(_config,callbacks)=>{hooks=callbacks;return {state:'connecting',startedAt:Date.now(),audioZeroWall:null,refeedMs:0,queuedBytes:0,async start(){this.state='ready';},sendAudio(){},async stop(){this.state='finished';},forceDrop(){this.state='failed';}};},{started:meta=>{meta.startedAt=clock;store.save(meta);coach.started(meta);},transcribed:(meta,entry)=>coach.transcribed(meta,entry),tick:meta=>coach.tick(meta)});
  return {root,workspace,store,briefs,coach,service,calls,async waitCalls(n:number){const deadline=Date.now()+1000;while(calls.length<n&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,2));assert.equal(calls.length,n);},advance(ms:number){clock+=ms;},sentence(text:string){hooks.onSentence({text,beginMs:0,endMs:1000,sentenceId:1,wallTs:clock});},async cleanup(){await coach.dispose();await service.dispose();rmSync(root,{recursive:true,force:true});}};
}

test('one trigger rule: time requires new text; simultaneous thresholds coalesce; cooldown and failure suppression apply',()=>{
  assert.equal(countMeetingCharacters(' A 中\n😀 '),3);
  assert.equal(automaticReason(baseline,0,0,1_400_000),null);
  assert.equal(automaticReason(baseline,1,499,1_299_999),null);
  assert.equal(automaticReason(baseline,1,499,1_300_000),'time');
  assert.equal(automaticReason(baseline,1,500,1_001_000),'characters');
  assert.equal(automaticReason(baseline,1,500,1_300_000),'characters');
  assert.equal(automaticReason({...baseline,lastAttemptAt:1_280_000},1,900,1_300_000),null);
  assert.equal(automaticReason({...baseline,failedThroughLine:1},1,900,1_400_000),null);
});

test('brief save binds project and text without scanning files; legacy snapshots stay readable',async()=>{
  const f=fixture();try{
    const paths=['../private.txt',...Array.from({length:12},(_,i)=>`missing-${i}.md`)];
    const saved=await f.briefs.save('a',f.workspace,{...draft,goal:'确认发布边界',filePaths:paths});
    assert.equal(saved.cwd,realpathSync(f.workspace));assert.equal(saved.goal,'确认发布边界');
    assert.deepEqual(saved.files,[]);assert.deepEqual(saved.filePaths,[]);assert.equal(f.calls.length,0);
    const record=f.store.create('a');f.briefs.initialize('a',record.id);
    assert.equal(f.briefs.read('a',record.id).cwd,saved.cwd);
    assert.equal(statSync(f.briefs.path('a',record.id)).mode&0o777,0o600);
    const legacy={...saved,filePaths:['old.md'],files:[{path:'old.md',size:10,text:'批准预算为两万元。',truncated:false,savedAt:1}]};
    delete (legacy as Partial<typeof legacy>).goal;
    writeFileSync(f.briefs.path('a',record.id),JSON.stringify(legacy));
    const migrated=f.briefs.read('a',record.id);
    assert.equal(migrated.goal,'');assert.match(migrated.files[0]!.text,/两万元/);
    assert.equal('text' in f.briefs.public(migrated).files[0]!,false);
    const updated=await f.briefs.save('a','/must-not-scan-or-rebind',{...draft,goal:'确认预算',filePaths:paths},record.id);
    assert.equal(updated.cwd,saved.cwd);assert.equal(updated.goal,'确认预算');assert.deepEqual(updated.files,[]);
    await assert.rejects(listMeetingFiles(f.workspace,'..'),/工作区/);
  }finally{await f.cleanup();}
});

test('automatic and manual share one job, snapshot their input, and preserve content arriving during generation',async()=>{
  const f=fixture();try{
    await f.briefs.save('a',f.workspace,draft);const {recording}=f.service.start('a');await flush();
    f.sentence('新'.repeat(500));await f.waitCalls(1);assert.equal(f.calls.length,1);assert.equal(f.coach.state(recording).running?.reason,'characters');
    assert.equal(f.coach.request('a',recording.id).reused,true);f.coach.tick(recording);assert.equal(f.calls.length,1);
    f.sentence('补'.repeat(100));const firstInput=JSON.parse(f.calls[0]!.input.prompt);assert.equal(firstInput.transcript.length,1);assert.equal(firstInput.context.find((c:any)=>c.sourceId==='B_ROLE').text,draft.role);
    f.calls[0]!.resolve(JSON.stringify(content));await f.coach.settled('a',recording.id);
    assert.equal(f.coach.state(recording).throughLine,1);assert.equal(f.coach.status(recording).pendingChars,100);
    f.advance(300_000);f.coach.tick(recording);await f.waitCalls(2);assert.equal(f.calls.length,2);assert.equal(f.coach.state(recording).running?.reason,'time');
    f.calls[1]!.resolve(JSON.stringify(content));await f.coach.settled('a',recording.id);assert.equal(f.coach.state(recording).throughLine,2);
    f.advance(300_000);f.coach.tick(recording);assert.equal(f.calls.length,2,'silence never generates another advice');
    assert.equal(f.service.active?.meta.state,'recording');
    const advice=f.coach.readAdvice('a',recording.id,f.coach.state(recording).latestId!);assert.equal(advice.content.askedOfMe[0]!.conciseReply,content.askedOfMe[0]!.conciseReply);
    assert.throws(()=>f.coach.readAdvice('b',recording.id,advice.id));
  }finally{await f.cleanup();}
});

test('manual requests consume the same progress; failed requests do not advance it or stop recording; cancel settles',async()=>{
  const f=fixture();try{
    await f.briefs.save('a',f.workspace,draft);const {recording}=f.service.start('a');await flush();f.sentence('内容'.repeat(50));
    f.coach.request('a',recording.id);await f.waitCalls(1);f.calls[0]!.reject(new Error('temporary failure'));await f.coach.settled('a',recording.id);
    assert.equal(f.coach.state(recording).throughLine,0);assert.equal(f.service.active?.meta.state,'recording');f.advance(300_000);f.coach.tick(recording);assert.equal(f.calls.length,1,'same failed input is not retried on a timer');
    f.coach.request('a',recording.id);await f.waitCalls(2);f.calls[1]!.resolve(JSON.stringify(content));await f.coach.settled('a',recording.id);assert.equal(f.coach.state(recording).throughLine,1);
    f.coach.tick(recording);assert.equal(f.calls.length,2);
    f.briefs.setAutomatic('a',recording.id,false);await f.briefs.save('a',f.workspace,{...draft,role:'更新职责'},recording.id);assert.equal(f.briefs.read('a',recording.id).autoEnabled,false,'saving background edits must not re-enable automatic advice');f.sentence('更'.repeat(600));f.advance(300_000);f.coach.tick(recording);assert.equal(f.calls.length,2);
    f.coach.request('a',recording.id);await f.waitCalls(3);f.coach.cancel('a',recording.id);await f.coach.settled('a',recording.id);assert.equal(f.coach.state(recording).running,null);assert.match(f.coach.state(recording).error!,/取消/);assert.equal(f.coach.state(recording).throughLine,1);
  }finally{await f.cleanup();}
});

test('editing a brief does not rewrite an in-flight snapshot or old advice; malformed output keeps last good advice',async()=>{
  const f=fixture();try{
    await f.briefs.save('a',f.workspace,draft);const {recording}=f.service.start('a');await flush();f.sentence('会议开始');f.coach.request('a',recording.id);await f.waitCalls(1);
    await f.briefs.save('a',f.workspace,{...draft,role:'新角色：技术顾问'},recording.id);f.calls[0]!.resolve(JSON.stringify(content));await f.coach.settled('a',recording.id);
    const firstId=f.coach.state(recording).latestId!;assert.equal(f.coach.readAdvice('a',recording.id,firstId).briefRevision,1);
    f.coach.request('a',recording.id);await f.waitCalls(2);assert.match(f.calls[1]!.input.prompt,/技术顾问/);f.calls[1]!.resolve('not json');await f.coach.settled('a',recording.id);assert.equal(f.coach.state(recording).latestId,firstId);
    const parsed=parseAdvice(JSON.stringify({...content,askedOfMe:[{...content.askedOfMe[0],sources:['T999','B_ROLE']}]}),[{id:'B_ROLE',label:'角色',excerpt:'技术顾问'}]);assert.deepEqual(parsed.askedOfMe[0]!.sources,['B_ROLE']);
  }finally{await f.cleanup();}
});


test('cancel immediately clears running state even when the provider ignores abort',async()=>{
  const f=fixture(false);try{
    await f.briefs.save('a',f.workspace,{...draft,autoEnabled:false});const {recording}=f.service.start('a');await flush();f.sentence('需要分析的内容');
    const request=f.coach.request('a',recording.id);await f.waitCalls(1);
    f.coach.cancel('a',recording.id);
    assert.equal(f.coach.state(recording).running,null,'cancel must not wait for the model result');
    assert.equal(f.coach.state(recording).latestId,null);assert.equal(f.coach.state(recording).throughLine,0);
    assert.equal(f.service.active?.meta.state,'recording');
    await f.coach.settled('a',recording.id);
  }finally{for(const call of f.calls)call.resolve(JSON.stringify(content));await flush();await f.cleanup();}
});

test('a cancelled late result cannot overwrite a newer successful analysis',async()=>{
  const f=fixture(false);try{
    await f.briefs.save('a',f.workspace,{...draft,autoEnabled:false});const {recording}=f.service.start('a');await flush();f.sentence('会议内容');
    const first=f.coach.request('a',recording.id);await f.waitCalls(1);f.coach.cancel('a',recording.id);
    const next=f.coach.request('a',recording.id);assert.equal(next.reused,false);await f.waitCalls(2);
    f.calls[1]!.resolve(JSON.stringify({...content,summary:'新的分析结果'}));await f.coach.settled('a',recording.id);
    f.calls[0]!.resolve(JSON.stringify({...content,summary:'过期分析结果'}));await flush();await flush();
    const state=f.coach.state(recording);assert.equal(state.latestId,next.jobId);assert.equal(state.history.length,1);
    assert.equal(f.coach.readAdvice('a',recording.id,state.latestId!).content.summary,'新的分析结果');assert.equal(state.error,null);
  }finally{for(const call of f.calls)call.resolve(JSON.stringify(content));await flush();await f.cleanup();}
});

test('an error from a cancelled analysis cannot clear its replacement running state',async()=>{
  const f=fixture(false);try{
    await f.briefs.save('a',f.workspace,{...draft,autoEnabled:false});const {recording}=f.service.start('a');await flush();f.sentence('会议内容');
    f.coach.request('a',recording.id);await f.waitCalls(1);f.coach.cancel('a',recording.id);
    const next=f.coach.request('a',recording.id);await f.waitCalls(2);
    f.calls[0]!.reject(new Error('late provider failure'));await flush();await flush();
    const state=f.coach.state(recording);assert.equal(state.running?.id,next.jobId);assert.equal(state.error,null);
    f.calls[1]!.resolve(JSON.stringify(content));await f.coach.settled('a',recording.id);
  }finally{for(const call of f.calls)call.resolve(JSON.stringify(content));await flush();await f.cleanup();}
});


async function bounded<T>(promise:Promise<T>){
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('analysis did not settle after cancellation')),1000);})]);}
  finally{if(timer!==undefined)clearTimeout(timer);}
}

test('a stale cancellation id cannot cancel a replacement task',async()=>{
  const f=fixture(false);try{
    await f.briefs.save('a',f.workspace,{...draft,autoEnabled:false});const {recording}=f.service.start('a');await flush();
    const first=f.coach.request('a',recording.id);await f.waitCalls(1);
    assert.equal(f.coach.cancel('a',recording.id,first.jobId).cancelled,true);
    const next=f.coach.request('a',recording.id);await f.waitCalls(2);
    assert.equal(f.coach.cancel('a',recording.id,first.jobId).cancelled,false);
    assert.equal(f.coach.state(recording).running?.id,next.jobId);
    assert.equal(f.coach.cancel('a',recording.id,next.jobId).cancelled,true);
    assert.equal(f.coach.cancel('a',recording.id,next.jobId).cancelled,false);
  }finally{for(const call of f.calls)call.resolve(JSON.stringify(content));await flush();await f.cleanup();}
});

test('cancel suppresses immediate automatic reanalysis of already available content',async()=>{
  const f=fixture(false);try{
    await f.briefs.save('a',f.workspace,draft);const {recording}=f.service.start('a');await flush();
    f.sentence('新'.repeat(500));await f.waitCalls(1);f.advance(120_000);f.sentence('已到达的内容');
    f.coach.cancel('a',recording.id);const state=f.coach.state(recording);
    assert.equal(state.failedThroughLine,recording.segments);assert.equal(state.lastAttemptAt,1_120_000);
    f.coach.tick(recording);await flush();assert.equal(f.calls.length,1);
    f.advance(60_001);f.coach.tick(recording);await flush();assert.equal(f.calls.length,1,'cancelled content alone never reopens the task');
    f.sentence('取消后的新信息');await f.waitCalls(2);
    f.calls[1]!.resolve(JSON.stringify(content));await f.coach.settled('a',recording.id);
  }finally{for(const call of f.calls)call.resolve(JSON.stringify(content));await flush();await f.cleanup();}
});

test('deadline clears a task even if the provider never returns',async()=>{
  const f=fixture(false,150);try{
    await f.briefs.save('a',f.workspace,{...draft,autoEnabled:false});const {recording}=f.service.start('a');await flush();
    f.coach.request('a',recording.id);await f.waitCalls(1);await bounded(f.coach.settled('a',recording.id));
    const state=f.coach.state(recording);assert.equal(state.running,null);assert.match(state.error!,/超时/);
    assert.equal(state.latestId,null);assert.equal(state.throughLine,0);assert.ok(f.service.active);
  }finally{for(const call of f.calls)call.resolve(JSON.stringify(content));await flush();await f.cleanup();}
});

test('dispose does not hang on a provider that ignores abort',async()=>{
  const f=fixture(false);try{
    await f.briefs.save('a',f.workspace,{...draft,autoEnabled:false});const {recording}=f.service.start('a');await flush();
    f.coach.request('a',recording.id);await f.waitCalls(1);
    await bounded(f.coach.dispose());assert.equal(f.coach.state(recording).running,null);
    assert.ok(f.service.active,'cancelling analysis does not stop the microphone service');
  }finally{for(const call of f.calls)call.resolve(JSON.stringify(content));await flush();await f.cleanup();}
});
