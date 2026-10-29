import type {Context} from '@deepseek-ai/cordis';
import type {Agent} from '@deepseek-ai/dsh-agent';
import {SessionId,type SessionIdLike} from '../shared/session-id.js';

/** The slice of the agent registry this plugin uses. */
type AgentRegistry={get(id:SessionIdLike):Agent|undefined};

/**
 * Read an optional service by name.
 *
 * `ctx.agents` is NOT interchangeable with this. Cordis resolves a context
 * property only for a declared dependency and THROWS
 * `cannot get property "agents" without inject` otherwise — not `undefined`.
 * Both services this plugin uses opportunistically are deliberately undeclared,
 * because declaring one is a load gate that would cost a deployment without a
 * subagent provider the whole panel, so every lookup goes through `ctx.get`,
 * which is the inject-free read.
 */
export const optionalService=<T>(ctx:Context,name:string):T|undefined=>{
  try{return ctx.get(name) as T|undefined;}catch{return undefined;}
};

/**
 * The session's live agent, or `undefined` when it is not in memory.
 *
 * Deliberately does not resume: dragging a session into memory to serve a timer
 * or a context refresh is not worth the ownership and lifetime it would create.
 * Callers fall back to behavior that needs no agent.
 */
export const sessionAgent=(ctx:Context,sessionId:string):Agent|undefined=>optionalService<AgentRegistry>(ctx,'agents')?.get(SessionId(sessionId));
