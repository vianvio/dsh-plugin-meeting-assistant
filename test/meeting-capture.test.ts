import assert from 'node:assert/strict';
import test,{type TestContext} from 'node:test';
import {MeetingCapture,type CapturePhase,type VoiceCall} from '../src/voice/capture.js';

function deferred<T>(){
  let resolve!:(value:T)=>void,reject!:(reason:unknown)=>void;
  const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});
  return {promise,resolve,reject};
}
const turn=()=>new Promise<void>(resolve=>setImmediate(resolve));
async function until(predicate:()=>boolean){
  for(let i=0;i<100;i++){if(predicate())return;await turn();}
  assert.fail('mock capture did not reach the expected state');
}
function globalValue(t:TestContext,name:string,value:unknown){
  const descriptor=Object.getOwnPropertyDescriptor(globalThis,name);
  Object.defineProperty(globalThis,name,{configurable:true,writable:true,value});
  t.after(()=>{if(descriptor)Object.defineProperty(globalThis,name,descriptor);else Reflect.deleteProperty(globalThis,name);});
}
function stream(label='Studio microphone'){
  const listeners:(()=>void)[]=[];
  const track={label,stops:0,stop(){this.stops++;},addEventListener(name:string,listener:()=>void){if(name==='ended')listeners.push(listener);},end(){for(const listener of listeners)listener();}};
  return {track,value:{getTracks:()=>[track],getAudioTracks:()=>[track]} as unknown as MediaStream};
}
type Options={
  media?:()=>Promise<MediaStream>;
  config?:()=>Promise<unknown>;
  start?:(payload:any)=>Promise<any>;
  stop?:(payload:any)=>Promise<unknown>;
  audio?:(payload:any)=>Promise<unknown>;
  resume?:()=>Promise<void>;
  module?:()=>Promise<void>;
};
function fixture(t:TestContext,options:Options={}){
  const calls:{endpoint:string;payload:any}[]=[],mediaRequests:MediaStreamConstraints[]=[],streams:ReturnType<typeof stream>[]=[];
  class Source {connections=0;disconnects=0;connect(){this.connections++;}disconnect(){this.disconnects++;}}
  const contexts:Context[]=[],nodes:Worklet[]=[],urls:string[]=[],revoked:string[]=[];
  class Context {
    closes=0;resumes=0;modules=0;source=new Source();destination={};
    audioWorklet={addModule:async()=>{this.modules++;await options.module?.();}};
    constructor(){contexts.push(this);}
    async resume(){this.resumes++;await options.resume?.();}
    async close(){this.closes++;}
    createMediaStreamSource(){return this.source;}
  }
  class Worklet {
    connects=0;disconnects=0;flushChunks:Uint8Array[]=[];
    port:{onmessage:((event:{data:unknown})=>void)|null;postMessage:(message:string)=>void}={
      onmessage:null,
      postMessage:message=>{
        assert.equal(message,'flush');
        queueMicrotask(()=>{for(const pcm of this.flushChunks)this.emit(pcm);this.emit('flushed');});
      },
    };
    constructor(){nodes.push(this);}
    emit(data:unknown){this.port.onmessage?.({data});}
    connect(){this.connects++;}
    disconnect(){this.disconnects++;}
  }
  globalValue(t,'navigator',{mediaDevices:{getUserMedia:(constraints:MediaStreamConstraints)=>{
    mediaRequests.push(constraints);
    if(options.media)return options.media();
    const next=stream();streams.push(next);return Promise.resolve(next.value);
  }}});
  globalValue(t,'AudioContext',Context);
  globalValue(t,'AudioWorkletNode',Worklet);
  globalValue(t,'__MEETING_WORKLET__','// mock worklet');
  t.mock.method(URL,'createObjectURL',()=>{const url='blob:mock-'+urls.length;urls.push(url);return url;});
  t.mock.method(URL,'revokeObjectURL',(url:string)=>{revoked.push(url);});
  let nextRecording=0;
  const call:VoiceCall=async(endpoint,payload)=>{
    calls.push({endpoint,payload});
    switch(endpoint){
      case 'config':return options.config?options.config():{configured:true};
      case 'start':return options.start?options.start(payload):{token:'token-'+(++nextRecording),recording:{id:'recording-'+nextRecording}};
      case 'stop':return options.stop?.(payload);
      case 'audio':return options.audio?.(payload);
      default:throw new Error('Unexpected mock endpoint '+endpoint);
    }
  };
  const capture=new MeetingCapture(call);
  t.after(async()=>{await capture.shutdown();});
  return {capture,calls,contexts,nodes,mediaRequests,streams,urls,revoked,count:(endpoint:string)=>calls.filter(call=>call.endpoint===endpoint).length};
}

