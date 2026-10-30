import assert from 'node:assert/strict';
import test from 'node:test';
import {getEventListeners} from 'node:events';
import {Context,Service} from '@deepseek-ai/cordis';
import type {Context as ContextType} from '@deepseek-ai/cordis';
import {assertObjectJsonSchema,validateJsonSchemaValue} from '@deepseek-ai/dsh-tools';
import {ADVICE_SCHEMA} from '../src/voice/advice-schema.js';
import {meetingAdviceModel} from '../src/voice/coach-model.js';
import {abortable} from '../src/voice/abortable.js';

const payload={summary:'确认发布范围与资源边界。',askedOfMe:[{question:'周五能发布吗？',why:'会邀提到发布时间。',tactfulReply:'我理解大家希望尽快推进。建议先确认验收范围。',conciseReply:'先确认验收范围，再评估时间。',sources:['B_ROLE','T1']}],askOthers:[{question:'验收标准是什么？',purpose:'明确范围',timing:'讨论日期时',sources:['B_INVITE']}],uncertainties:['尚未确认可用资源。'],carryForward:'会议讨论周五发布；用户负责协调，不能承诺额外预算。'};
const parent={session:{id:'session-a'}};
const run=(result:unknown)=>({result:Promise.resolve(result),dispose:async()=>{}});
const request={system:`SYS-ONLY\n不要调用工具。\n仅输出一个合法 JSON 对象，不使用 Markdown 代码块。格式：\n{"summary":"…"}`,prompt:'{"transcript":[{"sourceId":"T1","text":"周五发布"}]}'};
const okStream=()=>({async *[Symbol.asyncIterator](){yield {type:'text-delta',text:'{"summary":"直调"}',index:0};yield {type:'finish',reason:{kind:'stop'}};}});

type Started={provider:string;label:string;delivery:string;signal:AbortSignal;request:Record<string,any>};
function stubCtx(options:{agent?:unknown;startActivation?:(spec:Started)=>Promise<any>;stream?:()=>any}){
  const started:Started[]=[];const lookedUp:string[]=[];let disposed=0;let streamed=0;
  const run=(result:unknown)=>({result:Promise.resolve(result),dispose:async()=>{disposed++;}});
  // Cordis resolves `ctx.<name>` only for a declared dependency and THROWS
  // otherwise, so the services are reached through `ctx.get` and the stub models
  // exactly that — a plain property here would hide the bug this suite missed.
  const services:Record<string,unknown>={};
  if(options.agent!==undefined)services.agents={get:(id:string)=>{lookedUp.push(id);return options.agent;}};
  if(options.startActivation)services.subagents={startActivation:async(spec:Started)=>{started.push(spec);return options.startActivation!(spec);}};
  const ctx={
    get:(name:string)=>services[name],
    llm:{stream:(seed:any)=>{streamed++;return (options.stream??okStream)();}},
  } as unknown as ContextType;
  return {ctx,started,lookedUp,run,stats:()=>({disposed,streamed})};
}

test('the advice schema stays inside the enforced subset and bounds the value it is handed',()=>{
  assert.doesNotThrow(()=>assertObjectJsonSchema(ADVICE_SCHEMA));
  assert.deepEqual(validateJsonSchemaValue(ADVICE_SCHEMA,payload),[]);
  assert.notDeepEqual(validateJsonSchemaValue(ADVICE_SCHEMA,{summary:'只有摘要'}),[]);
  assert.notDeepEqual(validateJsonSchemaValue(ADVICE_SCHEMA,{...payload,askedOfMe:[{question:'q',why:'w',tactfulReply:'t',conciseReply:'c'}]}),[],'a question without sources is rejected');
});

