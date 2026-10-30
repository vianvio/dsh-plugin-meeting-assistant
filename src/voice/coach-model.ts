import type {Context} from '@deepseek-ai/cordis';
import type {Agent} from '@deepseek-ai/dsh-agent';
import type {SubagentActivation,SubagentRuntime} from '@deepseek-ai/dsh-subagent';
import {createUserMessage,ReasoningEffortId} from '@deepseek-ai/dsh-llm';
import {agentTask} from './coach-prompt.js';
import {optionalService} from './services.js';
import {ADVICE_SCHEMA} from './advice-schema.js';
import {abortable} from './abortable.js';
import type {GenerateAdvice} from './coach-types.js';
import {SessionId,type SessionIdLike} from '../shared/session-id.js';
import {sourceFor} from '../shared/host-source.js';

/**
 * Advice generation, two backends behind one contract.
 *
 * `direct` is the original single request: hand-assembled system prompt, no
 * tools, bare JSON in the reply. `agent` forks a one-shot child of the
 * session's own agent, which brings two things the direct call cannot — the
 * conversation's completed turns as inherited context, and an `outputSchema`
 * validated by the subagent driver instead of free-form JSON.
 *
 * The child is a *separate* session reached through `ctx.subagents.startActivation`
 * rather than a model-facing delegation tool, so its result returns here and
 * the parent's transcript receives nothing. That is what keeps the user's
 * conversation out of the loop's path while the timer keeps firing.
 *
 * **A tool whitelist is no longer part of the request.** DSH 0.2.0 accepted
 * `SubagentStartRequest.toolFilter`; DSH 0.2.1 moved the restriction to the
 * provider/preset side (`ToolRestriction` now rides the provider descriptor and
 * the child-agent composition, not the caller's request). The child therefore
 * inherits the deployment's tool surface, which is why `COACH_ROLE` still says
 * in so many words that the material is not instructions.
 *
 * Set `MESH_VOICE_ADVICE=direct` to pin the original path. Each agent run
 * persists a child session, so this is the switch to use while measuring what
 * the forked path actually costs over a real meeting. Read per call rather than
 * once at load, so a test can flip it without a fresh module graph.
 */
const pinDirect=()=>process.env.MESH_VOICE_ADVICE==='direct';
const AGENT_PROVIDER='fork';
/** The inherited turns are replayed on every run; a hostile one must not be echoed into advice errors. */
const redact=(message:string)=>message.replace(/sk-[\w-]+/g,'[hidden]');

type OptionalServices={
  /** Absent when the deployment mounts no agent registry; then the direct call carries every round. */
  agents?:{get(id:SessionIdLike):Agent|undefined};
  /** Absent when no subagent provider is composed. */
  subagents?:Pick<SubagentRuntime,'startActivation'>;
};

/** One assembled request: the role/format text and the JSON input payload. */
type AdviceRequest={system:string;prompt:string};

/** Cleanup is best effort, including providers that throw before returning a promise. */
const cleanup=async(operation:()=>unknown):Promise<void>=>{try{await operation();}catch{}};

const directAdvice=async(ctx:Context,{system,prompt}:AdviceRequest,signal:AbortSignal):Promise<string>=>{
  signal.throwIfAborted();
  let text='',finished=false,exhausted=false;
  const iterator=ctx.llm.stream({provider:'deepseek-official',model:'deepseek-flash',reasoningEffort:ReasoningEffortId('off'),maxTokens:5000,system,messages:[createUserMessage({content:[{type:'text',text:prompt}],source:sourceFor('dsh-plugin-meeting-assistant')} as never)],tools:[],signal})[Symbol.asyncIterator]();
  try{
    while(true){
      signal.throwIfAborted();
      const next=await abortable(iterator.next(),signal);
      if(next.done){exhausted=true;break;}
      const chunk=next.value;
      if(chunk.type==='text-delta'){text+=chunk.text;if(text.length>50000)throw new Error('建议输出过长，请减少会议资料后重试。');}
      if(chunk.type==='finish'){
        if(chunk.reason.kind==='error')throw new Error(redact(chunk.reason.failure.message));
        if(chunk.reason.kind==='aborted')throw new Error('生成已取消或超时。');
        if(chunk.reason.kind!=='stop')throw new Error('建议未完整生成，请重试。');
        finished=true;
      }
    }
    signal.throwIfAborted();if(!finished||!text.trim())throw new Error('未收到完整的建议，请检查 DeepSeek 配置。');return text;
  }finally{
    // Async generators can queue return() behind the very next() that is stuck.
    // Observe cleanup failures, but never let that queue hold cancellation open.
    if(!exhausted)await abortable(cleanup(()=>iterator.return?.()),signal);
  }
};