test('capture publishes phases, actual device and recording identity, then clears them on stop',async t=>{
  const f=fixture(t),phases:CapturePhase[]=[];
  assert.deepEqual(f.capture.snapshot(),{sessionId:null,busy:false,recording:false,error:'',level:0,phase:'idle',startedAt:null,deviceLabel:'',recordingId:null});
  const unsubscribe=f.capture.subscribe(()=>phases.push(f.capture.snapshot().phase));
  const start=f.capture.start('session-a');
  assert.equal(f.capture.snapshot().phase,'checking');
  await start;
  assert.deepEqual(phases,['checking','permission','connecting','recording']);
  const recording=f.capture.snapshot();
  assert.equal(recording.sessionId,'session-a');assert.equal(recording.busy,false);assert.equal(recording.recording,true);
  assert.equal(typeof recording.startedAt,'number');assert.equal(recording.deviceLabel,'Studio microphone');assert.equal(recording.recordingId,'recording-1');
  assert.deepEqual(f.revoked,f.urls);
  const stopping=f.capture.stop();
  assert.equal(f.capture.snapshot().phase,'stopping');assert.equal(f.capture.snapshot().recording,false);
  assert.equal(f.capture.snapshot().startedAt,recording.startedAt);assert.equal(f.capture.snapshot().recordingId,'recording-1');
  await stopping;
  assert.equal(f.capture.snapshot().phase,'idle');assert.equal(f.capture.snapshot().busy,false);
  assert.equal(f.capture.snapshot().startedAt,null);assert.equal(f.capture.snapshot().recordingId,null);assert.equal(f.capture.snapshot().deviceLabel,'');
  assert.equal(f.streams[0]!.track.stops,1);assert.equal(f.contexts[0]!.closes,1);assert.equal(f.count('stop'),1);
  unsubscribe();
});

test('stop cancels a permission wait immediately and releases a stream granted later',async t=>{
  const permission=deferred<MediaStream>(),late=stream('Late microphone');
  const f=fixture(t,{media:()=>permission.promise});
  const starting=f.capture.start('session-a');
  await until(()=>f.capture.snapshot().phase==='permission');
  const stopping=f.capture.stop();
  assert.equal(f.capture.snapshot().phase,'idle');assert.equal(f.capture.snapshot().busy,false);assert.equal(f.capture.snapshot().sessionId,null);
  await stopping;await starting;
  assert.equal(f.count('start'),0);
  permission.resolve(late.value);await turn();
  assert.equal(late.track.stops,1);assert.equal(f.contexts.length,0);assert.equal(f.count('start'),0);
  assert.equal(f.capture.snapshot().phase,'idle');assert.equal(f.capture.snapshot().error,'');
});

test('a new start succeeds while cancelled permission is pending and late old media cannot touch it',async t=>{
  const permission=deferred<MediaStream>(),old=stream('Old microphone'),next=stream('New microphone');let requests=0;
  const f=fixture(t,{media:()=>++requests===1?permission.promise:Promise.resolve(next.value)});
  const first=f.capture.start('old-session');
  await until(()=>f.capture.snapshot().phase==='permission');
  await f.capture.stop();await first;
  await f.capture.start('new-session');
  assert.equal(f.capture.snapshot().phase,'recording');assert.equal(f.capture.snapshot().sessionId,'new-session');
  assert.equal(f.capture.snapshot().deviceLabel,'New microphone');
  permission.resolve(old.value);await turn();
  assert.equal(old.track.stops,1);assert.equal(next.track.stops,0);
  assert.equal(f.count('start'),1);assert.equal(f.capture.snapshot().recordingId,'recording-1');
  assert.equal(f.capture.snapshot().error,'');
});

