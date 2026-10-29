import {randomUUID} from 'node:crypto';
import WebSocket from 'ws';
import {DashscopeAsrStream,ResilientAsrSession,type Stream,type StreamHooks} from '../vendor/voice-kernel/index.mjs';
import {readConfig,validateVoiceConfig,type VoiceConfig} from './config.js';
import {MeetingStore,type MeetingMeta,type TranscriptQuery,type TranscriptEntry} from './store.js';
import {diag} from './host-diag.js';

type Active={meta:MeetingMeta;token:string;session:ResilientAsrSession;lastAudio:number;nextSequence:number;timer:ReturnType<typeof setInterval>;stopping?:Promise<void>};
interface MeetingHooks {started?:(meta:MeetingMeta)=>void;transcribed?:(meta:MeetingMeta,entry:TranscriptEntry)=>void;tick?:(meta:MeetingMeta)=>void;stopped?:(meta:MeetingMeta)=>void}
export class MeetingService {
  readonly store:MeetingStore;
  active?:Active;
  private disposed=false;
  constructor(readonly root:string,private createStream:(config:VoiceConfig,hooks:StreamHooks)=>Stream=(config,hooks)=>new DashscopeAsrStream({...config,...hooks,wsFactory:(url,headers)=>new WebSocket(url,{headers})}),private hooks:MeetingHooks={}){this.store=new MeetingStore(root);}
  start(sessionId:string){
    if(this.disposed)throw new Error('会议服务已关闭');
    if(this.active)throw new Error('已有会议正在录音，请先关闭会议开关。');
    const config=validateVoiceConfig(readConfig(this.root));
    const meta=this.store.create(sessionId);this.store.select(sessionId,meta.id);const token=randomUUID();
    try{this.hooks.started?.(meta);}catch(error){meta.state='error';meta.endedAt=Date.now();meta.error='会议准备未完成';this.store.save(meta);throw error;}
    const redact=(message:string)=>message.split(config.apiKey).join('[redacted]').slice(0,500);
    const session=new ResilientAsrSession({
      createStream:hooks=>this.createStream(config,hooks),
      onSentence:s=>{try{const entry=this.store.append(meta,s);this.hooks.transcribed?.(meta,entry);}catch(e){void this.stop(token,String(e));}},
      onState:state=>{if(meta.endedAt||meta.state==='stopping')return;meta.wsState=state;meta.state=state==='ready'?'recording':state==='stopped'?'stopped':'reconnecting';this.store.save(meta);},
      /**
       * 内核的每一条日志都进诊断，**不再用关键词正则决定要不要留痕**。
       *
       * 以前这里只把命中 `/fail|error|overflow/i` 的那几条写进 `meta.error`，而内核真正报的是
       * `sasr ws closed unexpectedly`、`reconnect in …ms`、`stream stopped: …`——**一条都不命中**。
       * 于是一次外部 ASR 断流的直接原因，在日志、侧车、报告里都不存在（`service.ts` 整个文件
       * 0 条日志）。判据放宽只解决一半：真正的问题是"留不留痕"由一句正则决定。
       */
      onLog:message=>{
        const text=redact(message);
        diag.info('voice.asr',text,{recordingId:meta.id,state:session.stats.wsState,reconnects:session.stats.reconnects});
        // 侧车里只留"这一次录音出过事"的那一条（面板要显示给人看），列表放宽到断线/重连/超时。
        if(/fail|error|overflow|closed|lost|reconnect|timeout|stopp/i.test(message)){meta.error=text;this.store.save(meta);}
      },
    });
    const timer=setInterval(()=>{
      const current=this.active;if(!current||current.token!==token||current.stopping)return;
      if(Date.now()-current.lastAudio>15000){
        diag.warn('voice.capture','15 秒没有收到音频，自动停止录音',{recordingId:meta.id,silentMs:Date.now()-current.lastAudio});
        void this.stop(token,'麦克风连接已中断，录音已自动停止。');return;
      }
      Object.assign(meta,{reconnects:session.stats.reconnects,droppedBytes:session.stats.droppedBytes,wsState:session.stats.wsState});this.store.save(meta);
      this.hooks.tick?.(meta);
    },3000);timer.unref();
    this.active={meta,token,session,lastAudio:Date.now(),nextSequence:0,timer};
    void session.start().catch(e=>{
      // 连不上外部 ASR 的**原因**必须落在日志里：这是唯一一处会拿到它的地方。
      diag.error('voice.asr','会话启动失败',{recordingId:meta.id,error:redact(String(e))});
      return this.stop(token,redact(String(e)));
    });
    return {token,recording:meta};
  }
  audio(token:string,sequence:number,base64:string){
    const active=this.active;if(!active||active.token!==token||active.stopping)throw new Error('录音已停止，请重新打开会议开关。');
    if(sequence<active.nextSequence)return {accepted:true}; // Retried acknowledgement, never duplicate PCM.
    if(sequence!==active.nextSequence)throw new Error('音频片段顺序不一致，请重新开始录音。');
    if(typeof base64!=='string'||base64.length>86000||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64))throw new Error('无效的音频片段');
    const pcm=Buffer.from(base64,'base64');if(!pcm.length||pcm.length%2)throw new Error('音频必须为 16kHz 单声道 PCM16');
    try{this.store.audio(active.meta,pcm);active.session.feedAudio(pcm);}catch(e){void this.stop(token,'本地录音保存失败');throw e;}
    active.nextSequence++;active.lastAudio=Date.now();return {accepted:true};
  }
  async stop(token:string,error?:string){
    const active=this.active;if(!active)return;
    if(active.token!==token)throw new Error('录音控制权不匹配');
    if(active.stopping)return active.stopping;
    clearInterval(active.timer);active.meta.state='stopping';this.store.save(active.meta);
    active.stopping=(async()=>{
      try{
        const pending=await active.session.stop();
        Object.assign(active.meta,{endedAt:Date.now(),state:error?'error':'stopped',error:error??active.meta.error,untranscribedBytes:pending.length,reconnects:active.session.stats.reconnects,droppedBytes:active.session.stats.droppedBytes});
        await this.store.finalize(active.meta);
      }catch(e){active.meta.state='error';active.meta.error='录音收尾失败，已保存的 PCM 和转写仍在本机';active.meta.endedAt=Date.now();this.store.save(active.meta);throw e;}
      finally{
        // Fires on both paths, once `meta` is final, and before the recording is
        // released — the closing state is the last thing a consumer can act on.
        try{this.hooks.stopped?.(active.meta);}catch{}
        if(this.active===active)this.active=undefined;
      }
    })();
    return active.stopping;
  }
  async status(sessionId:string,recordingId?:string){
    // 上限**在这一层生效**（`list` 的第二个参数）：这条轮询每 1.5 秒跑一次，写在外面的
    // `.slice(0,30)` 拦不住读盘。
    const recordings=this.store.list(sessionId,30).map(meta=>this.recover(meta));
    const selected=recordingId??(recordings.length?this.store.get(sessionId).id:undefined);
    const result=selected?await this.read(sessionId,{recordingId:selected,tail:true,lines:60}):null;
    return {active:this.active?{sessionId:this.active.meta.sessionId,id:this.active.meta.id,state:this.active.meta.state}:null,recordings,result};
  }
  private recover(meta:MeetingMeta){
    if(meta.id!==this.active?.meta.id&&!meta.endedAt){meta.state='interrupted';meta.endedAt=meta.startedAt+meta.audioBytes/32;meta.error='上次录音因应用退出而中断，已保存的音频和转写可以继续读取。';this.store.save(meta);}
    return meta;
  }
  async read(sessionId:string,query:TranscriptQuery={},signal?:AbortSignal){const result=await this.store.read(sessionId,query,signal);result.recording=this.recover(result.recording);return result;}
  async dispose(){this.disposed=true;if(this.active)await this.stop(this.active.token);}
}
