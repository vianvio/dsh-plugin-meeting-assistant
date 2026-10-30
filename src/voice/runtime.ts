import {resolve} from 'node:path';
import type {Context} from '@deepseek-ai/cordis';
import {MeetingService} from './service.js';
import {MeetingStore,type MeetingMeta} from './store.js';
import {MeetingCoach} from './coach.js';
import {MeetingContextFeed} from './context.js';
import type {GenerateAdvice} from './coach-types.js';
import {diag} from './host-diag.js';

export const MEETING_RELOAD_GRACE_MS=5000;
type Binding={ctx:Context;generate:GenerateAdvice;feed:MeetingContextFeed};
type Options={createStream?:ConstructorParameters<typeof MeetingService>[1];releaseDelayMs?:number};
type Runtime={service:MeetingService;coach:MeetingCoach;owners:Map<symbol,Binding>;current?:Binding;timer?:ReturnType<typeof setTimeout>;releaseDelayMs:number;closing?:Promise<void>};
// V2 must not reuse a pre-cancellation-fix coach left alive by an earlier package.
const registry=globalThis as unknown as {__dshMeetingRuntimesV2?:Map<string,Runtime>};
const runtimes=registry.__dshMeetingRuntimesV2??(registry.__dshMeetingRuntimesV2=new Map());

/** A recording belongs to the host, while each plugin application leases its UI/model bindings. */
export function acquireMeetingRuntime(root:string,ctx:Context,generate:GenerateAdvice,options:Options={}){
  const key=`${process.env.DSH_PROFILE_DIR??''}\u0000${resolve(root)}`;
  let runtime=runtimes.get(key);
  const reused=!!runtime;
  if(!runtime){
    const owners=new Map<symbol,Binding>();
    let created:Runtime;
    const safe=(meta:MeetingMeta,work:()=>void)=>{try{work();}catch(error){try{created.coach.reportError(meta,error);}catch{diag.warn('voice.advice','会议分析状态暂不可用');}}};
    const sync=(meta:MeetingMeta)=>{
      const binding=created.current;if(!binding)return;
      void binding.feed.refresh(meta).catch(error=>diag.warn('voice.context','会议上下文暂未同步',{error:error instanceof Error?error.message:String(error)}));
    };
    const coach=new MeetingCoach(new MeetingStore(root),(input,signal,sessionId)=>{
      const binding=created.current;
      if(!binding)throw new Error('会议分析正在重新连接，请稍后重试。');
      return binding.generate(input,signal,sessionId);
    });
    const service=new MeetingService(root,options.createStream,{
      started:meta=>{coach.started(meta);created.current?.feed.forget(meta.sessionId);sync(meta);},
      transcribed:(meta,entry)=>safe(meta,()=>coach.transcribed(meta,entry)),
      tick:meta=>{if(created.current)safe(meta,()=>coach.tick(meta));sync(meta);},
      stopped:meta=>sync(meta),
    });
    created={service,coach,owners,releaseDelayMs:options.releaseDelayMs??MEETING_RELOAD_GRACE_MS};
    runtime=created;runtimes.set(key,runtime);
  }
  const active=runtime;
  if(active.timer!==undefined){clearTimeout(active.timer);active.timer=undefined;}
  const id=Symbol('meeting owner'),binding:Binding={ctx,generate,feed:new MeetingContextFeed(active.service.store,ctx)};
  if(active.current)active.coach.suspend();
  active.owners.set(id,binding);active.current=binding;active.coach.resume();
  if(reused)diag.info('voice.lifecycle','会议运行时已接续',{recordingId:active.service.active?.meta.id??null,owners:active.owners.size});
  const shutdown=()=>{
    if(active.closing)return active.closing;
    if(active.timer!==undefined){clearTimeout(active.timer);active.timer=undefined;}
    if(runtimes.get(key)===active)runtimes.delete(key);
    active.current=undefined;
    // Recording finalization must not wait for a provider that ignores model cancellation.
    active.closing=Promise.allSettled([active.coach.dispose(),active.service.dispose()]).then(results=>{
      for(const result of results)if(result.status==='rejected')diag.warn('voice.lifecycle','会议运行时收尾失败',{error:String(result.reason)});
    });
    return active.closing;
  };
  let released=false;
  const release=()=>{
    if(released)return;released=true;
    active.owners.delete(id);
    if(active.current!==binding)return;
    active.coach.suspend();
    active.current=[...active.owners.values()].at(-1);
    if(active.current){active.coach.resume();return;}
    diag.info('voice.lifecycle','会议插件正在重载，等待录音接续',{recordingId:active.service.active?.meta.id??null,graceMs:active.releaseDelayMs});
    active.timer=setTimeout(()=>{active.timer=undefined;if(!active.owners.size)void shutdown();},active.releaseDelayMs);
    active.timer.unref?.();
  };
  return {service:active.service,coach:active.coach,release,reused};
}
