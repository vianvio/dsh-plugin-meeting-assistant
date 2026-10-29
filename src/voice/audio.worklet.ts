import {PcmEncoder} from './pcm.js';
declare const sampleRate:number;
declare class AudioWorkletProcessor {port:MessagePort}
declare function registerProcessor(name:string,processor:typeof AudioWorkletProcessor):void;
class MeetingAudio extends AudioWorkletProcessor {
  private encoder=new PcmEncoder(sampleRate,bytes=>this.port.postMessage(bytes,[bytes.buffer]));
  constructor(){super();this.port.onmessage=event=>{if(event.data==='flush'){this.encoder.flush();this.port.postMessage('flushed');}};}
  process(inputs:Float32Array[][]){const channels=inputs[0];if(channels?.length){const mono=new Float32Array(channels[0]!.length);for(const channel of channels)for(let i=0;i<mono.length;i++)mono[i]!+=channel[i]!/channels.length;this.encoder.push(mono);}return true;}
}
registerProcessor('meeting-assistant',MeetingAudio);