test('a live session agent gets a forked one-shot child carrying the task, the schema, and an inherited route',async()=>{
  const parent={session:{id:'session-a'}};
  const {ctx,started,lookedUp,run,stats}=stubCtx({agent:parent,startActivation:async()=>run({stopReason:'completed',structured:payload})});
  const text=await meetingAdviceModel(ctx)(request,AbortSignal.timeout(5000),'session-a');
  assert.equal(text,JSON.stringify(payload));
  assert.deepEqual(lookedUp,['session-a'],'the parent is looked up by the recording session');
  assert.equal(started.length,1);assert.equal(started[0]!.provider,'fork');
  assert.equal(started[0]!.label,'会议发言建议');
  assert.equal(started[0]!.delivery,'caller','the result comes back here, not into the user conversation');
  assert.ok(started[0]!.signal instanceof AbortSignal,'the caller owns cancellation');
  assert.equal(started[0]!.request.parent,parent);
  assert.equal(started[0]!.request.outputSchema,ADVICE_SCHEMA);
  assert.equal('agentOptions' in started[0]!.request,false,'pinning a route would forfeit KV-cache reuse of the inherited turns');
  assert.equal('toolFilter' in started[0]!.request,false,
    'DSH 0.2.1 的子 agent 请求里没有 toolFilter（它挪到 provider/预设那一侧了）——再写进来就是死字段');
  const task=started[0]!.request.prompt[0].text as string;
  assert.match(task,/会议发言建议任务/);assert.match(task,/只读工具/);assert.match(task,/voice_log/);
  assert.doesNotMatch(task,/仅输出一个合法 JSON 对象/,'the child is told to call the structured-output tool, not to print JSON');
  assert.match(task,/transcript/);
  assert.deepEqual(stats(),{disposed:1,streamed:0});
});

test('every run is disposed, including one that fails and one whose structured value never arrived',async()=>{
  const failing=stubCtx({agent:{session:{id:'session-a'}},startActivation:async()=>failing.run({stopReason:'error',diagnostic:'boom sk-secretvalue'})});
  await assert.rejects(meetingAdviceModel(failing.ctx)(request,AbortSignal.timeout(5000),'session-a'),(error:Error)=>{
    assert.doesNotMatch(error.message,/sk-secretvalue/);assert.match(error.message,/boom/);return true;
  });
  assert.equal(failing.stats().disposed,1);

  const empty=stubCtx({agent:{session:{id:'session-a'}},startActivation:async()=>empty.run({stopReason:'completed'})});
  await assert.rejects(meetingAdviceModel(empty.ctx)(request,AbortSignal.timeout(5000),'session-a'),/结构/);
  assert.equal(empty.stats().disposed,1);
});

test('a cancelled run reports cancellation rather than a generic failure',async()=>{
  const {ctx,run}=stubCtx({agent:{session:{id:'session-a'}},startActivation:async()=>run({stopReason:'aborted'})});
  await assert.rejects(meetingAdviceModel(ctx)(request,AbortSignal.timeout(5000),'session-a'),/取消|超时/);
});

test('without a live agent — or without the services at all — the round falls back to the direct call',async()=>{
  for(const [label,build] of [['no live agent',()=>stubCtx({agent:undefined,stream:okStream})],['no subagent service',()=>stubCtx({agent:{session:{id:'session-a'}},stream:okStream})]] as const){
    const {ctx,stats}=build();
    const text=await meetingAdviceModel(ctx)(request,AbortSignal.timeout(5000),'session-a');
    assert.equal(text,'{"summary":"直调"}',label);
    assert.deepEqual(stats(),{disposed:0,streamed:1},label);
  }
});

test('MESH_VOICE_ADVICE=direct pins the original path even when the session agent is live',async()=>{
  process.env.MESH_VOICE_ADVICE='direct';
  try{
    const {ctx,started,stats}=stubCtx({agent:{session:{id:'session-a'}},startActivation:async()=>{throw new Error('the forked path must not run');},stream:okStream});
    const text=await meetingAdviceModel(ctx)(request,AbortSignal.timeout(5000),'session-a');
    assert.equal(text,'{"summary":"直调"}');
    assert.equal(started.length,0);
    assert.deepEqual(stats(),{disposed:0,streamed:1});
  }finally{delete process.env.MESH_VOICE_ADVICE;}
});

test('an empty inject still reaches the optional services — ctx.<name> would throw, ctx.get does not',async()=>{
  const started:Record<string,any>[]=[];let captured:string|undefined;let failure:unknown;
  const C=Context as any,S=Service as any;
  class FakeAgents extends S{constructor(ctx:any){super(ctx,'agents',{});}get(){return parent;}}
  class FakeSubagents extends S{constructor(ctx:any){super(ctx,'subagents',{});}async startActivation(spec:Record<string,any>){started.push(spec);return run({stopReason:'completed',structured:payload});}}
  let settle:()=>void=()=>{};const finished=new Promise<void>(resolve=>{settle=resolve;});
  const use:any=(ctx:any)=>{
    void (async()=>{
      await new Promise(resolve=>setTimeout(resolve,50));
      try{
        // The trap this guards against: cordis resolves a context property only
        // for a declared dependency, and neither service is declared on purpose.
        assert.throws(()=>{void ctx.agents;},/inject/);
        captured=await meetingAdviceModel(ctx)(request,AbortSignal.timeout(5000),'session-a');
      }catch(error){failure=error;}finally{settle();}
    })();
  };
  use.inject=[];
  const root=new C();
  root.plugin(FakeAgents);root.plugin(FakeSubagents);root.plugin(use);
  await finished;
  assert.equal(failure,undefined,failure instanceof Error?failure.message:String(failure));
  assert.equal(captured,JSON.stringify(payload));
  assert.equal(started.length,1,'the forked path ran without either service being injected');
});

