/** Streaming area resampler: arbitrary input rate -> mono 16kHz PCM16LE. */
export class PcmEncoder {
  private remaining:number;
  private sum=0;
  private samples:number[]=[];
  private ratio:number;
  constructor(inputRate:number,private emit:(bytes:Uint8Array)=>void,private frameSamples=3200){
    if(!Number.isFinite(inputRate)||inputRate<16000)throw new Error('Unsupported microphone sample rate');
    this.ratio=inputRate/16000;this.remaining=this.ratio;
  }
  push(input:Float32Array){for(const sample of input){let weight=1;while(weight>1e-8){const used=Math.min(weight,this.remaining);this.sum+=(Number.isFinite(sample)?sample:0)*used;this.remaining-=used;weight-=used;
    if(this.remaining<1e-8){this.samples.push(Math.max(-1,Math.min(1,this.sum/this.ratio)));this.remaining=this.ratio;this.sum=0;if(this.samples.length>=this.frameSamples)this.flush();}
  }}}
  flush(){if(!this.samples.length)return;const bytes=new Uint8Array(this.samples.length*2),view=new DataView(bytes.buffer);this.samples.forEach((s,i)=>view.setInt16(i*2,Math.round(s*(s<0?32768:32767)),true));this.samples=[];this.emit(bytes);}
}