test('a rejected permission prompt after cancellation does not overwrite the next recording',async t=>{
  const permission=deferred<MediaStream>();let requests=0;
  const f=fixture(t,{media:()=>++requests===1?permission.promise:Promise.resolve(stream().value)});
  const first=f.capture.start('old-session');
  await until(()=>f.capture.snapshot().phase==='permission');
  await f.capture.stop();await first;await f.capture.start('new-session');
  permission.reject(new DOMException('same generic browser message','NotAllowedError'));await turn();
  assert.equal(f.capture.snapshot().phase,'recording');assert.equal(f.capture.snapshot().error,'');
});

test('a late start token is stopped before the next start may acquire the service',async t=>{
  const response=deferred<any>(),closed=deferred<void>();let starts=0;
  const f=fixture(t,{
    start:async()=>++starts===1?response.promise:{token:'new-token',recording:{id:'new-recording'}},
    stop:async payload=>{if(payload.token==='old-token')await closed.promise;},
  });
  const first=f.capture.start('old-session');
  await until(()=>f.count('start')===1);
  await f.capture.stop();await first;
  assert.equal(f.capture.snapshot().phase,'idle');assert.equal(f.streams[0]!.track.stops,1);assert.equal(f.contexts[0]!.closes,1);
  const second=f.capture.start('new-session');
  await until(()=>f.count('config')===2&&f.capture.snapshot().phase==='connecting');
  assert.equal(f.mediaRequests.length,1);
  response.resolve({token:'old-token',recording:{id:'old-recording'}});
  await until(()=>f.count('stop')===1);
  assert.equal(f.count('start'),1);assert.equal(f.mediaRequests.length,1);assert.equal(f.capture.snapshot().recordingId,null);
  closed.resolve();await second;
  assert.equal(f.capture.snapshot().phase,'recording');assert.equal(f.capture.snapshot().recordingId,'new-recording');
  assert.equal(f.capture.snapshot().sessionId,'new-session');
  const transitions=f.calls.filter(call=>call.endpoint==='start'||call.endpoint==='stop');
  assert.deepEqual(transitions.map(call=>[call.endpoint,call.payload.sessionId??call.payload.token]),[['start','old-session'],['stop','old-token'],['start','new-session']]);
});

test('waiting for old service cleanup can be cancelled and never stays busy indefinitely',async t=>{
  const response=deferred<any>();let starts=0;
  const f=fixture(t,{start:async()=>++starts===1?response.promise:{token:'next-token',recording:{id:'next-id'}}});
  const first=f.capture.start('old-session');await until(()=>f.count('start')===1);
  await f.capture.stop();await first;
  const second=f.capture.start('cancelled-session');
  await until(()=>f.count('config')===2&&f.capture.snapshot().phase==='connecting');
  await f.capture.stop();await second;assert.equal(f.capture.snapshot().phase,'idle');
  t.mock.timers.enable({apis:['setTimeout']});
  const third=f.capture.start('timed-out-session');
  await until(()=>f.count('config')===3&&f.capture.snapshot().phase==='connecting');
  t.mock.timers.tick(15000);await third;
  assert.equal(f.capture.snapshot().phase,'idle');assert.equal(f.capture.snapshot().busy,false);
  assert.match(f.capture.snapshot().error,/上次录音仍在收尾/);assert.equal(f.count('start'),1);
  response.resolve({token:'old-token',recording:{id:'old-id'}});
  await until(()=>f.count('stop')===1);await turn();
  await f.capture.start('next-session');
  assert.equal(f.capture.snapshot().phase,'recording');assert.equal(f.capture.snapshot().recordingId,'next-id');
});

