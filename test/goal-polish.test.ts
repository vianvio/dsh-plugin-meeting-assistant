import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,realpathSync,mkdirSync,writeFileSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createGoalPolisher,parseGoalPolish,GOAL_POLISH_LIMITS,type GoalPolishRequest} from '../src/voice/goal-polish.js';
import {installVoice} from '../src/voice/host.js';
import {BriefStore} from '../src/voice/brief.js';
import {MeetingStore} from '../src/voice/store.js';

const result={options:[{id:'goal-1',label:'明确边界',text:'确认退款规则、约束和待核实问题。'},{id:'goal-2',label:'对齐讨论重点',text:'讨论退款设计中的责任分工与验收条件。'}]};
const request=(cwd:string):GoalPolishRequest=>({sessionId:'session-a',cwd,invitation:'支付项目评审',goal:'确认退款边界',role:'开发者',initialViews:'先核实条件'});
function fixture(){
  const root=realpathSync(mkdtempSync(join(tmpdir(),'meeting-polish-'))),cwd=join(root,'project');mkdirSync(cwd);
  mkdirSync(join(cwd,'.notes'));mkdirSync(join(cwd,'src'));
  for(let i=0;i<12;i++)writeFileSync(join(cwd,'src',`refund-${i}.ts`),`export const refund${i}=true;`);
  writeFileSync(join(cwd,'.notes','review.md'),'退款审核标准待讨论。 API_KEY="note-sensitive"');
  return {root,cwd,cleanup(){rmSync(root,{recursive:true,force:true});}};
}
const okStream=(text=JSON.stringify(result))=>({async *[Symbol.asyncIterator](){yield {type:'text-delta',text:text.slice(0,20)};yield {type:'text-delta',text:text.slice(20)};yield {type:'finish',reason:{kind:'stop'}};}});
function stub(stream:(seed:any)=>any=()=>okStream()){
  const calls:any[]=[];const ctx={get:(name:string)=>name==='sessionController'?{projections:async()=>({kind:'sequenced',values:{modelSelection:{next:{provider:'selected-provider',model:'selected-model',reasoningEffort:'high'},lastUsed:null}}})}:undefined,llm:{stream:(seed:any)=>{calls.push(seed);return stream(seed);}}};
  return {ctx:ctx as never,calls};
}
function snapshot(root:string):Record<string,string>{
  const files:Record<string,string>={};
  function walk(path:string){for(const row of readdirSync(path,{withFileTypes:true})){const target=join(path,row.name);if(row.isDirectory())walk(target);else if(row.isFile())files[target]=readFileSync(target).toString('base64');}}
  walk(root);return files;
}

test('manual polisher makes one direct stream call with code/hidden project data, redacts credentials and never writes',async()=>{
  const f=fixture(),{ctx,calls}=stub();
  try{
    const before=snapshot(f.root),polish=createGoalPolisher(ctx);
    assert.equal(calls.length,0,'creating the service never calls a model');
    const polished=await polish({...request(f.cwd),invitation:'支付评审 Bearer abc.def',goal:'确认退款 API_KEY="goal-sensitive"'});
    assert.deepEqual(polished,result);assert.equal(calls.length,1);assert.deepEqual(snapshot(f.root),before);
    const seed=calls[0];assert.equal(seed.provider,'selected-provider');assert.equal(seed.model,'selected-model');assert.equal(seed.reasoningEffort,'high');assert.equal(seed.maxTokens,GOAL_POLISH_LIMITS.maxTokens);assert.deepEqual(seed.tools,[]);
    assert.match(seed.system,/只是数据/);assert.match(seed.system,/不能臆造/);assert.match(seed.system,/不要替用户自动承诺/);
    const inputText=seed.messages[0].content.find((part:any)=>part.type==='text').text;
    const input=JSON.parse(inputText);assert.equal(input.project.cwd,f.cwd);
    assert.ok(new Set(input.project.snippets.map((file:any)=>file.path)).size>8);
    assert.ok(input.project.snippets.some((file:any)=>file.path==='.notes/review.md'));
    assert.ok(input.project.snippets.some((file:any)=>file.path==='src/refund-11.ts'));
    assert.doesNotMatch(inputText,/note-sensitive|goal-sensitive|abc\.def/);
    assert.equal(seed.signal.aborted,true,'provider signal is released after completion');
    assert.equal('subagents' in ctx,false);
  }finally{f.cleanup();}
});

