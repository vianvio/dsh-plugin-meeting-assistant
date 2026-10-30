import {constants} from 'node:fs';
import {open,opendir,realpath,stat} from 'node:fs/promises';
import {extname,isAbsolute,join,relative,sep} from 'node:path';
import {unzipSync,strFromU8} from 'fflate';

/** Limits apply per explicit request; there is no save/start-time scan or stale cache. */
export const PROJECT_CONTEXT_LIMITS={
  entries:12000,directories:2000,indexChars:32000,scanBytes:8*1024*1024,
  perFileBytes:256*1024,contentChars:48000,snippetChars:3200,snippets:80,timeoutMs:8000,
} as const;
export const PROJECT_EXCLUDED_DIRECTORIES=['.git','node_modules','.pnpm','.yarn','.next','.nuxt','.cache','__pycache__','.venv','venv','dist','build','coverage','target'] as const;
const EXCLUDED=new Set<string>(PROJECT_EXCLUDED_DIRECTORIES);
const BINARY_EXTENSIONS=new Set(['.png','.jpg','.jpeg','.gif','.webp','.ico','.pdf','.zip','.gz','.tgz','.woff','.woff2','.ttf','.mp3','.mp4','.wav','.pcm','.sqlite','.db','.exe','.dll','.so','.dylib','.class','.pyc','.wasm','.lockb']);
export interface ProjectSnippet {path:string;text:string;startLine:number;endLine:number;truncated:boolean}
export interface ProjectContext {
  cwd:string;
  index:Array<{path:string;kind:'file'|'directory';bytes?:number}>;
  snippets:ProjectSnippet[];
  metadata:{
    scope:'entire-project';partialContent:true;notice:string;
    limits:typeof PROJECT_CONTEXT_LIMITS;excludedDirectories:readonly string[];
    indexedFiles:number;visitedDirectories:number;indexTruncated:boolean;scanTruncated:boolean;
    readFiles:number;scannedBytes:number;skippedSymlinks:number;skippedBinaryFiles:number;
    truncatedFiles:number;unreadFiles:number;readErrors:number;contentChars:number;selectedFiles:number;contentTruncated:boolean;warnings:string[];
  };
}