test('a timed-out start returns to idle and still closes a token that arrives later',async t=>{
  const response=deferred<any>();
  const f=fixture(t,{start:()=>response.promise});
  t.mock.timers.enable({apis:['setTimeout']});
  const starting=f.capture.start('session-a');await until(()=>f.count('start')===1);
  t.mock.timers.tick(15000);await starting;
  assert.equal(f.capture.snapshot().phase,'idle');assert.equal(f.capture.snapshot().busy,false);
  assert.match(f.capture.snapshot().error,/连接录音服务超时/);assert.equal(f.streams[0]!.track.stops,1);
  response.resolve({token:'timed-out-token',recording:{id:'timed-out-recording'}});
  await until(()=>f.count('stop')===1);
  assert.deepEqual(f.calls.find(call=>call.endpoint==='stop')!.payload,{token:'timed-out-token'});
  assert.equal(f.capture.snapshot().phase,'idle');assert.equal(f.capture.snapshot().recordingId,null);
});

test('failed cleanup is retried before any new service start',async t=>{
  const response=deferred<any>(),retry=deferred<void>();let starts=0,stops=0;
  const f=fixture(t,{
    start:async()=>++starts===1?response.promise:{token:'new-token',recording:{id:'new-id'}},
    stop:async payload=>{if(payload.token==='old-token'){if(++stops===1)throw new Error('transport disconnected');await retry.promise;}},
  });
  const first=f.capture.start('old-session');await until(()=>f.count('start')===1);
  await f.capture.stop();await first;response.resolve({token:'old-token'});
  await until(()=>!!f.capture.snapshot().error);
  assert.equal(f.capture.snapshot().phase,'idle');
  const second=f.capture.start('new-session');await until(()=>f.count('stop')===2);
  assert.equal(f.count('start'),1);assert.equal(f.capture.snapshot().phase,'connecting');
  retry.resolve();await second;
  assert.equal(f.capture.snapshot().phase,'recording');assert.equal(f.capture.snapshot().recordingId,'new-id');
});

test('every asynchronous local startup phase can be cancelled without starting the service',async t=>{
  for(const stage of ['config','resume','module'] as const){
    await t.test(stage,async t=>{
      const gate=deferred<void>();
      const f=fixture(t,stage==='config'?{config:async()=>{await gate.promise;return {configured:true};}}:stage==='resume'?{resume:()=>gate.promise}:{module:()=>gate.promise});
      const starting=f.capture.start('session-a');
      await until(()=>stage==='config'?f.count('config')===1:stage==='resume'?f.contexts[0]?.resumes===1:f.contexts[0]?.modules===1);
      await f.capture.stop();await starting;
      assert.equal(f.capture.snapshot().phase,'idle');
      gate.resolve();await turn();
      assert.equal(f.count('start'),0);assert.equal(f.capture.snapshot().error,'');
      if(stage==='config')assert.equal(f.mediaRequests.length,0);
      else{assert.equal(f.streams[0]!.track.stops,1);assert.equal(f.contexts[0]!.closes,1);}
      if(stage==='module')assert.deepEqual(f.revoked,f.urls);
    });
  }
});

test('permission errors are classified by DOMException.name and give application or device guidance',async t=>{
  const cases=[
    ['NotAllowedError',/当前应用的麦克风权限/],
    ['SecurityError',/当前窗口不允许访问麦克风/],
    ['NotFoundError',/未找到可用的麦克风/],
    ['NotReadableError',/其他应用占用/],
    ['AbortError',/启动已中止/],
  ] as const;
  const messages=new Set<string>();
  for(const [name,expected] of cases){
    await t.test(name,async t=>{
      const f=fixture(t,{media:async()=>{throw new DOMException('identical message for every error',name);}});
      await f.capture.start('session-a');
      assert.equal(f.capture.snapshot().phase,'idle');assert.equal(f.capture.snapshot().busy,false);
      assert.match(f.capture.snapshot().error,expected);assert.doesNotMatch(f.capture.snapshot().error,/macOS|Agent Mesh/);
      assert.equal(f.count('start'),0);messages.add(f.capture.snapshot().error);
    });
  }
  assert.equal(messages.size,cases.length);
});