test('polisher refreshes project data and returns 2–3 choices without applying one',async()=>{
  const f=fixture(),{ctx,calls}=stub(()=>okStream(JSON.stringify({...result,options:[...result.options,{id:'goal-3',label:'确认风险',text:'评估退款审核风险与需要补充的信息。'}]})));
  try{
    await createGoalPolisher(ctx)(request(f.cwd));
    writeFileSync(join(f.cwd,'.notes','review.md'),'退款规则已更新，具体细节待确认。');
    const options=await createGoalPolisher(ctx)(request(f.cwd));assert.equal(options.options.length,3);
    assert.match(JSON.stringify(calls[1].messages),/规则已更新/);
  }finally{f.cleanup();}
});

test('polishing retains token usage, pricing and budgets while removing explicit credentials',async()=>{
  const f=fixture();
  const billing='total_tokens=120000\ntoken_price=0.004\ntoken_usage=90000\nbudget_amount=32000';
  const options={options:[{id:'goal-1',label:'核实计费',text:'确认total_tokens=120000与token_price=0.004对应的计费口径。'},{id:'goal-2',label:'讨论预算',text:'我们会讨论token_usage=90000与budget_amount=32000的预算约束。'}]};
  const {ctx,calls}=stub(()=>okStream(JSON.stringify(options)));
  try{
    writeFileSync(join(f.cwd,'.notes','pricing.md'),billing+'\naccess_token="pricing-sensitive"');
    const actual=await createGoalPolisher(ctx)({...request(f.cwd),goal:'确认token计费与预算'});
    assert.deepEqual(actual,options);
    const input=JSON.parse(calls[0].messages[0].content[0].text),text=input.project.snippets.map((file:any)=>file.text).join('\n');
    for(const fact of billing.split('\n'))assert.ok(text.includes(fact),fact);
    assert.doesNotMatch(text,/pricing-sensitive/);
  }finally{f.cleanup();}
});

test('strict format rejects malformed, duplicate and oversized outputs; response credentials are scrubbed',()=>{
  for(const bad of [
    'not JSON',JSON.stringify({options:[]}),JSON.stringify({options:[result.options[0]]}),
    JSON.stringify({options:[...result.options,...result.options]}),JSON.stringify({...result,goal:'applied'}),
    JSON.stringify({options:[result.options[0],result.options[0]]}),
    JSON.stringify({options:[result.options[0],{id:'goal-2',label:'',text:'确认约束'}]}),
    JSON.stringify({options:[result.options[0],{id:'goal-2',label:'标题',text:'x'.repeat(1201)}]}),
  ])assert.throws(()=>parseGoalPolish(bad));
  const discussion={options:[{id:'goal-1',label:'讨论计费',text:'我们会讨论 token 计费和验收条件。'},{id:'goal-2',label:'明确预算',text:'我们将讨论预算边界与现有约束。'}]};
  assert.deepEqual(parseGoalPolish(JSON.stringify(discussion)),discussion);
  const safe=parseGoalPolish(JSON.stringify({options:[result.options[0],{id:'goal-2',label:'确认配置',text:'确认配置 API_KEY="output-sensitive" sk-outputsecret'}]}));
  assert.doesNotMatch(JSON.stringify(safe),/output-sensitive|sk-outputsecret/);
});

