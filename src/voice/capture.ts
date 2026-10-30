declare const __MEETING_WORKLET__:string;
export type VoiceCall=(endpoint:string,payload?:unknown)=>Promise<any>;
export type CapturePhase='idle'|'checking'|'permission'|'connecting'|'recording'|'stopping';
export type CaptureState={sessionId:string|null;busy:boolean;recording:boolean;error:string;level:number;phase:CapturePhase;startedAt:number|null;deviceLabel:string;recordingId:string|null};
type Capture={stream:MediaStream;context:AudioContext;node:AudioWorkletNode;source:MediaStreamAudioSourceNode;token:string;sessionId:string;startedAt:number;queue:Uint8Array[];sequence:number;sending?:Promise<void>;flush?:()=>void;closing?:Promise<void>};
type StartResult={token:string;recording?:{id?:string}};
type PendingService={response:Promise<StartResult>;token?:string;closing?:Promise<void>;transferred?:boolean};
type StartAttempt={cancelled:boolean;cancellation:Promise<void>;cancel:()=>void;stream?:MediaStream;releasedStream?:MediaStream;context?:AudioContext;contextClosing?:Promise<void>;node?:AudioWorkletNode;source?:MediaStreamAudioSourceNode;service?:PendingService};
const CANCELLED=Symbol('cancelled capture start');
const NETWORK_TIMEOUT_MS=15000;
const idleState:CaptureState={sessionId:null,busy:false,recording:false,error:'',level:0,phase:'idle',startedAt:null,deviceLabel:'',recordingId:null};

function captureError(error:unknown):string{
  const name=error&&typeof error==='object'&&'name' in error?String(error.name):'';
  switch(name){
    case 'NotAllowedError':return '麦克风权限未获允许。请检查当前应用的麦克风权限，然后重新开始录音。';
    case 'SecurityError':return '当前窗口不允许访问麦克风。请检查当前应用的麦克风权限，或使用支持麦克风的窗口。';
    case 'NotFoundError':return '未找到可用的麦克风。请连接麦克风后重试。';
    case 'NotReadableError':return '无法读取麦克风。请检查设备是否被其他应用占用，或重新连接后重试。';
    case 'AbortError':return '麦克风启动已中止，请重试。';
    default:return error instanceof Error?error.message:String(error);
  }
}
function stopTracks(stream:MediaStream){for(const track of stream.getTracks()){try{track.stop();}catch{}}}
function disconnect(node:AudioNode|undefined){try{node?.disconnect();}catch{}}

