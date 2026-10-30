import type {Context} from '@deepseek-ai/cordis';
import {readFileSync,writeFileSync,renameSync,unlinkSync,existsSync} from 'node:fs';
import {join,isAbsolute} from 'node:path';
import {randomUUID} from 'node:crypto';
import {optionalService} from './services.js';
import type {PluginUpdateStatus} from './update-types.js';

export const UPDATE_PACKAGE='dsh-plugin-meeting-assistant';
export const UPDATE_REGISTRY='https://registry.npmjs.org/';
export const STABLE_VERSION=/^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;
export interface UpdateProfile {
  profile?:string;name?:string;dir:string;home?:string;installAnchor:string;
  packageManager?:{command:string;args?:string[];env?:Record<string,string>};
}
type RunResult={exitCode:number|null;timedOut?:boolean;incompatible?:unknown[]};
export type RunUpdate=(profile:UpdateProfile&{profile:string;cwd:string},args:string[],options:{
  execution:'service';outputBytes:number;idleTimeoutMs:number;lockWaitMs:number;
  signal:AbortSignal;command?:string;args?:string[];env?:Record<string,string>;
})=>Promise<RunResult>;
export interface Installation {version:string|null;source:PluginUpdateStatus['source'];canInstall:boolean}
export type StoredUpdatePreferences={autoUpdate?:boolean;lastCheckedAt?:number|null;latestVersion?:string|null};

const readJson=(path:string)=>JSON.parse(readFileSync(path,'utf8')) as Record<string,any>;
export function updateSource(spec:unknown):Installation['source']{
  if(typeof spec!=='string'||!spec.trim())return 'unknown';
  if(/^(?:file:)?[^\n]+\.tgz$/i.test(spec)||/^https:\/\/[^\s]+\.tgz(?:[?#].*)?$/i.test(spec))return 'archive';
  if(/^(?:link:|workspace:|file:|git(?:\+|:)|github:|gitlab:|bitbucket:|https?:|\/|\.\.?\/)/.test(spec))return 'development';
  if(/^(?:latest|[~^=]?\d[^\n]*|\*|[<>][^\n]+)$/.test(spec))return 'npm';
  return 'unknown';
}

/** Fixed-package adapter over the same locked operations used by `dsh plugin`. */
export function createUpdateDriver(ctx:Context,overrides:{profile?:UpdateProfile;run?:RunUpdate;fetch?:typeof fetch}={}){
  const candidate=overrides.profile??optionalService<UpdateProfile>(ctx,'profileContext');
  const profileName=typeof candidate?.profile==='string'?candidate.profile:candidate?.name;
  const profile=candidate&&typeof profileName==='string'&&profileName.length>0&&typeof candidate.dir==='string'&&isAbsolute(candidate.dir)&&
    typeof candidate.installAnchor==='string'&&isAbsolute(candidate.installAnchor)&&
    existsSync(join(candidate.dir,'package.json'))?{...candidate,profile:profileName}:undefined;
  const supported=()=>!!profile&&(!!overrides.run||typeof optionalService<{listBundles?:unknown}>(ctx,'pluginManager')?.listBundles==='function');
  const inspect=():Installation=>{
    if(!profile)return {version:null,source:'unknown',canInstall:false};
    const manifest=readJson(join(profile.dir,'package.json'));
    const source=updateSource(manifest.dependencies?.[UPDATE_PACKAGE]);
    let version:string|null=null;
    try{const installed=readJson(join(profile.dir,'node_modules',UPDATE_PACKAGE,'package.json'));if(installed.name===UPDATE_PACKAGE&&typeof installed.version==='string')version=installed.version;}catch{}
    return {version,source,canInstall:supported()&&['npm','archive'].includes(source)};
  };
  const preferences=profile?join(profile.dir,'.meeting-assistant-updates.json'):undefined;
  return {
    key:profile?.dir,
    inspect,
    load:():StoredUpdatePreferences=>{
      if(!preferences)return {autoUpdate:false};
      try{return readJson(preferences);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return {};throw new Error('无法读取插件更新设置，请重新保存。');}
    },
    save:(value:StoredUpdatePreferences)=>{
      if(!preferences)throw new Error('当前 DSH 未提供插件更新能力。');
      const tmp=preferences+'.'+randomUUID()+'.tmp';
      try{writeFileSync(tmp,JSON.stringify(value)+'\n',{mode:0o600,flag:'wx'});renameSync(tmp,preferences);}
      catch(error){try{if(existsSync(tmp))unlinkSync(tmp);}catch{}throw error;}
    },
    latest:async(signal:AbortSignal)=>{
      const response=await (overrides.fetch??fetch)(UPDATE_REGISTRY+UPDATE_PACKAGE+'/latest',{signal,redirect:'error',headers:{Accept:'application/json'}});
      if(!response.ok)throw new Error('暂时无法检查插件更新，请稍后重试。');
      const text=await response.text();
      if(text.length>512_000)throw new Error('插件版本信息无效。');
      const metadata=JSON.parse(text);
      if(metadata.name!==UPDATE_PACKAGE||typeof metadata.version!=='string'||!STABLE_VERSION.test(metadata.version)||!metadata.dsh?.bundle)throw new Error('未找到可用的插件稳定版。');
      return metadata.version as string;
    },
    install:async(version:string,signal:AbortSignal)=>{
      if(!profile||!inspect().canInstall)throw new Error('当前安装方式不支持自动更新。');
      if(!STABLE_VERSION.test(version))throw new Error('插件版本无效。');
      let run=overrides.run;
      if(!run)try{run=(await import('@deepseek-ai/dsh-plugin-manager/operations')).runPluginCommand as RunUpdate;}
      catch{throw new Error('请先升级 DSH，或使用命令行更新插件。');}
      if(typeof run!=='function')throw new Error('请先升级 DSH，再使用插件自动更新。');
      signal.throwIfAborted();
      const result=await run({...profile,cwd:profile.dir},['add',UPDATE_PACKAGE+'@'+version,'--save-exact','--registry='+UPDATE_REGISTRY],{
        execution:'service',outputBytes:16_384,idleTimeoutMs:120_000,lockWaitMs:1_000,
        ...profile.packageManager,signal,
      });
      if(result.incompatible?.length)throw new Error('新版插件与当前 DSH 不兼容，请先升级 DSH。');
      if(result.exitCode!==0||result.timedOut)throw new Error('插件更新失败，请稍后重试。');
      if(inspect().version!==version)throw new Error('尚未确认新版已安装，请检查 DSH 插件管理。');
    },
  };
}