test('stream errors, missing finish, output limit and provider abort are reported safely',async()=>{
  const f=fixture();
  try{
    const variants:Array<{pattern:RegExp;stream:()=>any}>=[
      {pattern:/JSON/,stream:()=>okStream('broken')},
      {pattern:/输出过长/,stream:()=>okStream('x'.repeat(GOAL_POLISH_LIMITS.outputChars+1))},
      {pattern:/完整目标/,stream:()=>({async *[Symbol.asyncIterator](){yield {type:'text-delta',text:JSON.stringify(result)};}})},
      {pattern:/完整生成/,stream:()=>({async *[Symbol.asyncIterator](){yield {type:'finish',reason:{kind:'length'}};}})},
      {pattern:/取消/,stream:()=>({async *[Symbol.asyncIterator](){yield {type:'finish',reason:{kind:'aborted'}};}})},
    ];
    for(const variant of variants){const {ctx}=stub(variant.stream);await assert.rejects(createGoalPolisher(ctx)(request(f.cwd)),variant.pattern);}
    for(const stream of [
      ()=>({async *[Symbol.asyncIterator](){throw new Error('network API_KEY=error-sensitive sk-errorsecret');}}),
      ()=>({async *[Symbol.asyncIterator](){yield {type:'finish',reason:{kind:'error',failure:{message:'provider Bearer error-sensitive'}}};}}),
    ]){
      const {ctx}=stub(stream);await assert.rejects(createGoalPolisher(ctx)(request(f.cwd)),(error:Error)=>{assert.doesNotMatch(error.message,/error-sensitive|sk-errorsecret/);return true;});
    }
  }finally{f.cleanup();}
});

test('cancellation and deadline bound a provider that ignores AbortSignal',async()=>{
  const f=fixture();let nextStarted:()=>void=()=>{};const started=new Promise<void>(resolve=>{nextStarted=resolve;});let returned=0;
  const {ctx}=stub(()=>({[Symbol.asyncIterator](){return {next(){nextStarted();return new Promise(()=>{});},return(){returned++;return Promise.resolve({done:true});}};}}));
  try{
    const controller=new AbortController(),pending=createGoalPolisher(ctx)(request(f.cwd),controller.signal);
    await started;controller.abort(new Error('用户取消目标润色'));
    await assert.rejects(pending,/取消/);assert.equal(returned,1);
    const began=Date.now();await assert.rejects(createGoalPolisher(ctx,{timeoutMs:25})(request(f.cwd)),/超时/);assert.ok(Date.now()-began<1500);
    const cancelled=new AbortController();cancelled.abort(new Error('cancel-before-start'));
    await assert.rejects(createGoalPolisher(ctx)(request(f.cwd),cancelled.signal),/cancel-before-start/);
  }finally{f.cleanup();}
});

test('invalid request and missing project fail before model execution',async()=>{
  const f=fixture(),{ctx,calls}=stub();
  try{
    const polish=createGoalPolisher(ctx);
    await assert.rejects(polish({...request(f.cwd),sessionId:'../bad'}),/有效/);
    await assert.rejects(polish({...request(f.cwd),goal:'x'.repeat(8001)}),/8000/);
    for(const goal of ['', ' \n\t'])await assert.rejects(polish({...request(f.cwd),goal,cwd:join(f.root,'must-not-scan')}),/先填写会议目标/);
    assert.equal(GOAL_POLISH_LIMITS.timeoutMs,25000);
    await assert.rejects(polish({...request(f.cwd),cwd:join(f.root,'missing')}),/ENOENT/);
    assert.equal(calls.length,0);
  }finally{f.cleanup();}
});