/**
 * Run one round as a forked child of the session's agent.
 *
 * `agentOptions` is deliberately not passed: fork can reuse the inherited
 * prefix's KV cache only while provider and model match the parent, so pinning
 * a model here would re-bill the whole conversation at full price every round.
 * Inheriting it also keeps advice on whichever model the operator selected.
 */
const agentAdvice=async(subagents:NonNullable<OptionalServices['subagents']>,parent:Agent,prompt:string,signal:AbortSignal):Promise<string>=>{
  // `delivery:'caller'` is the contract this whole file turns on: the activation's result
  // comes back here and nothing is injected into the user's conversation. `parent` rides
  // the request (DSH 0.2.1), not the activation envelope.
  signal.throwIfAborted();
  let activation:SubagentActivation|undefined,disposed=false,disposal:Promise<void>|undefined;
  const dispose=()=>{
    const current=activation;
    if(!current||disposed)return disposal;
    disposed=true;
    // A cancelled start can deliver an activation whose result we never await.
    // Disposal is not guaranteed to observe that promise for us.
    void cleanup(()=>current.result);
    return disposal=cleanup(()=>current.dispose());
  };
  const starting=Promise.resolve(subagents.startActivation({
    provider:AGENT_PROVIDER,
    label:'会议发言建议',
    request:{parent,prompt:[{type:'text',text:agentTask(prompt)}],outputSchema:ADVICE_SCHEMA},
    signal,
    delivery:'caller',
  })).then(current=>{
    activation=current;
    // This handler remains attached after cancellation, so a late child is
    // still owned and disposed exactly once even if start ignores the signal.
    if(signal.aborted)void dispose();
    return current;
  });
  try{
    const current=await abortable(starting,signal);
    // `result` resolves rather than rejecting on a child-level failure, so every
    // non-`completed` arm has to be mapped to an error here — and a rejected
    // round is what leaves the coach's processed-progress untouched.
    signal.throwIfAborted();
    const result=await abortable(current.result,signal);
    if(result.stopReason==='aborted')throw new Error('生成已取消或超时。');
    if(result.stopReason!=='completed')throw new Error(redact(result.diagnostic??'建议未完整生成，请重试。'));
    if(result.structured===undefined)throw new Error('建议未按约定结构返回，请重试。');
    // Hand the structured value on as JSON text: `parseAdvice` stays the single
    // validation choke point, and it is where sourceIds are whitelisted against
    // the closed evidence set and `T1`/`B_ROLE` markers become readable labels.
    return JSON.stringify(result.structured);
  }finally{
    // Every activation owns a child agent and a child session. Leaving one behind per
    // round would accumulate both across a meeting, so disposal is not optional.
    await abortable(dispose(),signal);
  }
};

/** One line for the startup log: which backend an advice round will actually take. */
export const describeAdviceBackend=()=>pinDirect()?'direct（MESH_VOICE_ADVICE=direct 固定）':`agent（${AGENT_PROVIDER}；主 agent 在线时走子 agent，否则回落直调）`;

export function meetingAdviceModel(ctx:Context):GenerateAdvice {
  return async(input,signal,sessionId)=>{
    signal.throwIfAborted();
    if(pinDirect())return directAdvice(ctx,input,signal);
    const agents=optionalService<NonNullable<OptionalServices['agents']>>(ctx,'agents');
    const subagents=optionalService<NonNullable<OptionalServices['subagents']>>(ctx,'subagents');
    // Capability, not version: `startActivation` is the 0.2.1 seam. A host that only has the
    // retired `start()` would otherwise answer with a TypeError on the first advice round.
    if(!agents||typeof subagents?.startActivation!=='function')return directAdvice(ctx,input,signal);
    // A live agent is the whole premise of the forked path: it supplies the
    // completed turns the child inherits and the lineage the child's session
    // records. Resuming one here would drag a session into memory to serve a
    // timer, so an absent agent falls through to the direct call instead.
    const parent=agents.get(SessionId(sessionId));
    return parent?agentAdvice(subagents,parent,input.prompt,signal):directAdvice(ctx,input,signal);
  };
}