function deferred<T=void>(){
  let resolve!:(value:T|PromiseLike<T>)=>void,reject!:(reason:unknown)=>void;
  const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});
  return {promise,resolve,reject};
}
const turn=()=>new Promise<void>(resolve=>setImmediate(resolve));
async function promptly<T>(operation:Promise<T>):Promise<T>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{
    return await Promise.race([operation,new Promise<never>((_,reject)=>{
      timer=setTimeout(()=>reject(new Error('cancellation or cleanup did not settle promptly')),1000);
    })]);
  }finally{clearTimeout(timer);}
}
const cancelled=(operation:Promise<unknown>,reason:unknown)=>promptly(assert.rejects(operation,error=>error===reason));

test('abortable preserves values and failures and releases listeners on every settlement',async()=>{
  const controller=new AbortController(),signal=controller.signal;
  assert.equal(await abortable(42,signal),42);
  assert.equal(getEventListeners(signal,'abort').length,0);
  const success=deferred<string>(),value=abortable(success.promise,signal);
  assert.equal(getEventListeners(signal,'abort').length,1);
  success.resolve('done');assert.equal(await value,'done');
  assert.equal(getEventListeners(signal,'abort').length,0);
  const failure=deferred<string>(),error=new Error('provider rejected'),failed=abortable(failure.promise,signal);
  assert.equal(getEventListeners(signal,'abort').length,1);
  const checked=assert.rejects(failed,rejection=>rejection===error);
  failure.reject(error);await checked;
  assert.equal(getEventListeners(signal,'abort').length,0);
  controller.abort();
  assert.equal(await value,'done','a later abort cannot change a settled value');
});

test('abortable cancels an uncooperative operation and observes late resolve or reject',async t=>{
  for(const late of ['resolve','reject'] as const)await t.test(late,async()=>{
    const controller=new AbortController(),operation=deferred<string>(),reason=new Error('cancel helper');
    const result=abortable(operation.promise,controller.signal);
    assert.equal(getEventListeners(controller.signal,'abort').length,1);
    const checked=cancelled(result,reason);controller.abort(reason);await checked;
    assert.equal(getEventListeners(controller.signal,'abort').length,0);
    if(late==='resolve')operation.resolve('late value');else operation.reject(new Error('late operation rejection'));
    await turn();
    await assert.rejects(result,error=>error===reason);
  });
});

test('abortable observes already-aborted promises and thenables without retaining listeners',async t=>{
  for(const late of ['resolve','reject'] as const)await t.test(late,async()=>{
    const controller=new AbortController(),operation=deferred<string>(),reason=new Error('already cancelled');
    controller.abort(reason);
    await cancelled(abortable(operation.promise,controller.signal),reason);
    assert.equal(getEventListeners(controller.signal,'abort').length,0);
    if(late==='resolve')operation.resolve('late');else operation.reject(new Error('late after already aborted'));
    await turn();
    await cancelled(abortable(Promise.reject(new Error('already rejected')),controller.signal),reason);
    let observed=false;
    const thenable={then:(_resolve:unknown,reject:(reason:unknown)=>void)=>{observed=true;reject(new Error('thenable rejected'));}};
    await cancelled(abortable(thenable as PromiseLike<never>,controller.signal),reason);
    assert.equal(observed,true);
    assert.equal(getEventListeners(controller.signal,'abort').length,0);
  });
});

test('an already-aborted request starts neither backend nor a parent lookup',async t=>{
  for(const backend of ['agent','direct'] as const)await t.test(backend,async()=>{
    const controller=new AbortController(),reason=new Error('cancel before provider');controller.abort(reason);
    const stub=stubCtx(backend==='agent'?{agent:parent,startActivation:async()=>run({stopReason:'completed',structured:payload})}:{});
    await cancelled(meetingAdviceModel(stub.ctx)(request,controller.signal,'session-a'),reason);
    assert.deepEqual(stub.started,[]);assert.deepEqual(stub.lookedUp,[]);
    assert.deepEqual(stub.stats(),{disposed:0,streamed:0});
    assert.equal(getEventListeners(controller.signal,'abort').length,0);
  });
});

