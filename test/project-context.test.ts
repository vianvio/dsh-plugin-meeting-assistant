import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,realpathSync,mkdirSync,writeFileSync,readFileSync,rmSync,symlinkSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {zipSync,strToU8} from 'fflate';
import {loadProjectContext,PROJECT_CONTEXT_LIMITS,redactCredentials} from '../src/voice/project-context.js';
import {MeetingStore} from '../src/voice/store.js';
import {BriefStore} from '../src/voice/brief.js';
import {EMPTY_BRIEF,type BriefDraft,type AdviceContent} from '../src/voice/coach-types.js';
import {buildCoachInput,parseAdvice} from '../src/voice/coach-prompt.js';
import {MeetingCoach} from '../src/voice/coach.js';

const draft:BriefDraft={invitation:'支付设计评审',goal:'确认退款边界',role:'工程师',initialViews:'先明确约束',autoEnabled:false};
function fixture(){
  const root=realpathSync(mkdtempSync(join(tmpdir(),'meeting-project-'))),cwd=join(root,'workspace');mkdirSync(cwd);
  return {root,cwd,write(path:string,text:string|Uint8Array){mkdirSync(join(cwd,path,'..'),{recursive:true});writeFileSync(join(cwd,path),text);},cleanup(){rmSync(root,{recursive:true,force:true});}};
}
const advice:AdviceContent={summary:'确认退款限制',askedOfMe:[{question:'边界是什么？',why:'讨论退款',tactfulReply:'建议共同确认限制。',conciseReply:'先确认边界。',sources:['B_GOAL','F1']}],askOthers:[{question:'限制已确认吗？',purpose:'明确约束',timing:'讨论边界时',sources:['B_GOAL']}],uncertainties:['待核实'],carryForward:'退款边界待确认。'};

test('entire-project scope includes code, docs, hidden notes and more than eight files; text and symlink boundaries hold',async()=>{
  const f=fixture();
  try{
    for(let i=0;i<12;i++)f.write(`src/payment-${i}.ts`,`export const refundLimit${i} = ${i};`);
    f.write('.notes/decision.md','退款上限待审批。');f.write('docs/design.md','退款分为两步。');
    f.write('plan.docx',zipSync({'word/document.xml':strToU8('<w:document><w:p><w:r><w:t>退款会邀补充</w:t></w:r></w:p></w:document>')}));
    f.write('binary.dat',Buffer.from([0,255,1,0,5]));f.write('fake.md',Buffer.from([0xFF,0xFF]));f.write('picture.png',Buffer.from([137,80,78,71]));
    f.write('node_modules/dep.txt','DO_NOT_INCLUDE_DEPENDENCY');f.write('.git/config','DO_NOT_INCLUDE_GIT');
    const outside=join(f.root,'private.md');writeFileSync(outside,'OUTSIDE_SECRET');symlinkSync(outside,join(f.cwd,'link.md'));symlinkSync(f.root,join(f.cwd,'external-dir'));
    const context=await loadProjectContext(f.cwd,'退款 refundLimit');
    assert.equal(context.metadata.scope,'entire-project');assert.equal(context.metadata.partialContent,true);
    assert.ok(context.metadata.readFiles>=15);assert.ok(new Set(context.snippets.map(file=>file.path)).size>8);
    assert.ok(context.snippets.some(file=>file.path==='.notes/decision.md'));assert.ok(context.snippets.some(file=>file.path==='src/payment-11.ts'));
    assert.ok(context.snippets.some(file=>file.path==='plan.docx'&&file.text.includes('会邀补充')));
    assert.equal(context.metadata.skippedSymlinks,2);assert.equal(context.metadata.skippedBinaryFiles,3);
    assert.ok(context.metadata.excludedDirectories.includes('node_modules'));
    assert.doesNotMatch(JSON.stringify(context),/OUTSIDE_SECRET|DO_NOT_INCLUDE_DEPENDENCY|DO_NOT_INCLUDE_GIT/);
    assert.equal(context.index.some(row=>row.path.startsWith('node_modules')),false);
  }finally{f.cleanup();}
});