test('unsupported windows and ordinary failures keep distinct useful errors',async t=>{
  await t.test('missing media support',async t=>{
    const f=fixture(t);globalValue(t,'navigator',{});
    await f.capture.start('session-a');
    assert.match(f.capture.snapshot().error,/当前窗口不支持访问麦克风/);assert.equal(f.capture.snapshot().phase,'idle');assert.equal(f.count('start'),0);
  });
  await t.test('configuration error',async t=>{
    const f=fixture(t,{config:async()=>({configured:false})});
    await f.capture.start('session-a');
    assert.match(f.capture.snapshot().error,/API Key/);assert.equal(f.mediaRequests.length,0);assert.equal(f.capture.snapshot().busy,false);
  });
  await t.test('ordinary failure',async t=>{
    const f=fixture(t,{media:async()=>{throw new Error('specific local failure');}});
    await f.capture.start('session-a');
    assert.equal(f.capture.snapshot().error,'specific local failure');
  });
});

test('shutdown cancels permission waits, releases late streams and prevents further starts',async t=>{
  const permission=deferred<MediaStream>(),late=stream();
  const f=fixture(t,{media:()=>permission.promise});
  const starting=f.capture.start('session-a');await until(()=>f.capture.snapshot().phase==='permission');
  await f.capture.shutdown();await starting;
  assert.equal(f.capture.snapshot().phase,'idle');
  permission.resolve(late.value);await turn();await f.capture.start('session-b');
  assert.equal(late.track.stops,1);assert.equal(f.count('config'),1);assert.equal(f.count('start'),0);
});

test('shutdown during a service start still stops its eventual token without reviving state',async t=>{
  const response=deferred<any>();
  const f=fixture(t,{start:()=>response.promise});
  const starting=f.capture.start('session-a');await until(()=>f.count('start')===1);
  await f.capture.shutdown();await starting;
  response.resolve({token:'late-token',recording:{id:'late-id'}});await until(()=>f.count('stop')===1);
  assert.deepEqual(f.calls.find(call=>call.endpoint==='stop')!.payload,{token:'late-token'});
  assert.equal(f.capture.snapshot().phase,'idle');assert.equal(f.capture.snapshot().recordingId,null);
  assert.equal(f.streams[0]!.track.stops,1);
});

test('stop remains idempotent and sends queued plus flushed PCM in sequence before service stop',async t=>{
  const firstAudio=deferred<void>();
  const f=fixture(t,{audio:async payload=>{if(payload.sequence===0)await firstAudio.promise;}});
  await f.capture.start('session-a');
  const first=new Uint8Array([1,0,2,0]),second=new Uint8Array([3,0,4,0]),tail=new Uint8Array([5,0,6,0]);
  f.nodes[0]!.emit(first);f.nodes[0]!.emit(second);f.nodes[0]!.flushChunks=[tail];
  assert.equal(f.count('audio'),1);
  const stopping=f.capture.stop(),again=f.capture.stop();
  assert.equal(f.capture.snapshot().phase,'stopping');
  await until(()=>f.contexts[0]!.closes===1);
  assert.equal(f.count('stop'),0);assert.equal(f.streams[0]!.track.stops,1);
  firstAudio.resolve();await stopping;await again;await f.capture.stop();
  const audio=f.calls.filter(call=>call.endpoint==='audio');
  assert.deepEqual(audio.map(call=>call.payload.sequence),[0,1,2]);
  assert.deepEqual(audio.map(call=>Buffer.from(call.payload.pcm,'base64')),[Buffer.from(first),Buffer.from(second),Buffer.from(tail)]);
  assert.equal(f.calls.at(-1)!.endpoint,'stop');assert.equal(f.count('stop'),1);
  assert.equal(f.capture.snapshot().phase,'idle');assert.equal(f.capture.snapshot().error,'');
});