test('a hung activation result cancels immediately even when dispose hangs, and late results stay observed',async t=>{
  for(const late of ['resolve','reject'] as const)await t.test(late,async()=>{
    const controller=new AbortController(),reason=new Error('cancel hung result');
    const result=deferred<any>(),reading=deferred(),disposal=deferred();let disposed=0;
    const activation={get result(){reading.resolve();return result.promise;},dispose:()=>{disposed++;return disposal.promise;}};
    const {ctx}=stubCtx({agent:parent,startActivation:async()=>activation});
    const work=meetingAdviceModel(ctx)(request,controller.signal,'session-a');
    await promptly(reading.promise);controller.abort(reason);await cancelled(work,reason);
    assert.equal(disposed,1);assert.equal(getEventListeners(controller.signal,'abort').length,0);
    if(late==='resolve')result.resolve({stopReason:'completed',structured:payload});else result.reject(new Error('late child failure'));
    await turn();assert.equal(disposed,1);
    // One cleanup is left forever pending; the other rejects after cancellation.
    if(late==='reject'){disposal.reject(new Error('late disposal failure'));await turn();}
    await assert.rejects(work,error=>error===reason);
  });
});

test('an activation arriving after cancelled start is disposed exactly once and its result is observed',async t=>{
  for(const late of ['resolve','reject','already rejected'] as const)await t.test(late,async()=>{
    const controller=new AbortController(),reason=new Error('cancel hung start');
    const starting=deferred<any>(),entered=deferred(),disposedSignal=deferred(),result=deferred<any>(),disposal=deferred();let disposed=0;
    const {ctx}=stubCtx({agent:parent,startActivation:()=>{entered.resolve();return starting.promise;}});
    const work=meetingAdviceModel(ctx)(request,controller.signal,'session-a');
    await promptly(entered.promise);controller.abort(reason);await cancelled(work,reason);
    assert.equal(disposed,0);assert.equal(getEventListeners(controller.signal,'abort').length,0);
    starting.resolve({result:late==='already rejected'?Promise.reject(new Error('unawaited child failure')):result.promise,dispose:()=>{disposed++;disposedSignal.resolve();return disposal.promise;}});
    await promptly(disposedSignal.promise);assert.equal(disposed,1);
    if(late==='resolve')result.resolve({stopReason:'completed',structured:payload});
    if(late==='reject')result.reject(new Error('late abandoned child failure'));
    disposal.reject(new Error('late abandoned dispose failure'));await turn();
    assert.equal(disposed,1);await assert.rejects(work,error=>error===reason);
  });
});

test('a cancelled start observes its late rejection',async()=>{
  const controller=new AbortController(),reason=new Error('cancel start before rejection'),starting=deferred<any>();
  const {ctx}=stubCtx({agent:parent,startActivation:()=>starting.promise});
  const work=meetingAdviceModel(ctx)(request,controller.signal,'session-a');
  controller.abort(reason);await cancelled(work,reason);
  starting.reject(new Error('late start rejection'));await turn();
  assert.equal(getEventListeners(controller.signal,'abort').length,0);
});

test('a provider aborting during start still has its returned activation disposed once',async()=>{
  const controller=new AbortController(),reason=new Error('abort inside start');let disposed=0;
  const {ctx}=stubCtx({agent:parent,startActivation:async()=>{
    controller.abort(reason);
    return {result:Promise.reject(new Error('abandoned result')),dispose:()=>{disposed++;throw new Error('sync disposal failure');}};
  }});
  await cancelled(meetingAdviceModel(ctx)(request,controller.signal,'session-a'),reason);
  await turn();assert.equal(disposed,1);
  assert.equal(getEventListeners(controller.signal,'abort').length,0);
});

test('cancellation also interrupts disposal already awaited after successful or failed generation',async t=>{
  for(const stopReason of ['completed','error'] as const)await t.test(stopReason,async()=>{
    const controller=new AbortController(),reason=new Error('cancel hung disposal'),disposing=deferred(),disposal=deferred();let disposed=0;
    const {ctx}=stubCtx({agent:parent,startActivation:async()=>({result:Promise.resolve({stopReason,structured:payload,diagnostic:'provider failed'}),dispose:()=>{disposed++;disposing.resolve();return disposal.promise;}})});
    const work=meetingAdviceModel(ctx)(request,controller.signal,'session-a');
    await promptly(disposing.promise);controller.abort(reason);await cancelled(work,reason);
    assert.equal(disposed,1);assert.equal(getEventListeners(controller.signal,'abort').length,0);
    disposal.reject(new Error('cleanup rejected after cancellation'));await turn();
  });
});

