import {createReadStream,existsSync,mkdirSync,readFileSync} from 'node:fs';
import {createInterface} from 'node:readline';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {BriefStore,writePrivateJson} from './brief.js';
import {MeetingStore,type MeetingMeta,type TranscriptEntry} from './store.js';
import {buildCoachInput,parseAdvice} from './coach-prompt.js';
import {COACH_RULE,type Advice,type AdviceIndex,type CoachState,type CoachStatus,type GenerateAdvice} from './coach-types.js';

export const countMeetingCharacters=(text:string)=>Array.from(text.replace(/\s/g,'')).length;
export function automaticReason(state:CoachState,latestLine:number,newChars:number,now:number):AdviceIndex['reason']|null {
  if(state.running||latestLine<=state.throughLine||latestLine<=state.failedThroughLine||(state.lastAttemptAt>0&&now-state.lastAttemptAt<COACH_RULE.cooldownMs))return null;
  if(newChars>=COACH_RULE.characters)return 'characters';
  if(newChars>0&&now-state.lastSuccessAt>=COACH_RULE.intervalMs)return 'time';return null;
}
type Running={controller:AbortController;promise:Promise<void>;id:string};
export class MeetingCoach {
  readonly briefs:BriefStore;
  private jobs=new Map<string,Running>();
  private totals=new Map<string,{line:number;characters:number}>();
  private disposed=false;
  constructor(readonly store:MeetingStore,private generate:GenerateAdvice,private now=Date.now){this.briefs=new BriefStore(store);}
  private key(meta:MeetingMeta){return `${meta.sessionId}/${meta.id}`;}
  private statePath(meta:MeetingMeta){return join(this.store.dir(meta.sessionId,meta.id),'coach-state.json');}
  private writeState(meta:MeetingMeta,state:CoachState){writePrivateJson(this.statePath(meta),state);}
  state(meta:MeetingMeta):CoachState {
    let state:CoachState={throughLine:0,coveredChars:0,lastSuccessAt:meta.startedAt,lastAttemptAt:0,failedThroughLine:-1,latestId:null,running:null,error:null,history:[]};
    try{state={...state,...JSON.parse(readFileSync(this.statePath(meta),'utf8'))};}catch{}
    if(state.running&&!this.jobs.has(this.key(meta))){state.running=null;state.error='上次建议生成因应用退出而中断，可手动重新生成。';state.failedThroughLine=meta.segments;this.writeState(meta,state);}
    return state;
  }
  started(meta:MeetingMeta){this.briefs.initialize(meta.sessionId,meta.id);this.totals.set(this.key(meta),{line:0,characters:0});this.writeState(meta,this.state(meta));}
  transcribed(meta:MeetingMeta,entry:TranscriptEntry){const total=this.totals.get(this.key(meta));if(total){total.line=entry.line;total.characters+=countMeetingCharacters(entry.text);}this.tick(meta);}
  tick(meta:MeetingMeta){
    if(this.disposed||!['recording','reconnecting','connecting'].includes(meta.state))return;
    if(!this.briefs.read(meta.sessionId,meta.id).autoEnabled)return;
    const total=this.totals.get(this.key(meta));if(!total)return;
    const state=this.state(meta),reason=automaticReason(state,total.line,Math.max(0,total.characters-state.coveredChars),this.now());
    if(reason)this.request(meta.sessionId,meta.id,reason);
  }
  status(meta:MeetingMeta):CoachStatus {
    const state=this.state(meta),total=this.totals.get(this.key(meta));
    return {...state,autoEnabled:this.briefs.read(meta.sessionId,meta.id).autoEnabled,pendingChars:total?Math.max(0,total.characters-state.coveredChars):null,pendingLines:Math.max(0,meta.segments-state.throughLine),rule:COACH_RULE};
  }
  readAdvice(sessionId:string,recordingId:string,id:string):Advice {
    this.store.get(sessionId,recordingId);if(!/^[0-9a-f-]{36}$/.test(id))throw new Error('无效的建议记录。');
    return JSON.parse(readFileSync(join(this.store.dir(sessionId,recordingId),'advice',id+'.json'),'utf8'));
  }
  request(sessionId:string,recordingId:string,reason:AdviceIndex['reason']='manual'){
    if(this.disposed)throw new Error('会议建议服务已关闭');
    const meta={...this.store.get(sessionId,recordingId)},key=this.key(meta);const existing=this.jobs.get(key);if(existing)return {accepted:true,jobId:existing.id,reused:true};
    const brief=this.briefs.read(sessionId,recordingId);
    if(!meta.segments&&!brief.invitation.trim()&&!brief.role.trim()&&!brief.initialViews.trim()&&!brief.files.length)throw new Error('请先填写会议背景，或等待一些转写内容。');
    const state=this.state(meta),id=randomUUID(),controller=new AbortController();
    const job:Running={id,controller,promise:Promise.resolve()};
    state.running={id,reason,startedAt:this.now(),throughLine:meta.segments,briefRevision:brief.revision};state.lastAttemptAt=this.now();state.error=null;this.writeState(meta,state);
    this.jobs.set(key,job);
    // Reserve the job synchronously before any asynchronous read or model call: manual and timers share this lock.
    job.promise=Promise.resolve().then(async()=>{
      try{
        const window=await this.window(meta,controller.signal);
        controller.signal.throwIfAborted();
        const previous=state.latestId?this.readAdvice(sessionId,recordingId,state.latestId).content:undefined;
        const input=buildCoachInput(brief,window.entries,previous,window.omittedLines);
        const response=await this.generate(input,AbortSignal.any([controller.signal,AbortSignal.timeout(90_000)]),meta.sessionId);controller.signal.throwIfAborted();
        const content=parseAdvice(response,input.evidence);
        const advice:Advice={id,reason,createdAt:this.now(),fromLine:window.entries[0]?.line??0,throughLine:meta.segments,briefRevision:brief.revision,content,evidence:input.evidence,omittedLines:window.omittedLines,model:'deepseek-flash'};
        const dir=join(this.store.dir(sessionId,recordingId),'advice');mkdirSync(dir,{recursive:true,mode:0o700});writePrivateJson(join(dir,id+'.json'),advice);
        const {content:_content,evidence:_evidence,model:_model,omittedLines:_omitted,...index}=advice;
        Object.assign(state,{throughLine:meta.segments,coveredChars:window.totalChars,lastSuccessAt:this.now(),latestId:id,running:null,error:null,failedThroughLine:-1,history:[index,...state.history].slice(0,30)});this.writeState(meta,state);
      }catch(error){state.running=null;state.failedThroughLine=meta.segments;state.error=controller.signal.aborted?'已取消本次生成。':`建议生成失败：${error instanceof Error?error.message.replace(/sk-[\w-]+/g,'[hidden]'):'请稍后重试'}`;try{this.writeState(meta,state);}catch{/* An advice-state disk failure must never terminate microphone capture. */}}
      finally{if(this.jobs.get(key)===job)this.jobs.delete(key);}
    });
    return {accepted:true,jobId:id,reused:false};
  }
  cancel(sessionId:string,recordingId:string){const meta=this.store.get(sessionId,recordingId);this.jobs.get(this.key(meta))?.controller.abort(new Error('用户取消生成'));return {cancelled:true};}
  reportError(meta:MeetingMeta,error:unknown){const state=this.state(meta);state.error=error instanceof Error?error.message:'建议暂时不可用';this.writeState(meta,state);}
  async settled(sessionId:string,recordingId:string){await this.jobs.get(`${sessionId}/${recordingId}`)?.promise;}
  private async window(meta:MeetingMeta,signal:AbortSignal){
    signal.throwIfAborted();
    const file=join(this.store.dir(meta.sessionId,meta.id),'transcript.jsonl');const entries:TranscriptEntry[]=[];let chars=0,totalChars=0,omittedLines=0;
    if(existsSync(file)){const stream=createReadStream(file,{encoding:'utf8',signal});const lines=createInterface({input:stream,crlfDelay:Infinity});
      try{for await(const raw of lines){signal.throwIfAborted();let entry:TranscriptEntry;try{entry=JSON.parse(raw);}catch{continue;}if(entry.line>meta.segments)break;
        totalChars+=countMeetingCharacters(entry.text);entries.push(entry);chars+=entry.text.length;
        while((chars>20000||entries.length>200)&&entries.length>1){chars-=entries.shift()!.text.length;omittedLines++;}
      }}finally{lines.close();stream.destroy();}}
    return {entries,totalChars,omittedLines};
  }
  async dispose(){this.disposed=true;for(const job of this.jobs.values())job.controller.abort(new Error('应用正在关闭'));await Promise.allSettled([...this.jobs.values()].map(job=>job.promise));}
}
