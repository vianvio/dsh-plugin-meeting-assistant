declare const __MEETING_WORKLET__:string;
export type VoiceCall=(endpoint:string,payload?:unknown)=>Promise<any>;
type CaptureState={sessionId:string|null;busy:boolean;recording:boolean;error:string;level:number};
type Capture={stream:MediaStream;context:AudioContext;node:AudioWorkletNode;source:MediaStreamAudioSourceNode;token:string;sessionId:string;startedAt:number;queue:Uint8Array[];sequence:number;sending?:Promise<void>;flush?:()=>void;closing?:Promise<void>};

/** Owned by the client plugin, not a chat component; switching conversations keeps capture alive. */
export class MeetingCapture {
  private state:CaptureState={sessionId:null,busy:false,recording:false,error:'',level:0};
  private listeners=new Set<()=>void>();
  private current?:Capture;
  private disposed=false;
  constructor(private call:VoiceCall){}
  subscribe=(fn:()=>void)=>{this.listeners.add(fn);return ()=>{this.listeners.delete(fn);};};
  snapshot=()=>this.state;
  private update(patch:Partial<CaptureState>){this.state={...this.state,...patch};for(const fn of this.listeners)fn();}
  async start(sessionId:string){
    if(this.disposed||this.state.busy||this.current)return;
    this.update({busy:true,error:'',sessionId});
    let stream:MediaStream|undefined,context:AudioContext|undefined,token:string|undefined;
    try{
      const config=await this.call('config');if(!config.configured)throw new Error('请先点击会议设置，填写百炼 API Key。');
      if(!navigator.mediaDevices?.getUserMedia)throw new Error('当前窗口无法访问麦克风，请在桌面应用中打开会议。');
      stream=await navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false});
      if(this.disposed)throw new Error('会议窗口已关闭');
      context=new AudioContext();await context.resume();
      const url=URL.createObjectURL(new Blob([__MEETING_WORKLET__],{type:'text/javascript'}));
      try{await context.audioWorklet.addModule(url);}finally{URL.revokeObjectURL(url);}
      const source=context.createMediaStreamSource(stream),node=new AudioWorkletNode(context,'meeting-assistant');
      const result=await this.call('start',{sessionId});token=result.token;
      if(this.disposed)throw new Error('会议窗口已关闭');
      const capture:Capture={stream,context,source,node,token:token!,sessionId,startedAt:Date.now(),queue:[],sequence:0};this.current=capture;
      node.port.onmessage=event=>{
        if(event.data==='flushed'){capture.flush?.();return;}
        const pcm=event.data as Uint8Array;if(!(pcm instanceof Uint8Array))return;
        let peak=0;const view=new DataView(pcm.buffer,pcm.byteOffset,pcm.byteLength);for(let i=0;i<pcm.byteLength;i+=2)peak=Math.max(peak,Math.abs(view.getInt16(i,true))/32768);
        this.update({level:peak});capture.queue.push(pcm);
        if(capture.queue.length>50){void this.stop('本机音频连接积压，录音已停止。');return;}
        void this.drain(capture);
      };
      for(const track of stream.getAudioTracks())track.addEventListener('ended',()=>{void this.stop('麦克风已断开，录音已停止。');});
      source.connect(node);node.connect(context.destination); // Worklet outputs silence; no microphone playback.
      this.update({recording:true});
    }catch(error){
      stream?.getTracks().forEach(track=>track.stop());await context?.close().catch(()=>{});if(token)await this.call('stop',{token}).catch(()=>{});
      const message=error instanceof Error?error.message:String(error);
      this.update({recording:false,sessionId:null,error:/NotAllowed|Permission denied|Permission dismissed/i.test(message)?'麦克风权限未开启。请在 macOS 系统设置 → 隐私与安全性 → 麦克风中允许 Agent Mesh Desktop。':message});
    }finally{this.update({busy:false});}
  }
  private drain(c:Capture):Promise<void>{
    if(c.sending)return c.sending;
    c.sending=(async()=>{while(c.queue.length){const pcm=c.queue[0]!;let binary='';for(const byte of pcm)binary+=String.fromCharCode(byte);
      await this.call('audio',{token:c.token,sequence:c.sequence,pcm:btoa(binary)});c.queue.shift();c.sequence++;
    }})().catch(error=>{c.queue=[];this.update({error:String(error instanceof Error?error.message:error)});if(!c.closing)queueMicrotask(()=>{void this.stop(this.state.error);});}).finally(()=>{c.sending=undefined;});
    return c.sending;
  }
  async stop(error=''){
    const c=this.current;if(!c)return;if(c.closing)return c.closing;
    this.update({busy:true,recording:false,...error?{error}:{}});
    c.closing=(async()=>{
      c.source.disconnect();c.stream.getTracks().forEach(track=>track.stop());
      await new Promise<void>(resolve=>{const timeout=setTimeout(resolve,500);c.flush=()=>{clearTimeout(timeout);resolve();};c.node.port.postMessage('flush');});
      c.node.disconnect();await c.context.close().catch(()=>{});
      await this.drain(c);
      try{await this.call('stop',{token:c.token});}catch(e){this.update({error:`录音已停止采集，服务端将在连接超时后收尾：${e instanceof Error?e.message:String(e)}`});}
      this.current=undefined;this.update({sessionId:null,busy:false,recording:false,level:0});
    })();return c.closing;
  }
  shutdown(){this.disposed=true;return this.stop();}
  reconcile(active:{sessionId:string;id:string;state:string}|null,observedAt:number){if(this.current&&observedAt>=this.current.startedAt&&!this.state.busy&&!active)void this.stop('录音服务已停止，已关闭麦克风。');}
}
