import assert from 'node:assert/strict';
import test from 'node:test';
import {conversationModel} from '../src/voice/conversation-model.js';
import {meetingAdviceModel} from '../src/voice/coach-model.js';

const a={provider:'provider-a',model:'model-a',reasoningEffort:'high'};
const b={provider:'provider-b',model:'model-b',reasoningEffort:'low'};
const view=(next:unknown,lastUsed:unknown=null)=>({kind:'sequenced',values:{modelSelection:{next,lastUsed}}});
function context(read:(id:string,signal:AbortSignal)=>unknown,extra:Record<string,unknown>={}){
  const reads:string[]=[],streams:any[]=[];
  const services={sessionController:{projections:async({sessionId}:{sessionId:string},signal:AbortSignal)=>{reads.push(sessionId);return read(sessionId,signal);}},...extra};
  return {ctx:{get:(key:string)=>(services as Record<string,unknown>)[key],llm:{stream(seed:any){streams.push(seed);return {async *[Symbol.asyncIterator](){yield {type:'text-delta',text:'{"summary":"ok"}'};yield {type:'finish',reason:{kind:'stop'}};}};}}} as never,reads,streams};
}
const signal=()=>new AbortController().signal;

test('reads a pending choice before any request and snapshots provider/model/effort together',async()=>{
  const selected={...a,credential:'must-not-be-propagated'};
  const {ctx,reads}=context(()=>view(selected,{provider:'old',model:'old'}));
  const actual=await conversationModel(ctx,'fresh-session',signal());
  assert.deepEqual(actual,a);selected.provider='changed';
  assert.deepEqual(actual,a);assert.deepEqual(reads,['fresh-session']);
});

test('each new run re-reads selection and distinct conversations remain isolated',async()=>{
  let selected={...a};
  const {ctx}=context(id=>view(id==='session-b'?b:selected));
  assert.deepEqual(await conversationModel(ctx,'session-a',signal()),a);
  assert.deepEqual(await Promise.all([conversationModel(ctx,'session-a',signal()),conversationModel(ctx,'session-b',signal())]),[a,b]);
  selected={...b};
  assert.deepEqual(await conversationModel(ctx,'session-a',signal()),b);
  const result=await Promise.all([conversationModel(ctx,'session-b',signal()),conversationModel(ctx,'session-a',signal())]);
  assert.deepEqual(result,[b,b]);
});

test('only a known session with no model history may use the same default displayed by DSH',async()=>{
  let defaults={...a};const {ctx}=context(()=>view(null),{agentDefaultModel:{currentSelection:()=>defaults}});
  assert.deepEqual(await conversationModel(ctx,'new-session',signal()),a);
  defaults={...b};
  assert.deepEqual(await conversationModel(ctx,'new-session',signal()),b);
});

test('absent, stale and malformed projections never silently select another provider',async t=>{
  for(const [label,value] of [
    ['missing session',null],['migration hint',{kind:'migration-required',values:{modelSelection:{next:a}}}],
    ['missing projection',{kind:'sequenced',values:{}}],
    ['malformed selection',view({provider:'',model:'broken'})],
    ['partial selection',view({provider:'a'})],
    ['invalid effort',view({...a,reasoningEffort:4})],
    ['missing next',{kind:'sequenced',values:{modelSelection:{lastUsed:null}}}],
    ['inconsistent last used',view(null,a)],
  ] as const)await t.test(label,async()=>{
    const {ctx,streams}=context(()=>value,{agentDefaultModel:{currentSelection:()=>b},agents:{get:()=>({options:b,session:{requestHeader:()=>({config:b})}})}});
    await assert.rejects(conversationModel(ctx,'session-a',signal()),/重新选择模型/);
    assert.equal(streams.length,0);
  });
});

test('missing session controller or missing default is actionable and does not invent a model',async()=>{
  await assert.rejects(conversationModel({get:()=>undefined} as never,'session-a',signal()),/重新选择模型/);
  const {ctx}=context(()=>view(null));
  await assert.rejects(conversationModel(ctx,'session-a',signal()),/重新选择模型/);
});

