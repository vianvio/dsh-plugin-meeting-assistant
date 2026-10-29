import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,readFileSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Context} from '@deepseek-ai/cordis';
import Tools from '@deepseek-ai/dsh-tools';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import {ToolCallId} from '@deepseek-ai/dsh-llm';
import {PcmEncoder} from '../src/voice/pcm.js';
import {MeetingService} from '../src/voice/service.js';
import {publicConfig,saveConfig} from '../src/voice/config.js';
import {voiceLogTool} from '../src/voice/host.js';
import type {StreamHooks} from '../src/vendor/voice-kernel/index.mjs';

function fixture(){
  const root=mkdtempSync(join(tmpdir(),'mesh-voice-test-'));saveConfig(root,{apiKey:'test-secret',wsBase:'wss://example.invalid/asr',model:'test'});
  const streams:{hooks:StreamHooks;sent:Buffer[];startedAt:number;state:string;stop:()=>Promise<void>}[]=[];
  const service=new MeetingService(root,(_config,hooks)=>{
    const stream={hooks,sent:[] as Buffer[],state:'connecting',startedAt:Date.now(),audioZeroWall:null,refeedMs:0,queuedBytes:0,
      async start(){this.state='ready';},sendAudio(pcm:Buffer){this.sent.push(pcm);},
      async stop(){hooks.onSentence({text:'收尾决定：明天发布',beginMs:1000,endMs:2000,sentenceId:2,wallTs:0});this.state='finished';},forceDrop(){this.state='failed';}};
    streams.push(stream);return stream;
  });
  return {root,service,streams,async cleanup(){await service.dispose();rmSync(root,{recursive:true,force:true});}};
}

test('48k and 44.1k audio resample across arbitrary blocks to exact little-endian PCM16 duration',()=>{
  for(const rate of [16000,44100,48000]){const output:Uint8Array[]=[];const encoder=new PcmEncoder(rate,b=>output.push(b));
    const input=new Float32Array(rate).fill(.5);for(let i=0;i<input.length;i+=128)encoder.push(input.subarray(i,i+128));encoder.flush();
    const pcm=Buffer.concat(output);assert.equal(pcm.length,32000);for(let i=0;i<pcm.length;i+=2)assert.ok(Math.abs(pcm.readInt16LE(i)-16384)<=1,'fractional resampling differs by at most one quantization step');
  }
});
test('voice configuration hides credentials, enforces TLS and persists privately',async()=>{
  const f=fixture();try{assert.equal('apiKey' in publicConfig(f.root),false);assert.equal(statSync(join(f.root,'config.json')).mode&0o777,0o600);
    assert.throws(()=>saveConfig(f.root,{wsBase:'ws://example.com'}),/wss/);saveConfig(f.root,{apiKey:'',model:'updated'});assert.equal(JSON.parse(readFileSync(join(f.root,'config.json'),'utf8')).apiKey,'test-secret');
  }finally{await f.cleanup();}
});
test('recording lifecycle persists PCM and final sentences, deduplicates RPC retry, isolates sessions and supports read-only DSH tools',async()=>{
  const f=fixture();const ctx=new Context();
  try{
    const started=f.service.start('session-a');await new Promise(r=>setImmediate(r));
    assert.throws(()=>f.service.start('session-b'),/已有会议/);
    const pcm=Buffer.alloc(6400,1);f.service.audio(started.token,0,pcm.toString('base64'));f.service.audio(started.token,0,pcm.toString('base64'));
    assert.equal(f.streams[0]!.sent.reduce((sum,b)=>sum+b.length,0),6400);
    assert.throws(()=>f.service.audio('wrong',1,pcm.toString('base64')),/停止/);
    f.streams[0]!.hooks.onSentence({text:'会议预算是二十万元',beginMs:0,endMs:500,sentenceId:1,wallTs:0});
    await ctx.plugin(SystemPrompt);await ctx.plugin(Tools);ctx.tools.register(voiceLogTool(f.service));
    const signal=AbortSignal.timeout(5000);
    const execute=(sessionId:string,args:unknown)=>ctx.tools.execute({callId:ToolCallId('voice-call'),name:'voice_log',arguments:args,agent:{session:{id:sessionId}} as never,signal});
    const live=await execute('session-a',{query:'预算'});assert.equal(live.isError,false);assert.match(JSON.stringify(live.content),/二十万元/);
    const denied=await execute('session-b',{recordingId:started.recording.id});assert.equal(denied.isError,true);assert.doesNotMatch(JSON.stringify(denied.content),/二十万元/);
    const other=await f.service.status('session-b');assert.equal(other.result,null);
    assert.equal(f.service.active?.meta.state,'recording','tool reads do not stop the meeting');
    await f.service.stop(started.token);
    const ended=await f.service.read('session-a');assert.equal(ended.entries.length,2);assert.equal(ended.recording.state,'stopped');
    assert.equal(ended.entries[1]!.ts,f.streams[0]!.startedAt+1000,'last sentence retains its audio wall clock during stop');
    const wav=readFileSync(join(f.service.store.dir('session-a',started.recording.id),'audio.wav'));assert.equal(wav.length,6444);assert.equal(wav.toString('ascii',0,4),'RIFF');
    const first=await f.service.read('session-a',{lines:1});assert.equal(first.hasMore,true);assert.equal(first.nextAfterLine,1);
    const second=await f.service.read('session-a',{afterLine:first.nextAfterLine});assert.equal(second.entries[0]!.text,'收尾决定：明天发布');
    assert.equal(f.service.active,undefined);
  }finally{await ctx.fiber.dispose();await f.cleanup();}
});
test('selected meeting survives reload and an abandoned recording is marked interrupted without crossing sessions',async()=>{
  const f=fixture();try{
    const previous=f.service.store.create('session-a');previous.state='stopped';previous.endedAt=Date.now();f.service.store.save(previous);
    const abandoned=f.service.store.create('session-a');f.service.store.select('session-a',previous.id);
    const status=await f.service.status('session-a');assert.equal(status.result?.recording.id,previous.id);assert.equal(status.recordings.find(r=>r.id===abandoned.id)?.state,'interrupted');
    assert.throws(()=>f.service.store.select('session-b',previous.id));assert.throws(()=>f.service.store.get('session-a','../../etc/passwd'));
  }finally{await f.cleanup();}
});
