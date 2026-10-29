import type {Context} from '@deepseek-ai/cordis';
import {createUserMessage,type UserMessage} from '@deepseek-ai/dsh-llm';
import {MeetingStore,type MeetingMeta,type TranscriptEntry} from './store.js';
import {sessionAgent} from './services.js';
import {sourceFor} from '../shared/host-source.js';

/**
 * Keeps the conversation aware of a meeting that is being recorded.
 *
 * The transcript reaches the session agent by two routes. `voice_log` is the
 * pull route: exact, complete, and paid for only when the model decides to ask.
 * This feed is the push route: it keeps the agent aware without being asked, and
 * it reaches only a session whose agent is live in this process.
 */
export const CONTEXT_INTERVAL_MS=60_000;
/** A snapshot is current state, not an archive: carry the tail, not the meeting. */
const CONTEXT_LINES=20;
export const CONTEXT_CHARS=4000;
/** The named section this producer contributes. A later snapshot replaces it. */
export const CONTEXT_SECTION='meeting-transcript';
/**
 * `MESH_VOICE_CONTEXT=off` turns the push route off.
 *
 * Injected text becomes part of the session's durable log, so this is the switch
 * for anyone who wants meeting content to stay out of the conversation record —
 * `voice_log` still reaches it on demand.
 */
const disabled=()=>process.env.MESH_VOICE_CONTEXT==='off';

/** The injected surface this feed needs; a real `Agent` satisfies it. */
type InjectionTarget={inject(message:UserMessage):void};

const clock=(ms:number)=>new Date(ms).toLocaleTimeString('zh-CN',{hour12:false});
const elapsed=(from:number,to:number)=>{const seconds=Math.max(0,Math.floor((to-from)/1000));return `${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`;};

/**
 * Render the model-facing snapshot text.
 *
 * Bounded on purpose: whatever this returns is appended to the session's durable
 * log, so it has to stay a *view* of the meeting rather than a copy of it. The
 * full transcript stays on disk and behind `voice_log`.
 */
export function renderMeetingSnapshot(meta:MeetingMeta,entries:readonly TranscriptEntry[],now:number):string{
  const closed=meta.state==='stopped'||meta.state==='error';
  const head=`会议「${clock(meta.startedAt)} 开始」${closed?'已结束':'进行中'} · 已转写 ${meta.segments} 句 · 时长 ${elapsed(meta.startedAt,meta.endedAt??now)}`;
  if(!entries.length)return `${head}\n（尚无转写内容）`;
  let budget=CONTEXT_CHARS;const lines:string[]=[];
  for(const entry of [...entries].reverse()){
    // Always keep the newest line even when it alone exceeds the budget: a
    // snapshot with no transcript in it would be worse than one over budget.
    if(lines.length&&budget-entry.text.length<0)break;
    budget-=entry.text.length;
    lines.unshift(`[${elapsed(meta.startedAt,entry.ts)}] ${entry.text}`);
  }
  const omitted=meta.segments-lines.length;
  return `${head}${omitted>0?`\n（仅列出最近 ${lines.length} 句，此前 ${omitted} 句未列出；需要更早或更完整的内容请用 voice_log）`:''}\n${lines.join('\n')}`;
}

export class MeetingContextFeed {
  private last=new Map<string,{line:number;at:number}>();
  constructor(private store:MeetingStore,private ctx:Context,private now=()=>Date.now()){}
  /** Drop the throttle memory for a session, so a new recording's opening snapshot always lands. */
  forget(sessionId:string){this.last.delete(sessionId);}
  /**
   * Push the current view into the session, when it is worth pushing.
   *
   * Cheap when it declines: the throttle and the unchanged-line check both
   * resolve before any file read.
   * @returns whether a snapshot was injected.
   */
  async refresh(meta:MeetingMeta):Promise<boolean>{
    if(disabled())return false;
    const agent=sessionAgent(this.ctx,meta.sessionId) as InjectionTarget|undefined;
    if(!agent?.inject)return false;
    const previous=this.last.get(meta.sessionId),now=this.now();
    // A closed recording is worth one final snapshot whatever the clock says:
    // it is what stops the conversation from holding a stale "进行中".
    const closed=meta.state==='stopped'||meta.state==='error';
    if(previous&&!closed){
      if(now-previous.at<CONTEXT_INTERVAL_MS)return false;
      if(meta.segments<=previous.line)return false;
    }
    const {entries}=await this.store.read(meta.sessionId,{recordingId:meta.id,tail:true,lines:CONTEXT_LINES});
    const text=renderMeetingSnapshot(meta,entries,now);
    // 来源按 v4 的写法（生产者自有 kind）构造；判据与所有注入点共用
    // `plugin-shared/host-source.ts`。
    agent.inject(createUserMessage({
      content:[{type:'text',text}],
      source:sourceFor('dsh-plugin-meeting-assistant',{form:'snapshot',sections:[{name:CONTEXT_SECTION,text}]}),
    } as never));
    this.last.set(meta.sessionId,{line:meta.segments,at:now});
    return true;
  }
}