test('relevance selects interior passages within explicit content and scan budgets; every call sees updates',async()=>{
  const f=fixture();
  try{
    for(let i=0;i<100;i++)f.write(`docs/ordinary-${i}.md`,('普通项目背景。\n').repeat(600));
    f.write('src/refund.ts',('export const filler = 0;\n').repeat(300)+'\nREFUND_NEEDLE 退款不可跨账户。\n'+('export const tail = 0;\n').repeat(200));
    f.write('huge.txt','x'.repeat(PROJECT_CONTEXT_LIMITS.perFileBytes+10000));
    const context=await loadProjectContext(f.cwd,[Array.from({length:300},(_,i)=>`unrelated${i}`).join(' '),'其他会邀'.repeat(200),'REFUND_NEEDLE 退款']);
    assert.ok(context.snippets.some(file=>file.path==='src/refund.ts'&&file.text.includes('REFUND_NEEDLE')));
    assert.ok(context.snippets.find(file=>file.text.includes('REFUND_NEEDLE'))!.startLine>1);
    assert.ok(context.snippets.reduce((n,file)=>n+file.text.length,0)<=PROJECT_CONTEXT_LIMITS.contentChars);
    assert.ok(context.metadata.scannedBytes<=PROJECT_CONTEXT_LIMITS.scanBytes);
    assert.ok(context.metadata.truncatedFiles>0);assert.match(context.metadata.notice,/未读取全部/);
    f.write('src/refund.ts','REFUND_NEEDLE 最新约束：需要双人复核。');
    const updated=await loadProjectContext(f.cwd,'REFUND_NEEDLE');
    assert.ok(updated.snippets.some(file=>file.text.includes('双人复核')));
    assert.equal(updated.snippets.some(file=>file.text.includes('不可跨账户')),false);
  }finally{f.cleanup();}
});

test('large directory index and global I/O budgets are bounded and disclosed',async()=>{
  const large=fixture();
  try{
    const prefix='nested/'.repeat(22);
    for(let i=0;i<240;i++)large.write(`${prefix}${i}.txt`,'x'.repeat(i<40?260000:40));
    const context=await loadProjectContext(large.cwd,'');
    assert.equal(context.metadata.indexedFiles,240);
    assert.equal(context.metadata.indexTruncated,true);assert.equal(context.metadata.scanTruncated,true);
    assert.ok(context.metadata.scannedBytes<=PROJECT_CONTEXT_LIMITS.scanBytes);
    assert.ok(JSON.stringify(context.index).length<=PROJECT_CONTEXT_LIMITS.indexChars);
    assert.equal(context.metadata.contentTruncated,true);assert.ok(context.metadata.contentChars<=PROJECT_CONTEXT_LIMITS.contentChars);
    assert.ok(context.metadata.unreadFiles>0);assert.ok(context.metadata.warnings.length>0);
  }finally{large.cleanup();}
});

test('brief saves are lazy, migrate goal and keep recording cwd bound; legacy snapshots remain readable',async()=>{
  const f=fixture(),store=new MeetingStore(join(f.root,'store')),briefs=new BriefStore(store);
  try{
    const old={...EMPTY_BRIEF,revision:1,filePaths:['old.md'],files:[{path:'old.md',size:3,text:'旧资料快照',truncated:false,savedAt:1}]};delete (old as Partial<typeof old>).goal;
    mkdirSync(store.sessionRoot('session-a'),{recursive:true});writeFileSync(briefs.path('session-a'),JSON.stringify(old));
    assert.equal(briefs.read('session-a').goal,'');assert.equal(briefs.read('session-a').files[0]!.text,'旧资料快照');
    const saved=await briefs.save('session-a',f.cwd,{...draft,filePaths:['../does-not-exist',...Array(20).fill('unused.md')]});
    assert.equal(saved.goal,draft.goal);assert.deepEqual(saved.files,[]);assert.deepEqual(saved.filePaths,[]);
    assert.equal(statSync(briefs.path('session-a')).mode&0o777,0o600);
    const recording=store.create('session-a');briefs.initialize('session-a',recording.id);
    const preserved=await briefs.save('session-a','/missing/project',{...draft,goal:undefined},recording.id);
    assert.equal(preserved.cwd,f.cwd);assert.equal(preserved.goal,draft.goal);
    assert.equal(briefs.read('session-a',recording.id).goal,draft.goal);
    await assert.rejects(briefs.save('session-a',f.cwd,{...draft,goal:'x'.repeat(8001)}),/8000/);
    assert.equal(JSON.parse(readFileSync(briefs.path('session-a'),'utf8')).files.length,0);
  }finally{f.cleanup();}
});

test('advice separates B_GOAL, includes cwd/index/current snippets and retains legacy source references',async()=>{
  const f=fixture();
  try{
    f.write('src/refund.ts','const API_KEY="sensitive-value";\nexport const refund = true;');
    const project=await loadProjectContext(f.cwd,'refund');
    const brief={...EMPTY_BRIEF,...draft,goal:draft.goal!,cwd:f.cwd,files:[{path:'old.md',size:1,text:'旧计划',truncated:false,savedAt:1}]};
    const input=buildCoachInput(brief,[],undefined,0,project),parsed=JSON.parse(input.prompt);
    assert.equal(parsed.context.find((row:any)=>row.sourceId==='B_GOAL').text,draft.goal);
    assert.equal(parsed.project.cwd,f.cwd);assert.ok(parsed.project.index.some((row:any)=>row.path==='src/refund.ts'));
    assert.ok(input.evidence.some(row=>row.id==='P_INDEX'));assert.ok(input.evidence.some(row=>row.id==='B_GOAL'));
    assert.ok(parsed.files.some((row:any)=>row.path==='old.md'&&row.legacySnapshot));
    assert.doesNotMatch(input.prompt,/sensitive-value/);assert.doesNotMatch(JSON.stringify(input.evidence),/sensitive-value/);
    const parsedAdvice=parseAdvice(JSON.stringify(advice),input.evidence);assert.ok(parsedAdvice.askedOfMe[0]!.sources.includes('B_GOAL'));
    assert.equal(redactCredentials('Bearer abc.def API_KEY=abc sk-private github_pat_private').includes('abc'),false);
    const credentials='ACCESS_TOKEN=plain-token\nDATABASE_URL=postgres://user:database-password@example.invalid/db\n-----BEGIN OPENSSH PRIVATE KEY-----\nprivate-material\n-----END OPENSSH PRIVATE KEY-----';
    assert.doesNotMatch(redactCredentials(credentials),/plain-token|database-password|private-material/);
  }finally{f.cleanup();}
});