test('normal success and provider rejection dispose once even when cleanup throws or rejects',async t=>{
  for(const outcome of ['success','failure'] as const)for(const cleanupFailure of ['throw','reject'] as const)await t.test(`${outcome} / ${cleanupFailure}`,async()=>{
    const error=new Error('provider result rejected');let disposed=0;
    const {ctx}=stubCtx({agent:parent,startActivation:async()=>({
      result:outcome==='success'?Promise.resolve({stopReason:'completed',structured:payload}):Promise.reject(error),
      dispose:()=>{disposed++;if(cleanupFailure==='throw')throw new Error('sync dispose failure');return Promise.reject(new Error('async dispose failure'));},
    })});
    const controller=new AbortController(),work=meetingAdviceModel(ctx)(request,controller.signal,'session-a');
    if(outcome==='success')assert.equal(await work,JSON.stringify(payload));else await assert.rejects(work,rejection=>rejection===error);
    assert.equal(disposed,1);assert.equal(getEventListeners(controller.signal,'abort').length,0);await turn();
  });
});

test('direct next ignores abort but cancellation returns without waiting for iterator return',async t=>{
  for(const late of ['resolve','reject'] as const)for(const returnKind of ['hang','throw','reject'] as const)await t.test(`${late} / return ${returnKind}`,async()=>{
    const controller=new AbortController(),reason=new Error('cancel hung next'),next=deferred<any>(),entered=deferred(),closing=deferred();let reads=0,returned=0;
    const iterator={
      [Symbol.asyncIterator](){return this;},
      next(){reads++;if(reads===1)return Promise.resolve({done:false,value:{type:'text-delta',text:'partial'}});entered.resolve();return next.promise;},
      return(){returned++;if(returnKind==='throw')throw new Error('sync return failure');if(returnKind==='reject')return Promise.reject(new Error('async return failure'));return closing.promise;},
    };
    const {ctx,stats}=stubCtx({stream:()=>iterator});
    const work=meetingAdviceModel(ctx)(request,controller.signal,'session-a');
    await promptly(entered.promise);controller.abort(reason);await cancelled(work,reason);
    assert.equal(returned,1);assert.equal(reads,2);assert.equal(stats().streamed,1);
    assert.equal(getEventListeners(controller.signal,'abort').length,0);
    if(late==='resolve')next.resolve({done:false,value:{type:'finish',reason:{kind:'stop'}}});else next.reject(new Error('late next failure'));
    await turn();assert.equal(reads,2);assert.equal(returned,1);
    if(late==='reject'&&returnKind==='hang'){closing.reject(new Error('late return failure'));await turn();}
    await assert.rejects(work,error=>error===reason);
  });
});

test('direct cancellation can interrupt return already awaited after a stream error',async()=>{
  const controller=new AbortController(),reason=new Error('cancel hung iterator cleanup'),returning=deferred(),closing=deferred();let returned=0;
  const iterator={
    [Symbol.asyncIterator](){return this;},
    next:async()=>({done:false,value:{type:'finish',reason:{kind:'error',failure:{message:'provider failure'}}}}),
    return:()=>{returned++;returning.resolve();return closing.promise;},
  };
  const {ctx}=stubCtx({stream:()=>iterator});const work=meetingAdviceModel(ctx)(request,controller.signal,'session-a');
  await promptly(returning.promise);controller.abort(reason);await cancelled(work,reason);
  assert.equal(returned,1);assert.equal(getEventListeners(controller.signal,'abort').length,0);
  closing.reject(new Error('late failed iterator return'));await turn();
});

test('direct failures keep their error mapping and close the iterator',async t=>{
  for(const [reason,message] of [
    [{kind:'error',failure:{message:'boom sk-secretvalue'}},/boom \[hidden\]/],
    [{kind:'aborted'},/取消|超时/],
    [{kind:'length'},/未完整生成/],
  ] as const)await t.test(reason.kind,async()=>{
    let returned=0;
    const {ctx}=stubCtx({stream:()=>({async *[Symbol.asyncIterator](){try{yield {type:'finish',reason};}finally{returned++;}}})});
    const controller=new AbortController();
    await assert.rejects(meetingAdviceModel(ctx)(request,controller.signal,'session-a'),message);
    assert.equal(returned,1);assert.equal(getEventListeners(controller.signal,'abort').length,0);
  });
});
