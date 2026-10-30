import React,{useCallback,useEffect,useRef,useState} from 'react';
import type {VoiceCall} from './capture.js';
import type {PluginUpdateStatus} from './update-types.js';

const button:React.CSSProperties={border:'1px solid #8884',borderRadius:8,background:'transparent',color:'inherit',padding:'7px 11px',cursor:'pointer',fontSize:12,lineHeight:1.5};
const muted:React.CSSProperties={fontSize:12,opacity:.6,lineHeight:1.7};
type Operation='check'|'settings'|'install';
const requestErrors:Record<Operation,string>={check:'检查更新失败，请重试。',settings:'保存自动更新设置失败，请重试。',install:'更新请求失败，请重试。'};
const STABLE_VERSION=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** Match the updater's stable-version policy without numeric precision loss. */
export function isNewerPluginVersion(candidate:unknown,current:unknown):boolean{
  if(typeof candidate!=='string'||typeof current!=='string'||candidate.length>256||current.length>256||candidate.trim()!==candidate||current.trim()!==current||!STABLE_VERSION.test(candidate)||!STABLE_VERSION.test(current))return false;
  const left=candidate.split('.'),right=current.split('.');
  for(let index=0;index<3;index++){
    if(left[index]!.length!==right[index]!.length)return left[index]!.length>right[index]!.length;
    if(left[index]!==right[index])return left[index]!>right[index]!;
  }
  return false;
}

function phaseMessage(status:PluginUpdateStatus):string{
  if(status.source==='development')return '源码开发安装，请在项目中更新。';
  switch(status.phase){
    case 'idle':return status.lastCheckedAt!==null?'已是最新版本。':'尚未检查更新。';
    case 'checking':return '正在检查更新…';
    case 'available':return isNewerPluginVersion(status.latestVersion,status.currentVersion)?'有新版本可更新。':'已是最新版本。';
    case 'waiting':return isNewerPluginVersion(status.latestVersion,status.currentVersion)?'会议或 AI 正在忙，空闲后更新。':'已是最新版本。';
    case 'installing':return '正在更新插件…';
    case 'restart':return isNewerPluginVersion(status.installedVersion,status.currentVersion)?'已安装，重开 DSH 后生效。':'已是最新版本。';
    case 'error':return status.error?.replace(/\s+/g,' ').trim().slice(0,140)||'插件更新失败，请重试。';
    case 'unsupported':return '当前安装方式不支持自动更新。';
  }
}