test('credential redaction preserves token pricing, usage and budget facts throughout project advice input',async()=>{
  const f=fixture();
  try{
    const billing=[
      'total_tokens = 120000', 'token_price = 0.004', 'token_usage = 90000',
      'input_tokens: 70000', 'output_tokens: 20000', 'budget_amount = 32000',
      'const tokenPrice = 0.004;', 'const totalTokens = 120000;', '预算金额为32000元。',
    ].join('\n');
    assert.equal(redactCredentials(billing),billing);
    const credentials=[
      'API_KEY="api-sensitive"', 'DASHSCOPE_API_KEY="provider-sensitive"',
      'access_token="access-sensitive"', 'refresh_token="refresh-sensitive"',
      'authorization="auth-sensitive"', 'password="password-sensitive"',
      'client_secret="client-sensitive"', 'const apiKey="camel-sensitive";',
      '{"config":{"total_tokens":120000,"api_key":"nested-sensitive","token_price":0.004}}',
    ].join('\n');
    f.write('.notes/pricing.md',billing+'\n'+credentials);
    const context=await loadProjectContext(f.cwd,'token计费 预算'),input=buildCoachInput({...EMPTY_BRIEF,cwd:f.cwd,goal:'确认token计费规则'},[],undefined,0,context);
    const text=JSON.parse(input.prompt).files.map((file:any)=>file.text).join('\n');
    for(const fact of billing.split('\n'))assert.ok(text.includes(fact),fact);
    assert.doesNotMatch(input.prompt,/(?:api|provider|access|refresh|auth|password|client|camel|nested)-sensitive/);
    assert.doesNotMatch(JSON.stringify(input.evidence),/-sensitive/);
  }finally{f.cleanup();}
});

test('advice loads fresh project contents per generation; scan/model failure never changes recording state',async()=>{
  const f=fixture(),store=new MeetingStore(join(f.root,'store'));const calls:Array<any>=[];
  const coach=new MeetingCoach(store,async(input)=>{calls.push(JSON.parse(input.prompt));return JSON.stringify(advice);});
  try{
    f.write('src/refund.ts','退款限制第一版。');
    await coach.briefs.save('session-a',f.cwd,draft);
    const recording=store.create('session-a');recording.state='recording';store.save(recording);coach.started(recording);
    assert.equal(calls.length,0,'start/status/get/save do not scan or call a model');
    coach.status(recording);coach.briefs.read('session-a',recording.id);assert.equal(calls.length,0);
    coach.request('session-a',recording.id);await coach.settled('session-a',recording.id);
    assert.ok(calls[0].files.some((row:any)=>row.text.includes('第一版')));
    f.write('src/refund.ts','退款限制第二版。');
    coach.request('session-a',recording.id);await coach.settled('session-a',recording.id);
    assert.ok(calls[1].files.some((row:any)=>row.text.includes('第二版')));
    const bound=coach.briefs.read('session-a',recording.id);bound.cwd=join(f.root,'missing');writeFileSync(coach.briefs.path('session-a',recording.id),JSON.stringify(bound));
    coach.request('session-a',recording.id);await coach.settled('session-a',recording.id);
    assert.ok(calls[2].project.metadata.warnings.length);assert.equal(store.get('session-a',recording.id).state,'recording');
    const failing=new MeetingCoach(store,async()=>{throw new Error('service API_KEY=private-value');});
    try{failing.request('session-a',recording.id);await failing.settled('session-a',recording.id);assert.equal(store.get('session-a',recording.id).state,'recording');assert.doesNotMatch(failing.state(recording).error!,/private-value/);}finally{await failing.dispose();}
  }finally{await coach.dispose();f.cleanup();}
});

test('project context rejects non-project cwd and cancellation before scanning',async()=>{
  await assert.rejects(loadProjectContext('../outside',''),/项目目录/);
  const f=fixture();try{const controller=new AbortController();controller.abort(new Error('cancelled fixture'));await assert.rejects(loadProjectContext(f.cwd,'',controller.signal),/cancelled/);}finally{f.cleanup();}
});