/** Owned by the client plugin, not a chat component; switching conversations keeps capture alive. */
export class MeetingCapture {
  private state:CaptureState={...idleState};
  private listeners=new Set<()=>void>();
  private current?:Capture;
  private starting?:StartAttempt;
  // A cancelled RPC still owns the service until its eventual token has been stopped.
  private pendingService?:PendingService;
  private disposed=false;
  constructor(private call:VoiceCall){}
  subscribe=(fn:()=>void)=>{this.listeners.add(fn);return ()=>{this.listeners.delete(fn);};};
  snapshot=()=>this.state;
  private update(patch:Partial<CaptureState>){this.state={...this.state,...patch};for(const fn of this.listeners)fn();}
  private valid(attempt:StartAttempt){return !this.disposed&&!attempt.cancelled&&this.starting===attempt;}
  private check(attempt:StartAttempt){if(!this.valid(attempt))throw CANCELLED;}
  private async wait<T>(attempt:StartAttempt,promise:Promise<T>,timeoutMessage?:string):Promise<T>{
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{
      const pending:Promise<T>[]=[promise,attempt.cancellation.then(()=>{throw CANCELLED;})];
      if(timeoutMessage)pending.push(new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error(timeoutMessage)),NETWORK_TIMEOUT_MS);}));
      const result=await Promise.race(pending);this.check(attempt);return result;
    }finally{if(timer!==undefined)clearTimeout(timer);}
  }
  private releaseLocal(attempt:StartAttempt){
    disconnect(attempt.source);disconnect(attempt.node);
    if(attempt.stream&&attempt.releasedStream!==attempt.stream){stopTracks(attempt.stream);attempt.releasedStream=attempt.stream;}
    if(attempt.context&&!attempt.contextClosing){
      try{attempt.contextClosing=attempt.context.close().catch(()=>{});}catch{attempt.contextClosing=Promise.resolve();}
    }
  }
  private closeService(service:PendingService):Promise<void>{
    if(service.transferred)return Promise.resolve();
    if(service.closing)return service.closing;
    service.closing=(async()=>{
      const result=await service.response;
      await this.call('stop',{token:result.token});
      if(this.pendingService===service)this.pendingService=undefined;
    })().catch(error=>{
      service.closing=undefined; // A failed stop must be retried before another start may use the service.
      throw error;
    });
    return service.closing;
  }
  private releaseStart(attempt:StartAttempt){
    this.releaseLocal(attempt);
    if(attempt.service)void this.closeService(attempt.service).catch(error=>{
      if(!this.disposed&&!this.starting&&!this.current&&this.pendingService===attempt.service)
        this.update({error:`录音已取消，服务端收尾尚未确认，请稍后重试：${captureError(error)}`});
    });
  }
  private startService(attempt:StartAttempt,sessionId:string){
    this.check(attempt);
    const service:PendingService={response:Promise.resolve().then(()=>{
      this.check(attempt);return this.call('start',{sessionId});
    }).then(result=>{
      if(typeof result?.token!=='string'||!result.token)throw new Error('录音服务未返回有效的录音凭据，请重试。');
      service.token=result.token;
      if(!this.valid(attempt))void this.closeService(service).catch(()=>{});
      return result as StartResult;
    }).catch(error=>{
      if(!service.token&&this.pendingService===service)this.pendingService=undefined;
      throw error;
    })};
    this.pendingService=service;attempt.service=service;return service.response;
  }
  async start(sessionId:string){
    if(this.disposed||this.starting||this.current)return;
    let cancel!:()=>void;
    const attempt:StartAttempt={cancelled:false,cancellation:new Promise<void>(resolve=>{cancel=resolve;}),cancel:()=>cancel()};
    this.starting=attempt;
    this.update({...idleState,sessionId,busy:true,phase:'checking'});
    try{
      this.check(attempt);
      const config=await this.wait(attempt,Promise.resolve().then(()=>{this.check(attempt);return this.call('config');}),'检查录音设置超时，请重试。');
      this.check(attempt);
      if(!config.configured)throw new Error('请先点击会议设置，填写百炼 API Key。');
      if(this.pendingService){
        this.update({phase:'connecting'});this.check(attempt);
        await this.wait(attempt,this.closeService(this.pendingService),'上次录音仍在收尾，请稍后重试。');
        this.check(attempt);
      }
      if(typeof navigator==='undefined'||!navigator.mediaDevices?.getUserMedia)throw new Error('当前窗口不支持访问麦克风，请使用支持麦克风的应用窗口。');
      this.update({phase:'permission'});this.check(attempt);
      await this.wait(attempt,navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false}).then(stream=>{
        attempt.stream=stream;
        if(!this.valid(attempt)){this.releaseLocal(attempt);throw CANCELLED;}
        return stream;
      }));
      this.check(attempt);
      this.update({phase:'connecting'});this.check(attempt);
      if(typeof AudioContext==='undefined'||typeof AudioWorkletNode==='undefined')throw new Error('当前窗口不支持音频采集，请使用支持麦克风的应用窗口。');
      const stream=attempt.stream!,context=attempt.context=new AudioContext();
      await this.wait(attempt,context.resume(),'启动音频设备超时，请重试。');this.check(attempt);
      const url=URL.createObjectURL(new Blob([__MEETING_WORKLET__],{type:'text/javascript'}));
      try{await this.wait(attempt,context.audioWorklet.addModule(url),'加载音频采集超时，请重试。');}finally{URL.revokeObjectURL(url);}
      this.check(attempt);
      const source=attempt.source=context.createMediaStreamSource(stream),node=attempt.node=new AudioWorkletNode(context,'meeting-assistant');
      const result=await this.wait(attempt,this.startService(attempt,sessionId),'连接录音服务超时，请稍后重试。');this.check(attempt);
      const capture:Capture={stream,context,source,node,token:result.token,sessionId,startedAt:Date.now(),queue:[],sequence:0};
      node.port.onmessage=event=>{
        if(this.current!==capture)return;
        if(event.data==='flushed'){capture.flush?.();return;}
        const pcm=event.data as Uint8Array;if(!(pcm instanceof Uint8Array))return;
        let peak=0;const view=new DataView(pcm.buffer,pcm.byteOffset,pcm.byteLength);for(let i=0;i<pcm.byteLength;i+=2)peak=Math.max(peak,Math.abs(view.getInt16(i,true))/32768);
        if(!capture.closing)this.update({level:peak});capture.queue.push(pcm);
        if(capture.queue.length>50){void this.stop('本机音频连接积压，录音已停止。');return;}
        void this.drain(capture);
      };
      for(const track of stream.getAudioTracks())track.addEventListener('ended',()=>{if(this.current===capture&&!capture.closing)void this.stop('麦克风已断开，录音已停止。');});
      source.connect(node);node.connect(context.destination); // Worklet outputs silence; no microphone playback.
      this.check(attempt);
      attempt.service!.transferred=true;if(this.pendingService===attempt.service)this.pendingService=undefined;
      this.current=capture;this.starting=undefined;
      this.update({recording:true,busy:false,phase:'recording',startedAt:capture.startedAt,deviceLabel:stream.getAudioTracks()[0]?.label??'',recordingId:result.recording?.id??null});
    }catch(error){
      const report=this.valid(attempt)&&error!==CANCELLED;
      if(this.starting===attempt)this.starting=undefined;
      attempt.cancelled=true;attempt.cancel();this.releaseStart(attempt);
      if(report)this.update({...idleState,error:captureError(error)});
    }
  }
  private drain(c:Capture):Promise<void>{
    if(c.sending)return c.sending;
    c.sending=(async()=>{while(c.queue.length){const pcm=c.queue[0]!;let binary='';for(const byte of pcm)binary+=String.fromCharCode(byte);
      await this.call('audio',{token:c.token,sequence:c.sequence,pcm:btoa(binary)});c.queue.shift();c.sequence++;
    }})().catch(error=>{
      c.queue=[];if(this.current!==c)return;
      const message=captureError(error);this.update({error:message});
      if(!c.closing)queueMicrotask(()=>{if(this.current===c&&!c.closing)void this.stop(message);});
    }).finally(()=>{c.sending=undefined;});
    return c.sending;
  }
  async stop(error=''){
    const attempt=this.starting;
    if(attempt){
      this.starting=undefined;attempt.cancelled=true;attempt.cancel();this.releaseStart(attempt);
      this.update({...idleState,error});return;
    }
    const c=this.current;if(!c)return;if(c.closing)return c.closing;
    c.closing=Promise.resolve().then(async()=>{
      disconnect(c.source);stopTracks(c.stream);
      await new Promise<void>(resolve=>{
        const timeout=setTimeout(resolve,500);c.flush=()=>{clearTimeout(timeout);resolve();};
        try{c.node.port.postMessage('flush');}catch{c.flush();}
      });
      disconnect(c.node);await c.context.close().catch(()=>{});
      await this.drain(c);
      try{await this.call('stop',{token:c.token});}catch(e){this.update({error:`录音已停止采集，服务端将在连接超时后收尾：${captureError(e)}`});}
    }).finally(()=>{
      if(this.current===c){this.current=undefined;this.update({...idleState,error:this.state.error});}
    });
    this.update({busy:true,recording:false,phase:'stopping',level:0,...error?{error}:{}});
    return c.closing;
  }
  shutdown(){this.disposed=true;return this.stop();}
  reconcile(active:{sessionId:string;id:string;state:string}|null,observedAt:number){if(this.current&&observedAt>=this.current.startedAt&&!this.state.busy&&!active)void this.stop('录音服务已停止，已关闭麦克风。');}
}
