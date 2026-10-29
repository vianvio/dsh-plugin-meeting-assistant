import { createHash,randomUUID } from 'node:crypto';
import { appendFileSync,createReadStream,createWriteStream,existsSync,mkdirSync,readFileSync,readdirSync,renameSync,statSync,unlinkSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { pipeline } from 'node:stream/promises';
import { wavHeader,WAV_MAX_DATA } from '../vendor/voice-kernel/index.mjs';

/**
 * `tail` 读法一次往回读多少字节。
 *
 * 要能装下"这次要返回的那些行"（默认 60 条、字符预算 24000）还留余量，同时**与文件总长无关**：
 * 轮询的代价因此是 O(窗口)，不是 O(逐字稿)。24000 字符按中文 UTF-8 约 72 KB，取 96 KB。
 */
const TAIL_READ_BYTES=96*1024;

export interface MeetingMeta {id:string;sessionId:string;startedAt:number;endedAt:number|null;state:string;segments:number;audioBytes:number;error:string|null;reconnects:number;droppedBytes:number;untranscribedBytes:number;wsState:string}
export interface TranscriptEntry {line:number;ts:number;startMs:number;endMs:number;text:string}
export interface TranscriptQuery {recordingId?:string;afterLine?:number;lines?:number;sinceMinutes?:number;query?:string;tail?:boolean}
export class MeetingStore {
  constructor(readonly root:string){}
  sessionRoot(sessionId:string){if(!sessionId||sessionId.length>200)throw new Error('无效的会话 ID');return join(this.root,'recordings',createHash('sha256').update(sessionId).digest('hex'));}
  dir(sessionId:string,id:string){if(!/^[0-9a-f-]{36}$/.test(id))throw new Error('无效的录音 ID');return join(this.sessionRoot(sessionId),id);}
  create(sessionId:string){
    const meta:MeetingMeta={id:randomUUID(),sessionId,startedAt:Date.now(),endedAt:null,state:'connecting',segments:0,audioBytes:0,error:null,reconnects:0,droppedBytes:0,untranscribedBytes:0,wsState:'connecting'};
    mkdirSync(this.dir(sessionId,meta.id),{recursive:true,mode:0o700});this.save(meta);return meta;
  }
  save(meta:MeetingMeta){const file=join(this.dir(meta.sessionId,meta.id),'meta.json');writeFileSync(file+'.tmp',JSON.stringify(meta),{mode:0o600});renameSync(file+'.tmp',file);}
  /**
   * 这个会话下的录音，按开始时间倒序。
   *
   * `limit` **必须在这里生效**：调用方（`status` 每 1.5 秒一次）写的是
   * `list().slice(0,30)`，而上限加在 `list()` 之后——每次轮询照样把**每一个**录音的
   * `meta.json` 读一遍（实测 200 个录音时一次轮询 201 次 `readFileSync`）。
   *
   * 录音目录名是随机 UUID，顺序不能从名字看出来，所以"只要最近 N 个"分两步：先按**目录
   * mtime** 粗排（写 meta/转写/音频都会更新它），只读这 N 份 `meta.json`，再按 `startedAt` 精排。
   * 目录数不超过 `limit` 时走原来那条精确路径。
   */
  list(sessionId:string,limit=Number.POSITIVE_INFINITY):MeetingMeta[]{
    const root=this.sessionRoot(sessionId);if(!existsSync(root))return [];
    const ids=readdirSync(root).filter(id=>/^[0-9a-f-]{36}$/.test(id));
    const recent=Number.isFinite(limit)&&ids.length>limit
      ? ids.map(id=>{try{return {id,mtime:statSync(join(root,id)).mtimeMs};}catch{return {id,mtime:0};}})
          .sort((a,b)=>b.mtime-a.mtime).slice(0,Math.max(0,limit)).map(entry=>entry.id)
      : ids;
    return recent.flatMap(id=>{try{return [this.get(sessionId,id)];}catch{return [];}}).sort((a,b)=>b.startedAt-a.startedAt);
  }
  get(sessionId:string,id?:string):MeetingMeta {
    if(!id){try{id=readFileSync(join(this.sessionRoot(sessionId),'selected'),'utf8');}catch{}if(!id){const latest=this.list(sessionId)[0];if(!latest)throw new Error('当前会话还没有会议记录，请打开“会议”开关。');return latest;}}
    const meta=JSON.parse(readFileSync(join(this.dir(sessionId,id),'meta.json'),'utf8')) as MeetingMeta;
    if(meta.sessionId!==sessionId)throw new Error('会议记录不属于当前会话');return meta;
  }
  select(sessionId:string,id:string){this.get(sessionId,id);writeFileSync(join(this.sessionRoot(sessionId),'selected'),id,{mode:0o600});}
  append(meta:MeetingMeta,s:{text:string;wallTs:number;beginMs:number;endMs:number}){
    const entry:TranscriptEntry={line:++meta.segments,ts:s.wallTs,startMs:s.beginMs,endMs:s.endMs,text:s.text};
    appendFileSync(join(this.dir(meta.sessionId,meta.id),'transcript.jsonl'),JSON.stringify(entry)+'\n',{mode:0o600});this.save(meta);
    return entry;
  }
  audio(meta:MeetingMeta,pcm:Buffer){appendFileSync(join(this.dir(meta.sessionId,meta.id),'audio.pcm'),pcm,{mode:0o600});meta.audioBytes+=pcm.length;}
  async finalize(meta:MeetingMeta){
    const dir=this.dir(meta.sessionId,meta.id),pcm=join(dir,'audio.pcm');
    if(existsSync(pcm)){const size=statSync(pcm).size;if(size>0&&size<=WAV_MAX_DATA){
      const wav=join(dir,'audio.wav'),out=createWriteStream(wav+'.tmp',{mode:0o600});out.write(wavHeader(size));
      await pipeline(createReadStream(pcm),out);renameSync(wav+'.tmp',wav);unlinkSync(pcm);
    }}
    this.save(meta);
  }
  async read(sessionId:string,query:TranscriptQuery={},signal?:AbortSignal){
    const meta=this.get(sessionId,query.recordingId),file=join(this.dir(sessionId,meta.id),'transcript.jsonl');
    const limit=Math.min(200,Math.max(1,Math.floor(query.lines??80)));
    const after=Math.max(0,Math.floor(query.afterLine??0));
    const cutoff=query.sinceMinutes===undefined?0:(meta.endedAt??Date.now())-Math.max(0,query.sinceMinutes)*60000;
    const entries:TranscriptEntry[]=[];let hasMore=false,chars=0;
    if(existsSync(file)){
      /**
       * `tail:true` 是"只看最后几条"——那就**只读文件末尾那一段**。
       *
       * 以前两种模式共用同一条从头遍历的流：要最后 60 条也要把整份逐字稿读完、逐行
       * `JSON.parse`（实测 2000 行时一次轮询 2201 次 `JSON.parse`、9.89 ms），而这条读法
       * 就挂在每 1.5 秒一次的 status 轮询上。取窗口之前先按字节回溯：丢掉可能被截断的首行，
       * 剩下的按原逻辑过滤与截断。
       */
      const tailStart=query.tail?Math.max(0,statSync(file).size-TAIL_READ_BYTES):0;
      const stream=createReadStream(file,tailStart>0?{encoding:'utf8',start:tailStart,signal}:{encoding:'utf8',signal});
      const lines=createInterface({input:stream,crlfDelay:Infinity});
      let skipPartial=tailStart>0;
      try{for await(const line of lines){
        if(skipPartial){skipPartial=false;continue;} // 窗口第一行可能被字节截断，丢掉
        signal?.throwIfAborted();let entry:TranscriptEntry;try{entry=JSON.parse(line);}catch{continue;}
        if(entry.line<=after||entry.ts<cutoff||(query.query&&!entry.text.toLowerCase().includes(query.query.toLowerCase())))continue;
        // Bound the tool response. Pagination refers to source lines, even with a keyword filter.
        if(!query.tail&&(entries.length>=limit||chars+entry.text.length>24000)){hasMore=true;break;}
        entries.push(entry);chars+=entry.text.length;
        if(query.tail)while(entries.length>limit||chars>24000){chars-=entries.shift()!.text.length;hasMore=true;}
      }}finally{lines.close();stream.destroy();}
    }
    return {recording:meta,entries,hasMore,nextAfterLine:entries.at(-1)?.line??after,transcriptPath:file};
  }
}
