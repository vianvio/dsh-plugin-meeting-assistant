import type {Context} from '@deepseek-ai/cordis';
import type {ModelSelection} from '@deepseek-ai/dsh-agent';
import {abortable} from './abortable.js';
import {optionalService} from './services.js';

type ProjectionResult={kind:string;values?:{modelSelection?:{next?:unknown;lastUsed?:unknown}}};
type SessionModels={projections(request:{sessionId:string},signal:AbortSignal):Promise<ProjectionResult|null>};
type DefaultModel={currentSelection():unknown};
const UNAVAILABLE='无法读取当前对话选择的模型，请在该对话重新选择模型后重试。';

function snapshot(value:unknown):ModelSelection{
  if(!value||typeof value!=='object')throw new Error(UNAVAILABLE);
  const {provider,model,reasoningEffort}=value as Record<string,unknown>;
  if(typeof provider!=='string'||!provider.trim()||typeof model!=='string'||!model.trim()||
    (reasoningEffort!==undefined&&(typeof reasoningEffort!=='string'||!reasoningEffort.trim())))throw new Error(UNAVAILABLE);
  return {provider,model,...reasoningEffort===undefined?{}:{reasoningEffort:reasoningEffort as ModelSelection['reasoningEffort']}};
}

/**
 * Read the same durable selection used by the conversation selector, including
 * a model picked before its first request. Agent.options and requestHeader()
 * alone can both trail an explicit UI switch. Do not resume or wake an Agent.
 */
export async function conversationModel(ctx:Context,sessionId:string,signal:AbortSignal):Promise<ModelSelection>{
  signal.throwIfAborted();
  const sessions=optionalService<SessionModels>(ctx,'sessionController');
  if(typeof sessions?.projections!=='function')throw new Error(UNAVAILABLE);
  const view=await abortable(sessions.projections({sessionId},signal),signal);
  signal.throwIfAborted();
  if(view?.kind!=='sequenced'||!view.values?.modelSelection)throw new Error(UNAVAILABLE);
  const selected=view.values.modelSelection.next;
  if(selected!==null)return snapshot(selected);
  // A known, brand-new Session has no durable choice yet. DSH shows its current
  // default in the selector in that case; no plugin-owned fallback is allowed.
  if(view.values.modelSelection.lastUsed!==null)throw new Error(UNAVAILABLE);
  return snapshot(optionalService<DefaultModel>(ctx,'agentDefaultModel')?.currentSelection());
}
