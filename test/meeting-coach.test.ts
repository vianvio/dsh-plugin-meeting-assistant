import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,symlinkSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {zipSync,strToU8} from 'fflate';
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

function fixture(){
  const root=mkdtempSync(join(tmpdir(),'mesh-coach-')),workspace=join(root,'workspace');mkdirSync(workspace);
  const store=new MeetingStore(root),briefs=new BriefStore(store);let clock=1_000_000;
  const calls:{input:{system:string;prompt:string};resolve:(text:string)=>void;reject:(reason:Error)=>void}[]=[];
  const coach=new MeetingCoach(store,(input,signal)=>new Promise<string>((resolve,reject)=>{calls.push({input,resolve,reject});signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});}),()=>clock);
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

test('selected workspace files are scoped, snapshotted and bounded; Word text is supported',async()=>{
  const f=fixture();try{
    writeFileSync(join(f.workspace,'brief.md'),'批准预算为两万元。');writeFileSync(join(f.root,'private.txt'),'OUTSIDE_SECRET');symlinkSync(join(f.root,'private.txt'),join(f.workspace,'linked.txt'));
    const word=zipSync({'word/document.xml':strToU8('<w:document><w:p><w:r><w:t>周五 &amp; 试点</w:t></w:r></w:p></w:document>')});writeFileSync(join(f.workspace,'plan.docx'),word);
    const saved=await f.briefs.save('a',f.workspace,{...draft,filePaths:['brief.md','plan.docx']});assert.equal(saved.files[1]!.text.trim(),'周五 & 试点');
    const record=f.store.create('a');f.briefs.initialize('a',record.id);writeFileSync(join(f.workspace,'brief.md'),'文件已变化。');assert.match(f.briefs.read('a',record.id).files[0]!.text,/两万元/);
    assert.equal('text' in f.briefs.public(saved).files[0]!,false);assert.equal(statSync(f.briefs.path('a',record.id)).mode&0o777,0o600);
    await assert.rejects(f.briefs.save('a',f.workspace,{...draft,filePaths:['../private.txt']}),/工作区/);
    await assert.rejects(f.briefs.save('a',f.workspace,{...draft,filePaths:['linked.txt']}),/工作区以外/);
    await assert.rejects(listMeetingFiles(f.workspace,'..'),/工作区/);
    assert.equal((await listMeetingFiles(f.workspace)).entries.find(file=>file.name==='plan.docx')?.supported,true);
    await assert.rejects(f.briefs.save('a',f.workspace,{...draft,filePaths:Array(9).fill('brief.md')}),/8/);
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