/** Update preferences belong to the plugin profile, so no request carries a meeting session. */
export function PluginUpdates({call,visible=true,currentVersion='',onStatusChange}:{call:VoiceCall;visible?:boolean;currentVersion?:string;onStatusChange?:(status:PluginUpdateStatus)=>void}){
  const [status,setStatus]=useState<PluginUpdateStatus|null>(null),[busy,setBusy]=useState<Operation|null>(null);
  const [readError,setReadError]=useState(''),[actionError,setActionError]=useState('');
  const service=useRef(call),statusListener=useRef(onStatusChange),mounted=useRef(false),sequence=useRef(0);
  const pendingRead=useRef<number|null>(null),operation=useRef<Operation|null>(null);
  service.current=call;statusListener.current=onStatusChange;
  const read=useCallback(async()=>{
    if(!mounted.current||operation.current||(pendingRead.current!==null&&pendingRead.current===sequence.current))return;
    const request=++sequence.current;pendingRead.current=request;
    try{
      const next:PluginUpdateStatus=await service.current('update/status',{});
      if(mounted.current&&request===sequence.current){setStatus(next);setReadError('');statusListener.current?.(next);}
    }catch{
      if(mounted.current&&request===sequence.current)setReadError('读取更新状态失败，请重试。');
    }finally{if(pendingRead.current===request)pendingRead.current=null;}
  },[]);
  useEffect(()=>{
    mounted.current=true;void read();
    return ()=>{mounted.current=false;sequence.current++;operation.current=null;pendingRead.current=null;};
  },[read]);
  useEffect(()=>{
    if(!visible)return;
    void read();const timer=setInterval(()=>void read(),1500);
    return ()=>{
      clearInterval(timer);
      if(pendingRead.current!==null&&pendingRead.current===sequence.current)sequence.current++;
    };
  },[visible,read]);

  const development=status?.source==='development';
  const locked=!!busy||status?.phase==='checking'||status?.phase==='installing';
  const pendingRestart=isNewerPluginVersion(status?.installedVersion,status?.currentVersion);
  const hasUpdate=isNewerPluginVersion(status?.latestVersion,status?.currentVersion);
  const targetVersion=pendingRestart?status?.installedVersion:hasUpdate?status?.latestVersion:null;
  const cannotEnableAuto=!!status&&(!status.canInstall||status.phase==='unsupported');
  const installable=!!status&&status.canInstall&&status.phase!=='unsupported'&&!development&&hasUpdate&&!pendingRestart;
  const act=async(kind:Operation,payload:Record<string,unknown>={})=>{
    if(!mounted.current||operation.current||locked)return;
    if((kind==='settings'&&(!status||development||payload.enabled===true&&cannotEnableAuto))||(kind==='install'&&!installable))return;
    // Invalidate reads before sending a write; polling stays paused until it settles.
    const request=++sequence.current;operation.current=kind;setBusy(kind);setActionError('');setReadError('');
    try{
      const next:PluginUpdateStatus=await service.current(`update/${kind}`,payload);
      if(mounted.current&&request===sequence.current){setStatus(next);statusListener.current?.(next);}
    }catch{
      if(mounted.current&&request===sequence.current)setActionError(requestErrors[kind]);
    }finally{
      if(mounted.current&&request===sequence.current){operation.current=null;setBusy(null);}
    }
  };
  const error=actionError||readError;
  return <section aria-label="插件更新" style={{maxWidth:460}}>
    <div style={{display:'grid',gap:10,lineHeight:1.7,marginBottom:24}}>
      <div>当前版本 <span style={{fontVariantNumeric:'tabular-nums'}}>{status?.currentVersion||currentVersion||'读取中…'}</span></div>
      {targetVersion&&<div>{pendingRestart?'已安装待重启版本':'可用版本'} <span style={{fontVariantNumeric:'tabular-nums'}}>{targetVersion}</span></div>}
    </div>
    <label style={{display:'flex',alignItems:'center',gap:9,fontSize:13}}>
      <input type="checkbox" aria-label="自动更新插件" checked={status?.autoUpdate??false} disabled={!status||locked||development||!status.autoUpdate&&cannotEnableAuto} onChange={event=>void act('settings',{enabled:event.target.checked})}/>
      自动更新插件
    </label>
    <p style={{...muted,margin:'8px 0 20px'}}>每天检查，录音和分析结束后自动更新。</p>
    <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
      <button type="button" style={{...button,opacity:locked?0.5:1}} disabled={locked} onClick={()=>void act('check')}>{busy==='check'||status?.phase==='checking'?'正在检查…':'立即检查'}</button>
      {hasUpdate&&!pendingRestart&&<button type="button" style={{...button,background:'#2769e7',borderColor:'#2769e7',color:'white',opacity:locked||!installable?0.5:1}} disabled={locked||!installable} onClick={()=>void act('install')}>{busy==='install'||status?.phase==='installing'?'正在更新…':status?.phase==='waiting'?'空闲后更新':'立即更新'}</button>}
    </div>
    {status&&<p role={status.phase==='error'&&!development?'alert':'status'} style={{...muted,color:status.phase==='error'&&!development?'#c24b43':undefined,overflowWrap:'anywhere'}}>{phaseMessage(status)}</p>}
    {error&&<p role="alert" style={{fontSize:12,lineHeight:1.7,color:'#c24b43',overflowWrap:'anywhere'}}>{error}</p>}
    {!status&&!error&&<p role="status" style={muted}>正在读取更新状态…</p>}
  </section>;
}
