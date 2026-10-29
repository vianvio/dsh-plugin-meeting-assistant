export interface Sentence { text:string; beginMs:number; endMs:number; sentenceId:number; wallTs:number; words?:object[] }
export interface StreamHooks { onSentence:(sentence:Sentence)=>void; onLog:(message:string)=>void }
export interface Stream {
  state:string; startedAt:number|null; audioZeroWall:number|null; refeedMs:number; queuedBytes:number;
  start():Promise<void>; sendAudio(chunk:Buffer):void; stop():Promise<void>; forceDrop():void;
}
export class DashscopeAsrStream implements Stream {
  constructor(options:StreamHooks & {apiKey:string;wsBase:string;model:string;wsFactory:(url:string,headers:Record<string,string>)=>unknown});
  state:string; startedAt:number|null; audioZeroWall:number|null; refeedMs:number; queuedBytes:number;
  start():Promise<void>; sendAudio(chunk:Buffer):void; stop():Promise<void>; forceDrop():void;
}
export class ResilientAsrSession {
  constructor(options:{createStream:(hooks:StreamHooks)=>Stream;onSentence:(sentence:Sentence)=>void;onLog?:(message:string)=>void;onState?:(state:string)=>void;pollMs?:number;backoffStartMs?:number});
  start():Promise<void>; feedAudio(chunk:Buffer):void; stop():Promise<Buffer>;
  stats:{fedBytes:number;bufferedBytes:number;queuedBytes:number;reconnects:number;droppedBytes:number;wsState:string};
}
export function wavHeader(size:number):Buffer;
export const WAV_MAX_DATA:number;
