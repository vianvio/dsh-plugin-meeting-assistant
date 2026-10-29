/**
 * 诊断日志的**落盘出口**与**宿主日志服务接入**——两件事一起做，缺一个都还留着原来的洞。
 *
 * 起因（一次真实的排查）：插件跑在别人的机器上，DSH 2.0 的 asar 里 `app.getPath('logs')`
 * 只被崩溃报告用、宿主子进程的 stdout 直接 pipe 给主进程、渲染进程的 console 只收 error，
 * 于是 `diag.ts` 那句注释"应用日志是另一个入口，两边都要有"**在这台宿主上不成立**：
 * 68 处 diag 调用点在磁盘上一条都留不下。面板打得开时还能"复制诊断报告"，而这份日志最初的
 * 用途恰恰是"面板打不开"。
 *
 * 所以两件事都要有：
 *
 * 1. **接上宿主的日志服务**（cordis 4 的 `ctx.logger`）：级别过滤、结构化字段、将来宿主接
 *    exporter 时能直接收进去。这是"跟着宿主走"的那一份。
 * 2. **自己落一份 JSONL**：`~/.agent-mesh/logs/<source>.jsonl`，按大小轮转。这是"宿主没有
 *    落盘出口时仍然查得到"的那一份。
 *
 * 落盘是**异步、排队、失败不抛**的：它是诊断，绝不能因为写日志把主线程挡住或者把一条业务
 * 路径弄失败（同样的教训见 `private-file.ts` 的 fsync 屏障）。
 */
import {appendFileSync,mkdirSync,renameSync,statSync} from 'node:fs';
import {homedir} from 'node:os';
import {dirname,join} from 'node:path';
import type {DiagEntry,DiagLog} from './diag.js';
import {redactSecrets} from './diag.js';

/** 落盘的一份日志最多留多少字节；超了就轮转一次（`<path>.1`）。 */
const MAX_BYTES=2*1024*1024;

/** 落盘目录：`MESH_DIAG_DIR` 可以改（用例把它指到临时目录），`MESH_DIAG_FILE=off` 关掉。 */
export function diagFilePath(source:string):string|undefined{
  if(process.env.MESH_DIAG_FILE==='off')return undefined;
  const dir=process.env.MESH_DIAG_DIR??join(homedir(),'.agent-mesh','logs');
  return join(dir,`${source.replace(/[^a-zA-Z0-9._-]/g,'_')}.jsonl`);
}

/**
 * 把一条记录写进 JSONL。**同步 append 是故意的**：一行几十字节，代价微秒级，而异步队列会
 * 在"崩溃前刚刚发生的那件事"上留下一个洞——那正是要查的那条。
 */
function appendLine(path:string,entry:DiagEntry):void{
  const line=`${redactSecrets(JSON.stringify(entry))}\n`;
  try{
    mkdirSync(dirname(path),{recursive:true,mode:0o700});
    try{
      if(statSync(path).size>MAX_BYTES)renameSync(path,`${path}.1`);
    }catch{}
    appendFileSync(path,line,{mode:0o600});
  }catch{
    // 写不进去（磁盘满、权限、目录被删）就算了：诊断不能反过来弄坏业务路径。
  }
}

/** 宿主日志服务里我们要用的那一小块（cordis 4 的 Logger）。 */
export interface HostLoggerLike {
  info?(...args:unknown[]):unknown;
  warn?(...args:unknown[]):unknown;
  error?(...args:unknown[]):unknown;
}

/** cordis 的 `ctx.logger`：可调用（造一个具名 logger），本身也带级别方法。 */
export type HostLoggerService=HostLoggerLike&((name?:string)=>HostLoggerLike);

/**
 * 把宿主日志服务接上。`ctx.logger` 在 0.1.5 与 0.2.0 都是 cordis 的自带服务，
 * 但一个插件不该因为"宿主没装日志服务"就起不来——拿不到就只保留落盘那一份。
 */
export function attachHostLogger(log:DiagLog,service:unknown):boolean{
  if(!service)return false;
  let logger:HostLoggerLike;
  if(typeof service==='function'){
    try{logger=(service as HostLoggerService)(`[${log.source}]`);}
    catch{return false;}
  }else{
    logger=service as HostLoggerLike;
  }
  if(!logger||typeof logger!=='object')return false;
  log.addSink((entry)=>{
    const detail=entry.data?` ${JSON.stringify(entry.data)}`:'';
    // **抹一遍再送出去**：console 那份在 `DiagLog.push` 里已经抹过，宿主日志这一路是第二个出口，
    // 而它同样可能被导出（DSH 让第三方 exporter 订阅）。第一版这里发的是原文——
    // 实测 `token=abc123` 就这么进了宿主日志。
    const text=redactSecrets(`${entry.scope}: ${entry.message}${detail}`);
    const sink=entry.level==='error'?logger.error:entry.level==='warn'?logger.warn:logger.info;
    if(typeof sink==='function')sink.call(logger,text);
  });
  return true;
}

/**
 * 已经接过出口的那几份日志。
 *
 * `sharedLog(name)` 是**全局唯一实例**（HMR、同进程里多次 `apply`、测试里反复 boot 都拿同一份），
 * 而 `apply` 每次都会调这里——不记一笔的话，同一份日志会被接上两三次出口，于是每条记录在
 * JSONL 里重复、宿主日志里也重复。幂等在这里，而不是在每个调用点。
 */
const attached=new WeakSet<DiagLog>();

/**
 * 一次把两件事都接上：宿主日志服务 + 本地 JSONL。
 *
 * 两个插件的 `index.ts` 都只调它一次（原因与判据都在这个文件的开头）。
 * @returns 哪几路真的接上了——加载日志里要能看出"这一半到底有没有落盘出口"。
 */
export function attachDiagnostics(log:DiagLog,ctx:unknown):{host:boolean;file:string|undefined;already:boolean}{
  if(attached.has(log)){
    // 已经接过了：报告现状即可（第二次 apply 不该让每条日志写两遍）。
    return {host:known(log,'host'),file:diagFilePath(log.source),already:true};
  }
  attached.add(log);
  const service=(ctx as {logger?:unknown}|undefined)?.logger;
  const host=attachHostLogger(log,service);
  const path=diagFilePath(log.source);
  if(path)log.addSink((entry)=>appendLine(path,entry));
  remember(log,'host',host);
  return {host,file:path,already:false};
}

/** 上一次接线的结果（幂等路径上要能报出同样的现状）。 */
const wiring=new WeakMap<DiagLog,{host:boolean}>();
function remember(log:DiagLog,key:'host',value:boolean):void{wiring.set(log,{[key]:value} as {host:boolean});}
function known(log:DiagLog,key:'host'):boolean{return wiring.get(log)?.[key]??false;}