/** Match explicit credential keys, preserving token usage/pricing and other business facts. */
export function redactCredentials(text:string):string {
  return text
    .replace(/-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)* PRIVATE KEY-----/g,'[hidden private key]')
    .replace(/\b(?:sk-[\w-]+|gh[pousr]_[\w]+|github_pat_[\w]+|AKIA[A-Z0-9]{16})\b/g,'[hidden]')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi,'$1[hidden]')
    .replace(/((["']?\b(?:[\w.-]{0,96}[_.-])?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|bearer[_-]?token|client[_-]?secret|secret[_-]?key|private[_-]?key|password|passwd|authorization)["']?)\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}]+)/gi,'$1"[hidden]"')
    .replace(/(\b[a-z][a-z0-9+.-]{0,30}:\/\/)[^\s/@]+:[^\s/@]+@/gi,'$1[hidden]@');
}
export const projectJson=(value:unknown)=>JSON.stringify(value,(_key,item)=>typeof item==='string'?redactCredentials(item):item);
export function unavailableProjectContext(cwd:string,error?:unknown):ProjectContext {
  return {cwd,index:[],snippets:[],metadata:{scope:'entire-project',partialContent:true,notice:'项目资料仅按预算检索相关片段；未读取全部文件内容。',
    limits:PROJECT_CONTEXT_LIMITS,excludedDirectories:PROJECT_EXCLUDED_DIRECTORIES,indexedFiles:0,visitedDirectories:0,indexTruncated:false,scanTruncated:false,
    readFiles:0,scannedBytes:0,skippedSymlinks:0,skippedBinaryFiles:0,truncatedFiles:0,unreadFiles:0,readErrors:0,contentChars:0,selectedFiles:0,contentTruncated:false,
    warnings:error?[redactCredentials(error instanceof Error?error.message:'项目资料暂不可读取。')]:[]}};
}
function within(root:string,target:string){const path=relative(root,target);return path!=='..'&&!path.startsWith('..'+sep)&&!isAbsolute(path);}
function terms(query:string|readonly string[]){
  // Round-robin across goal, invitation and recent transcript, so a long invite cannot crowd out this round.
  const groups=(typeof query==='string'?[query]:query).map(part=>{
    const tokens=(redactCredentials(part).toLowerCase().match(/[a-z0-9_][a-z0-9_.-]{1,60}|[\u3400-\u9fff]{2,}/g)??[]),result=new Set<string>();
    for(const token of tokens){if(token.length<=64)result.add(token);if(/[\u3400-\u9fff]/.test(token))for(let i=0;i<token.length-1;i++)result.add(token.slice(i,i+2));}
    return [...result];
  });
  const result=new Set<string>();
  for(let i=0;result.size<200&&groups.some(group=>i<group.length);i++)for(const group of groups){if(group[i])result.add(group[i]!);if(result.size>=200)break;}
  return [...result];
}
function relevance(text:string,queryTerms:string[]){const lower=text.toLowerCase();let score=0;for(const term of queryTerms)if(lower.includes(term))score+=Math.min(term.length,16);return score;}
function priority(path:string,queryTerms:string[]){
  return relevance(path,queryTerms)*20+(/(^|\/)(readme|agents|package\.json|\.notes)(\.|\/|$)/i.test(path)?10:0)+(/\.(md|txt|ts|tsx|js|py|go|rs|java|docx)$/i.test(path)?2:0);
}
function decode(buffer:Buffer){
  if(buffer.includes(0))return null;
  try{
    const text=new TextDecoder('utf-8',{fatal:true}).decode(buffer);
    const controls=text.match(/[\u0001-\u0008\u000b\u000e-\u001f]/g)?.length??0;
    return controls>Math.max(2,text.length*0.005)?null:text;
  }catch{return null;}
}
function docxText(buffer:Buffer){
  const zip=unzipSync(buffer,{filter:entry=>entry.name==='word/document.xml'&&entry.originalSize<=1024*1024});
  const document=zip['word/document.xml'];if(!document)return null;
  return strFromU8(document).replace(/<\/w:p>/g,'\n').replace(/<\/w:tc>/g,'\t').replace(/<[^>]*>/g,'').replace(/&(?:amp|lt|gt|quot|apos);/g,value=>({'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'"}[value]??value));
}
type Candidate=ProjectSnippet & {score:number;order:number};
function fragments(path:string,text:string,truncated:boolean,queryTerms:string[],order:number):Candidate[]{
  const chunks:Candidate[]=[];let offset=0,line=1;
  while(offset<text.length){
    let end=Math.min(offset+PROJECT_CONTEXT_LIMITS.snippetChars,text.length);
    if(end<text.length){const newline=text.lastIndexOf('\n',end);if(newline>offset+PROJECT_CONTEXT_LIMITS.snippetChars/2)end=newline+1;}
    const fragment=text.slice(offset,end),count=(fragment.match(/\n/g)??[]).length;
    chunks.push({path,text:fragment,startLine:line,endLine:line+count,score:relevance(fragment,queryTerms)+relevance(path,queryTerms)*3,order,truncated:truncated||offset>0||end<text.length});
    line+=count;offset=end;
  }
  return chunks.sort((a,b)=>b.score-a.score||a.startLine-b.startLine).slice(0,2);
}

export async function loadProjectContext(cwd:string,query:string|readonly string[],signal?:AbortSignal):Promise<ProjectContext>{
  if(typeof cwd!=='string'||!isAbsolute(cwd))throw new Error('请先在 DSH 中选择项目目录。');
  const root=await realpath(cwd);if(!(await stat(root)).isDirectory())throw new Error('项目目录不存在。');
  const result=unavailableProjectContext(root),meta=result.metadata;
  const deadline=Date.now()+PROJECT_CONTEXT_LIMITS.timeoutMs;
  const check=()=>{signal?.throwIfAborted();if(Date.now()>deadline)throw new Error('项目资料检索已超时。');};
  const queryTerms=terms(query),queue=[root],files:Array<{path:string;bytes:number}>=[];
  let entries=0,indexChars=2;
  const addIndex=(row:ProjectContext['index'][number])=>{const chars=JSON.stringify(row).length+(result.index.length?1:0);if(indexChars+chars>PROJECT_CONTEXT_LIMITS.indexChars){meta.indexTruncated=true;return;}result.index.push(row);indexChars+=chars;};
  while(queue.length&&entries<PROJECT_CONTEXT_LIMITS.entries&&meta.visitedDirectories<PROJECT_CONTEXT_LIMITS.directories){
    check();const directory=queue.shift()!;
    try{
      const resolved=await realpath(directory);if(!within(root,resolved)){meta.skippedSymlinks++;continue;}
      const handle=await opendir(directory);meta.visitedDirectories++;
      for await(const row of handle){
        check();if(entries>=PROJECT_CONTEXT_LIMITS.entries){meta.indexTruncated=true;break;}entries++;
        const path=join(directory,row.name),rel=relative(root,path);
        if(row.isSymbolicLink()){meta.skippedSymlinks++;continue;}
        if(row.isDirectory()){if(EXCLUDED.has(row.name))continue;addIndex({path:rel,kind:'directory'});queue.push(path);}
        else if(row.isFile()){
          try{const info=await stat(path);files.push({path:rel,bytes:info.size});meta.indexedFiles++;addIndex({path:rel,kind:'file',bytes:info.size});}catch{meta.readErrors++;}
        }
      }
    }catch(error){signal?.throwIfAborted();if(Date.now()>deadline)throw error;meta.readErrors++;}
  }
  if(queue.length||entries>=PROJECT_CONTEXT_LIMITS.entries)meta.indexTruncated=true;
  files.sort((a,b)=>priority(b.path,queryTerms)-priority(a.path,queryTerms)||a.path.localeCompare(b.path));
  const candidates:Candidate[]=[];
  for(const [order,file] of files.entries()){
    check();if(meta.scannedBytes>=PROJECT_CONTEXT_LIMITS.scanBytes){meta.scanTruncated=true;break;}
    if(BINARY_EXTENSIONS.has(extname(file.path).toLowerCase())){meta.skippedBinaryFiles++;continue;}
    let handle:Awaited<ReturnType<typeof open>>|undefined;
    try{
      const target=await realpath(join(root,file.path));if(!within(root,target)){meta.skippedSymlinks++;continue;}
      handle=await open(target,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
      const info=await handle.stat();if(!info.isFile())continue;
      const count=Math.min(info.size,PROJECT_CONTEXT_LIMITS.perFileBytes,PROJECT_CONTEXT_LIMITS.scanBytes-meta.scannedBytes);
      if(count<=0)continue;
      const buffer=Buffer.alloc(count);let bytesRead=0;
      while(bytesRead<count){check();const part=await handle.read(buffer,bytesRead,count-bytesRead,bytesRead);if(!part.bytesRead)break;bytesRead+=part.bytesRead;meta.scannedBytes+=part.bytesRead;}
      const truncated=bytesRead<info.size;if(truncated)meta.truncatedFiles++;
      // A clipped UTF-8 codepoint at the budget boundary is not a binary file.
      let body=buffer.subarray(0,bytesRead);if(truncated)for(let i=0;i<3&&body.length&&decode(body)===null;i++)body=body.subarray(0,body.length-1);
      const text=extname(file.path).toLowerCase()==='.docx'?(truncated?null:docxText(body)):decode(body);
      if(text===null){meta.skippedBinaryFiles++;continue;}
      meta.readFiles++;candidates.push(...fragments(file.path,redactCredentials(text),truncated,queryTerms,order));
    }catch{signal?.throwIfAborted();meta.readErrors++;}
    finally{await handle?.close().catch(()=>{});}
  }
  // Rank passages globally; equal scores retain broad file coverage before second passages.
  candidates.sort((a,b)=>b.score-a.score||a.startLine-b.startLine||a.order-b.order);
  let characters=0;
  for(const candidate of candidates){
    const remaining=PROJECT_CONTEXT_LIMITS.contentChars-characters;
    if(remaining<=0||result.snippets.length>=PROJECT_CONTEXT_LIMITS.snippets)break;
    const {score:_score,order:_order,...snippet}=candidate;
    snippet.text=snippet.text.slice(0,remaining);snippet.truncated||=snippet.text.length<candidate.text.length;
    if(snippet.truncated&&snippet.text.length<candidate.text.length)snippet.endLine=snippet.startLine+(snippet.text.match(/\n/g)??[]).length;
    result.snippets.push(snippet);characters+=snippet.text.length;
  }
  meta.contentChars=characters;meta.selectedFiles=new Set(result.snippets.map(snippet=>snippet.path)).size;
  meta.contentTruncated=result.snippets.length<candidates.length||characters<candidates.reduce((total,candidate)=>total+candidate.text.length,0)||meta.truncatedFiles>0;
  meta.unreadFiles=Math.max(0,meta.indexedFiles-meta.readFiles-meta.skippedBinaryFiles);
  meta.scanTruncated||=meta.truncatedFiles>0||meta.unreadFiles>0;
  if(meta.indexTruncated)meta.warnings.push('目录索引达到预算，未列出全部路径。');
  if(meta.scanTruncated)meta.warnings.push('检索内容达到预算或有文件未读；片段之外的内容未经核实。');
  if(meta.contentTruncated)meta.warnings.push('仅发送按相关度选出的片段，部分已检索内容未包含在本次请求中。');
  if(meta.readErrors)meta.warnings.push('部分路径不可读取。');
  return result;
}