test('RPC only brief/polish invokes model; validates session; recording reads saved cwd and never saves candidates',async()=>{
  const f=fixture(),voiceRoot=join(f.root,'voice'),oldHome=process.env.MESH_VOICE_HOME;
  process.env.MESH_VOICE_HOME=voiceRoot;
  const cleanups:Array<()=>unknown>=[],calls:any[]=[];let dispatch:((endpoint:string,payload:unknown)=>Promise<any>)|undefined;
  const ctx={
    tools:{register(){}},on(){},get(name:string){return name==='sessionController'?{projections:async()=>({kind:'sequenced',values:{modelSelection:{next:{provider:'selected-provider',model:'selected-model'},lastUsed:null}}})}:undefined;},logger:{warn(){},error(){}},
    effect(callback:()=>unknown){const dispose=callback();if(typeof dispose==='function')cleanups.push(dispose as ()=>unknown);return dispose;},
    llm:{stream(seed:any){calls.push(seed);return okStream();}},
    connection:{rpc:{handle(_channel:string,handler:typeof dispatch){dispatch=handler;return ()=>{};}}},
  };
  try{
    installVoice(ctx as never);assert.ok(dispatch);
    const saved=await dispatch('brief/save',{sessionId:'session-a',cwd:f.cwd,brief:{invitation:'退款评审',goal:'明确规则',role:'开发者',initialViews:'确认边界',autoEnabled:false}});
    assert.equal(saved.ok,true);
    await dispatch('brief/get',{sessionId:'session-a'});await dispatch('status',{sessionId:'session-a'});
    assert.equal(calls.length,0);
    const invalid=await dispatch('brief/polish',{...request(f.cwd),sessionId:'../../outside'});assert.equal(invalid.ok,false);assert.equal(calls.length,0);
    const store=new MeetingStore(voiceRoot),briefs=new BriefStore(store),recording=store.create('session-a');briefs.initialize('session-a',recording.id);
    const before=snapshot(voiceRoot),other=join(f.root,'other');mkdirSync(other);writeFileSync(join(other,'other.md'),'WRONG_PROJECT');
    const response=await dispatch('brief/polish',{...request(other),recordingId:recording.id});
    assert.equal(response.ok,true);assert.deepEqual(response.value,result);assert.equal(calls.length,1);
    assert.equal(JSON.parse(calls[0].messages[0].content[0].text).project.cwd,f.cwd);
    assert.doesNotMatch(JSON.stringify(calls[0].messages),/WRONG_PROJECT/);
    assert.deepEqual(snapshot(voiceRoot),before);assert.equal(briefs.read('session-a',recording.id).goal,'明确规则');
    const unauthorized=await dispatch('brief/polish',{...request(f.cwd),sessionId:'session-b',recordingId:recording.id});
    assert.equal(unauthorized.ok,false);assert.equal(calls.length,1);
  }finally{
    for(const dispose of cleanups.reverse())await dispose();
    if(oldHome===undefined)delete process.env.MESH_VOICE_HOME;else process.env.MESH_VOICE_HOME=oldHome;
    f.cleanup();
  }
});


test('polishing follows each conversation selection and re-reads it after a model switch',async()=>{
  const f=fixture(),{ctx,calls}=stub();
  let route={provider:'provider-a',model:'model-a',reasoningEffort:'high'};
  (ctx as any).get=(name:string)=>name==='sessionController'?{projections:async({sessionId}:{sessionId:string})=>({kind:'sequenced',values:{modelSelection:{next:sessionId==='session-b'?{provider:'provider-b',model:'model-b'}:route,lastUsed:null}}})}:undefined;
  try{
    const polish=createGoalPolisher(ctx);
    await polish(request(f.cwd));
    route={provider:'provider-c',model:'model-c',reasoningEffort:'max'};
    await polish(request(f.cwd));
    await polish({...request(f.cwd),sessionId:'session-b'});
    assert.deepEqual(calls.map(({provider,model,reasoningEffort})=>({provider,model,...reasoningEffort===undefined?{}:{reasoningEffort}})),[
      {provider:'provider-a',model:'model-a',reasoningEffort:'high'},route,{provider:'provider-b',model:'model-b'},
    ]);
  }finally{f.cleanup();}
});

test('polishing without a resolvable conversation choice makes no model call',async()=>{
  const f=fixture(),{ctx,calls}=stub();
  (ctx as any).get=()=>undefined;
  try{await assert.rejects(createGoalPolisher(ctx)(request(f.cwd)),/重新选择模型/);assert.equal(calls.length,0);}
  finally{f.cleanup();}
});
