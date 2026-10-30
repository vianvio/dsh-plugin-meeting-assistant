import {mkdirSync,readFileSync,renameSync,writeFileSync} from 'node:fs';
import {readdir,realpath,stat} from 'node:fs/promises';
import {basename,extname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import {randomUUID} from 'node:crypto';
import {MeetingStore} from './store.js';
import {EMPTY_BRIEF,type MeetingBrief,type BriefDraft} from './coach-types.js';

const TEXT_TYPES=new Set(['.txt','.md','.markdown','.csv','.tsv','.json','.yaml','.yml','.log','.xml','.html','.htm']);
const SKIP=new Set(['node_modules','.git','dist','build','.DS_Store']);
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
export class BriefStore {
  constructor(private store:MeetingStore){}
  path(sessionId:string,recordingId?:string){return join(recordingId?this.store.dir(sessionId,recordingId):this.store.sessionRoot(sessionId),recordingId?'brief.json':'preparation.json');}
  read(sessionId:string,recordingId?:string):MeetingBrief {
    if(recordingId)this.store.get(sessionId,recordingId);
    try{const saved=JSON.parse(readFileSync(this.path(sessionId,recordingId),'utf8'));return {...EMPTY_BRIEF,...saved,goal:typeof saved.goal==='string'?saved.goal:'',files:Array.isArray(saved.files)?saved.files:[],filePaths:Array.isArray(saved.filePaths)?saved.filePaths:[]};}catch{return {...EMPTY_BRIEF,files:[],filePaths:[]};}
  }
  async save(sessionId:string,cwd:string,draft:BriefDraft,recordingId?:string){
    if(!draft||typeof draft!=='object')throw new Error('无效的会议准备信息。');
    if(recordingId)this.store.get(sessionId,recordingId);
    for(const key of ['invitation','role','initialViews'] as const)if(typeof draft[key]!=='string'||draft[key].length>8000)throw new Error('每项会议背景最多填写 8000 字符。');
    if(draft.goal!==undefined&&(typeof draft.goal!=='string'||draft.goal.length>8000))throw new Error('会议目标最多填写 8000 字符。');
    if(typeof draft.autoEnabled!=='boolean')throw new Error('无效的自动建议设置。');
    const previous=this.read(sessionId,recordingId);
    // A recording stays bound to the project confirmed before it started. Saving is text-only.
    const root=recordingId?previous.cwd:(cwd?await workspaceRoot(cwd):'');
    const brief:MeetingBrief={invitation:draft.invitation,goal:draft.goal??previous.goal,role:draft.role,initialViews:draft.initialViews,autoEnabled:recordingId?previous.autoEnabled:draft.autoEnabled,cwd:root,filePaths:[],files:[],revision:previous.revision+1,updatedAt:Date.now()};
    mkdirSync(recordingId?this.store.dir(sessionId,recordingId):this.store.sessionRoot(sessionId),{recursive:true,mode:0o700});writePrivateJson(this.path(sessionId,recordingId),brief);return brief;
  }
  initialize(sessionId:string,recordingId:string){const draft=this.read(sessionId);if(!draft.revision)throw new Error('请先填写或确认会前准备，再开始录音。');writePrivateJson(this.path(sessionId,recordingId),{...draft,revision:1,updatedAt:Date.now()});}
  setAutomatic(sessionId:string,recordingId:string,enabled:boolean){if(typeof enabled!=='boolean')throw new Error('无效的自动建议设置。');const brief=this.read(sessionId,recordingId);brief.autoEnabled=enabled;writePrivateJson(this.path(sessionId,recordingId),brief);return {autoEnabled:enabled};}
  public(brief:MeetingBrief){return {...brief,files:brief.files.map(({text,...file})=>({...file,characters:text.length}))};}
}
