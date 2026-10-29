import {mkdirSync,readFileSync,renameSync,writeFileSync} from 'node:fs';
import {open,readdir,realpath,stat} from 'node:fs/promises';
import {basename,extname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import {randomUUID} from 'node:crypto';
import {unzipSync,strFromU8} from 'fflate';
import {MeetingStore} from './store.js';
import {EMPTY_BRIEF,type MeetingBrief,type BriefDraft,type ReferenceFile} from './coach-types.js';

const TEXT_TYPES=new Set(['.txt','.md','.markdown','.csv','.tsv','.json','.yaml','.yml','.log','.xml','.html','.htm']);
const SKIP=new Set(['node_modules','.git','dist','build','.DS_Store']);
const FILE_LIMITS={count:8,bytes:2*1024*1024,perFileChars:12000,totalChars:40000} as const;
const eligible=(name:string)=>!name.startsWith('.')&&!SKIP.has(name)&&(TEXT_TYPES.has(extname(name).toLowerCase())||extname(name).toLowerCase()==='.docx');
export function writePrivateJson(path:string,value:unknown){const tmp=`${path}.${randomUUID()}.tmp`;writeFileSync(tmp,JSON.stringify(value),{mode:0o600});renameSync(tmp,path);}
async function workspaceRoot(cwd:string){if(typeof cwd!=='string'||!isAbsolute(cwd))throw new Error('请先在 DSH 中选择工作区。');const root=await realpath(cwd);if(!(await stat(root)).isDirectory())throw new Error('工作区目录不存在。');return root;}
async function within(root:string,path:string){
  if(typeof path!=='string'||isAbsolute(path)||path.split(/[\\/]/).includes('..'))throw new Error('只能选择当前工作区中的文件。');
  const target=await realpath(resolve(root,path));const rel=relative(root,target);
  if(rel==='..'||rel.startsWith('..'+sep)||isAbsolute(rel))throw new Error('文件链接指向工作区以外，无法添加。');return target;
}
export async function listMeetingFiles(cwd:string,dir=''){
  const root=await workspaceRoot(cwd),target=await within(root,dir);if(!(await stat(target)).isDirectory())throw new Error('无效的资料目录。');
  const rows=await readdir(target,{withFileTypes:true});const all=rows.filter(row=>!row.name.startsWith('.')&&!SKIP.has(row.name));
  const entries=all.slice(0,400).map(row=>({name:row.name,path:relative(root,join(target,row.name)),directory:row.isDirectory(),supported:row.isDirectory()||eligible(row.name)})).sort((a,b)=>Number(b.directory)-Number(a.directory)||a.name.localeCompare(b.name));
  return {root,dir:relative(root,target),entries,truncated:all.length>400};
}
function docxText(buffer:Buffer){
  const zip=unzipSync(buffer,{filter:entry=>entry.name==='word/document.xml'&&entry.originalSize<=2*1024*1024});
  const document=zip['word/document.xml'];if(!document)throw new Error('无法读取该 Word 文档的正文，或正文过大。');
  return strFromU8(document).replace(/<\/w:p>/g,'\n').replace(/<\/w:tc>/g,'\t').replace(/<[^>]*>/g,'').replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/gi,value=>{
    const named:Record<string,string>={'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'"};
    if(named[value])return named[value]!;const n=value.startsWith('&#x')?parseInt(value.slice(3,-1),16):parseInt(value.slice(2,-1),10);return Number.isFinite(n)&&n<=0x10ffff?String.fromCodePoint(n):value;
  });
}
async function snapshotFile(root:string,path:string,remaining:number):Promise<ReferenceFile>{
  if(!eligible(basename(path)))throw new Error(`暂不支持该资料格式：${basename(path)}。可另存为文本或 Markdown 后添加。`);
  const target=await within(root,path);const handle=await open(target,'r');
  try{
    const info=await handle.stat();if(!info.isFile()||info.size>FILE_LIMITS.bytes)throw new Error(`资料需为不超过 2 MB 的文件：${path}`);
    const bytes=Buffer.alloc(info.size+1);let bytesRead=0;
    while(bytesRead<bytes.length){const part=await handle.read(bytes,bytesRead,bytes.length-bytesRead,bytesRead);if(!part.bytesRead)break;bytesRead+=part.bytesRead;}
    if(bytesRead>FILE_LIMITS.bytes||bytesRead>info.size)throw new Error(`文件正在变化，请重新添加：${path}`);
    const buffer=bytes.subarray(0,bytesRead);const text=extname(path).toLowerCase()==='.docx'?docxText(buffer):new TextDecoder('utf-8',{fatal:true}).decode(buffer);
    if(text.includes('\u0000'))throw new Error(`文件不是可读取的文本：${path}`);
    const limit=Math.min(FILE_LIMITS.perFileChars,remaining);return {path:relative(root,target),size:bytesRead,text:text.slice(0,limit),truncated:text.length>limit,savedAt:Date.now()};
  }finally{await handle.close();}
}
export class BriefStore {
  constructor(private store:MeetingStore){}
  path(sessionId:string,recordingId?:string){return join(recordingId?this.store.dir(sessionId,recordingId):this.store.sessionRoot(sessionId),recordingId?'brief.json':'preparation.json');}
  read(sessionId:string,recordingId?:string):MeetingBrief {
    if(recordingId)this.store.get(sessionId,recordingId);
    try{return {...EMPTY_BRIEF,...JSON.parse(readFileSync(this.path(sessionId,recordingId),'utf8'))};}catch{return {...EMPTY_BRIEF,files:[],filePaths:[]};}
  }
  async save(sessionId:string,cwd:string,draft:BriefDraft,recordingId?:string){
    if(!draft||typeof draft!=='object')throw new Error('无效的会议准备信息。');
    if(recordingId)this.store.get(sessionId,recordingId);
    for(const key of ['invitation','role','initialViews'] as const)if(typeof draft[key]!=='string'||draft[key].length>8000)throw new Error('每项会议背景最多填写 8000 字符。');
    if(!Array.isArray(draft.filePaths)||draft.filePaths.length>FILE_LIMITS.count||!draft.filePaths.every(p=>typeof p==='string'))throw new Error('最多选择 8 个相关文件。');
    if(typeof draft.autoEnabled!=='boolean')throw new Error('无效的自动建议设置。');
    const root=cwd?await workspaceRoot(cwd):'';if(draft.filePaths.length&&!root)throw new Error('请先选择工作区。');
    const files:ReferenceFile[]=[];let remaining=FILE_LIMITS.totalChars;
    for(const path of [...new Set(draft.filePaths)]){if(remaining<=0)throw new Error('资料内容合计超过 40000 字符，请减少文件数量。');const file=await snapshotFile(root,path,remaining);files.push(file);remaining-=file.text.length;}
    const previous=this.read(sessionId,recordingId);
    const brief:MeetingBrief={invitation:draft.invitation,role:draft.role,initialViews:draft.initialViews,autoEnabled:recordingId?previous.autoEnabled:draft.autoEnabled,cwd:root,filePaths:files.map(f=>f.path),files,revision:previous.revision+1,updatedAt:Date.now()};
    mkdirSync(recordingId?this.store.dir(sessionId,recordingId):this.store.sessionRoot(sessionId),{recursive:true,mode:0o700});writePrivateJson(this.path(sessionId,recordingId),brief);return brief;
  }
  initialize(sessionId:string,recordingId:string){const draft=this.read(sessionId);if(!draft.revision)throw new Error('请先填写或确认会前准备，再开始录音。');writePrivateJson(this.path(sessionId,recordingId),{...draft,revision:1,updatedAt:Date.now()});}
  setAutomatic(sessionId:string,recordingId:string,enabled:boolean){if(typeof enabled!=='boolean')throw new Error('无效的自动建议设置。');const brief=this.read(sessionId,recordingId);brief.autoEnabled=enabled;writePrivateJson(this.path(sessionId,recordingId),brief);return {autoEnabled:enabled};}
  public(brief:MeetingBrief){return {...brief,files:brief.files.map(({text,...file})=>({...file,characters:text.length}))};}
}
