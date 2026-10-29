// Headless integration test: synthesize a meeting, stream it at real time, read it while recording.
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {MeetingService} from '../src/voice/service.js';
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
mkdirSync('.local',{recursive:true});const root=mkdtempSync(resolve('.local/voice-live-'));
const speech=join(root,'speech.aiff'),wav=join(root,'speech.wav');
for(const [command,args] of [['say',['-o',speech,'The meeting budget is twenty thousand dollars. We will release the desktop application on Friday.']],['ffmpeg',['-hide_banner','-loglevel','error','-i',speech,'-ar','16000','-ac','1',wav]]] as const){const result=spawnSync(command,[...args],{stdio:'inherit'});assert.equal(result.status,0);}
const wave=readFileSync(wav);let pcm=Buffer.alloc(0);
for(let offset=12;offset+8<=wave.length;){const length=wave.readUInt32LE(offset+4);if(wave.toString('ascii',offset,offset+4)==='data'){pcm=wave.subarray(offset+8,offset+8+length);break;}offset+=8+length+(length%2);}
assert.ok(pcm.length>0);pcm=Buffer.concat([pcm,Buffer.alloc(3*32000)]);
const service=new MeetingService(join(root,'voice'));
try{
  const {token}=service.start('voice-verification');const deadline=Date.now()+20000;
  while(service.active?.meta.state!=='recording'&&Date.now()<deadline)await sleep(200);
  assert.equal(service.active?.meta.state,'recording',service.active?.meta.error??'ASR failed to connect');
  for(let offset=0,sequence=0;offset<pcm.length;offset+=3200,sequence++){service.audio(token,sequence,pcm.subarray(offset,offset+3200).toString('base64'));await sleep(100);}
  const during=await service.read('voice-verification');const liveSegments=during.entries.length;
  await service.stop(token);const after=await service.read('voice-verification');
  assert.ok(after.entries.length>0,'ASR returned no transcript');
  assert.match(after.entries.map(e=>e.text).join(' '),/budget|预算|Friday|周五|星期五/i);
  const result={passed:true,liveSegments,finalSegments:after.entries.length,recordedBytes:after.recording.audioBytes,text:after.entries.map(e=>e.text).join('\n'),wav:join(service.store.dir('voice-verification',after.recording.id),'audio.wav')};
  writeFileSync(join(root,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}finally{await service.dispose();}