test('selection reads honor cancellation even when the host ignores AbortSignal',async()=>{
  let began!:()=>void;const ready=new Promise<void>(resolve=>{began=resolve;});
  const {ctx,reads}=context(()=>{began();return new Promise(()=>{});});
  const controller=new AbortController(),reason=new Error('cancel model lookup');
  const pending=conversationModel(ctx,'session-a',controller.signal);
  await ready;controller.abort(reason);await assert.rejects(pending,error=>error===reason);
  const already=new AbortController();already.abort(reason);
  await assert.rejects(conversationModel(ctx,'session-a',already.signal),error=>error===reason);
  assert.deepEqual(reads,['session-a']);
});

test('direct advice follows per-session choices and changes model on the next run',async()=>{
  let current={...a};const {ctx,streams}=context(id=>view(id==='session-b'?b:current));
  const generate=meetingAdviceModel(ctx),input={system:'system',prompt:'prompt'};
  const first=await generate(input,signal(),'session-a');
  assert.deepEqual(first,{text:'{"summary":"ok"}',provider:a.provider,model:a.model});
  current={...b};
  await generate(input,signal(),'session-a');await generate(input,signal(),'session-b');
  assert.deepEqual(streams.map(({provider,model,reasoningEffort})=>({provider,model,reasoningEffort})),[a,b,b]);
});

test('forked advice overrides stale Agent creation options with the current UI choice',async()=>{
  const starts:any[]=[];
  const parent={options:{provider:'old-provider',model:'old-model'},session:{id:'session-a'}};
  const {ctx,streams}=context(()=>view(b),{agents:{get:()=>parent},subagents:{async startActivation(spec:any){starts.push(spec);return {result:Promise.resolve({stopReason:'completed',structured:{summary:'ok'}}),dispose:async()=>{}};}}});
  const output=await meetingAdviceModel(ctx)({system:'sys',prompt:'prompt'},signal(),'session-a');
  assert.deepEqual(starts[0].request.agentOptions,b);assert.equal(starts[0].request.parent,parent);
  assert.deepEqual(output,{text:'{"summary":"ok"}',provider:b.provider,model:b.model});
  assert.equal(streams.length,0);
});

test('an unresolvable conversation never starts either advice backend',async()=>{
  let starts=0;const {ctx,streams}=context(()=>null,{agents:{get:()=>({})},subagents:{startActivation(){starts++;}}});
  await assert.rejects(meetingAdviceModel(ctx)({system:'sys',prompt:'prompt'},signal(),'missing'),/重新选择模型/);
  assert.equal(streams.length,0);assert.equal(starts,0);
});


test('a model switch cannot change the provider or effort of an in-flight run',async()=>{
  let current={...a},release!:()=>void,entered!:()=>void;
  const ready=new Promise<void>(resolve=>{entered=resolve;});
  const pending=new Promise<void>(resolve=>{release=resolve;});
  const services={sessionController:{projections:async()=>view(current)}};
  const seeds:any[]=[];
  const ctx={get:(name:string)=>(services as any)[name],llm:{stream(seed:any){seeds.push(seed);return {async *[Symbol.asyncIterator](){entered();await pending;yield {type:'text-delta',text:'{"summary":"done"}'};yield {type:'finish',reason:{kind:'stop'}};}};}}};
  const generate=meetingAdviceModel(ctx as never),input={system:'sys',prompt:'prompt'};
  const first=generate(input,signal(),'session-a');await ready;current={...b};release();
  assert.deepEqual(await first,{text:'{"summary":"done"}',provider:a.provider,model:a.model});
  await generate(input,signal(),'session-a');
  assert.deepEqual(seeds.map(({provider,model,reasoningEffort})=>({provider,model,reasoningEffort})),[a,b]);
});

test('fork explicitly clears a historical effort when the current selection uses the model default',async()=>{
  const starts:any[]=[];
  const parent={options:{provider:'provider-a',model:'model-a',reasoningEffort:'high'},session:{id:'session-a'}};
  const {ctx}=context(()=>view({provider:'provider-a',model:'model-a'}),{agents:{get:()=>parent},subagents:{async startActivation(spec:any){starts.push(spec);return {result:Promise.resolve({stopReason:'completed',structured:{summary:'ok'}}),dispose:async()=>{}};}}});
  await meetingAdviceModel(ctx)({system:'sys',prompt:'prompt'},signal(),'session-a');
  const options=starts[0].request.agentOptions;
  assert.ok(Object.hasOwn(options,'reasoningEffort'));
  assert.equal(options.reasoningEffort,undefined);
  assert.deepEqual({...parent.options,...options},{provider:'provider-a',model:'model-a',reasoningEffort:undefined});
});
