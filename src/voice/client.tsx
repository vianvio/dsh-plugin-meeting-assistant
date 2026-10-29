import React,{useEffect,useRef,useState,useSyncExternalStore} from 'react';
import { THEME } from '../shared/theme.js';
import {MeetingCapture,type VoiceCall} from './capture.js';
import type {MeetingMeta,TranscriptEntry} from './store.js';
import {dockStore} from '../shared/dock/dock-store.js';
import {BriefEditor,AdvicePanel,type BriefCache} from './coach-ui.js';
import type {CoachStatus} from './coach-types.js';

/** This panel's identity in the shared dock; the node panel uses another one. */
const PANEL_ID='meeting-assistant-panel';

type Status={coach:CoachStatus|null;active:{sessionId:string;id:string;state:string}|null;recordings:MeetingMeta[];result:{recording:MeetingMeta;entries:TranscriptEntry[];transcriptPath:string}|null};
const button:React.CSSProperties={border:'1px solid #8885',borderRadius:8,background:'transparent',color:'inherit',padding:'6px 10px',cursor:'pointer',fontSize:12};
const time=(ms:number)=>{const seconds=Math.max(0,Math.floor(ms/1000));return `${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`;};
const stateLabel:Record<string,string>={connecting:'连接中',recording:'录音中',reconnecting:'连接恢复中',stopping:'正在保存',stopped:'已结束',error:'录音异常',interrupted:'已中断'};

export function MeetingToggle({sessionId,call,capture,available,closeDetails,getCwd,briefCache}:{sessionId:string;call:VoiceCall;capture:MeetingCapture;available:boolean;closeDetails:()=>void;getCwd:()=>string;briefCache:BriefCache}){
  const local=useSyncExternalStore(capture.subscribe,capture.snapshot);
  const [status,setStatus]=useState<Status|null>(null),[panel,setPanel]=useState(false),[settings,setSettings]=useState(false),[error,setError]=useState(''),[exporting,setExporting]=useState(false);
  const [tab,setTab]=useState<'brief'|'transcript'|'advice'>('transcript'),[preparing,setPreparing]=useState(false),[seenAdvice,setSeenAdvice]=useState<string|null>(null);
  const wantFocus=useRef(false);
  useEffect(()=>{if(!available)return;let cancelled=false,timer:ReturnType<typeof setTimeout>;setStatus(null);setError('');
    const poll=async()=>{const observedAt=Date.now();try{const next:Status=await call('status',{sessionId});if(cancelled)return;setStatus(next);setError('');capture.reconcile(next.active,observedAt);}catch(e){if(!cancelled)setError(e instanceof Error?e.message:String(e));}finally{if(!cancelled)timer=setTimeout(()=>void poll(),1500);}};
    void poll();return ()=>{cancelled=true;clearTimeout(timer);};
  },[sessionId,call,capture,available]);
  useEffect(()=>{if(panel&&tab==='advice'&&status?.coach?.latestId)setSeenAdvice(status.coach.latestId);},[panel,tab,status?.coach?.latestId]);
  if(!available)return null;
  const meta=preparing?undefined:status?.result?.recording;
  const active=!!status?.active||local.recording;
  const other=active&&(status?.active?.sessionId??local.sessionId)!==sessionId;
  const refresh=async()=>{setStatus(await call('status',{sessionId}));};
  // Opening the panel is a user action, so it takes the dock's front tab; the
  // node panel may be the one in front. `wantFocus` carries that intent into the
  // effect that registers the panel, because a state update alone does not
  // re-run it when the panel is already open.
  const openPanel=()=>{closeDetails();if(dockStore.has(PANEL_ID))dockStore.activate(PANEL_ID);wantFocus.current=true;setPanel(true);};
  const togglePanel=()=>{
    if(!panel){openPanel();return;}
    // Already open behind the other tab: bring it forward instead of closing it,
    // which is what a click on a visible-but-inactive tab means everywhere else.
    if(dockStore.getSnapshot().active!==PANEL_ID){dockStore.activate(PANEL_ID);return;}
    setPanel(false);
  };
  const toggle=async()=>{openPanel();if(local.recording)await capture.stop();else if(!status?.active){setPreparing(true);setTab('brief');}};
  const begin=async()=>{await capture.start(sessionId);if(capture.snapshot().recording&&capture.snapshot().sessionId===sessionId){await refresh();setPreparing(false);setTab('transcript');}};
  const select=async(recordingId:string)=>{try{await call('select',{sessionId,recordingId});setPreparing(false);await refresh();}catch(e){setError(String(e));}};
  const exportText=async()=>{if(!meta)return;setExporting(true);try{
    const text:string[]=[`会议记录 · ${new Date(meta.startedAt).toLocaleString()}`];let afterLine=0;
    for(let page=0;page<100;page++){const result=await call('read',{sessionId,recordingId:meta.id,afterLine,lines:200});for(const entry of result.entries as TranscriptEntry[])if(entry.line<=meta.segments)text.push(`[${time(entry.ts-meta.startedAt)}] ${entry.text}`);
      if(!result.hasMore||result.nextAfterLine>=meta.segments)break;if(result.nextAfterLine<=afterLine)throw new Error('转写读取未能继续');afterLine=result.nextAfterLine;
    }
    const url=URL.createObjectURL(new Blob([text.join('\n\n')],{type:'text/plain;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download=`会议-${new Date(meta.startedAt).toISOString().replace(/[:.]/g,'-')}.txt`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }catch(e){setError(e instanceof Error?e.message:String(e));}finally{setExporting(false);}};
  const freshAdvice=!preparing&&!!status?.coach?.latestId&&seenAdvice!==status.coach.latestId;
  // The dock owns the column; this component owns whether its panel belongs there.
  // Re-registering on every render keeps the body closure live, and passing
  // `onClose` means the dock can put the toggle back when it yields the column to
  // the native tool-details panel.
  const body=<section aria-label="会议助手" onKeyDown={event=>event.stopPropagation()} onPaste={event=>event.stopPropagation()} onClick={event=>event.stopPropagation()} onPointerDown={event=>event.stopPropagation()} style={{height:'100%',minHeight:0,boxSizing:'border-box',display:'flex',flexDirection:'column',padding:'18px 16px',fontSize:13}}>
    <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:12,flexShrink:0}}><strong style={{fontSize:16}}>{preparing?'新会议准备':'会议助手'}</strong><button style={button} aria-label="收起会议转写" onClick={()=>setPanel(false)}>×</button></div>
    {other&&<p role="status" style={{margin:'0 0 10px',color:'#dc5e57'}}>另一个会话正在录音，记录和建议属于开始录音的会话。</p>}
    {!preparing&&!!status?.recordings.length&&<select aria-label="选择会议记录" value={meta?.id??''} onChange={e=>void select(e.target.value)} style={{...button,width:'100%',marginBottom:10,flexShrink:0}}>{status.recordings.map(item=><option value={item.id} key={item.id}>{new Date(item.startedAt).toLocaleString()} · {item.segments} 句</option>)}</select>}
    {meta&&<div role="status" style={{display:'flex',justifyContent:'space-between',opacity:.65,marginBottom:12,fontSize:12,flexShrink:0}}><span>{stateLabel[meta.state]??meta.state} · {time((meta.endedAt??Date.now())-meta.startedAt)}</span><span>{meta.segments} 句{meta.reconnects>0?` · 重连 ${meta.reconnects} 次`:''}</span></div>}
    {(local.error||error)&&<p role="alert" style={{color:'#dc5e57',whiteSpace:'pre-wrap',overflowWrap:'anywhere',margin:'0 0 10px'}}>{local.error||error}</p>}
    <div role="tablist" aria-label="会议助手页面" style={{display:'flex',gap:4,borderBottom:'1px solid #8883',marginBottom:14,flexShrink:0}}>{([['brief','会前准备'],['transcript','实时转写'],['advice','发言建议']] as const).map(([key,label])=><button type="button" role="tab" aria-selected={tab===key} key={key} onClick={()=>setTab(key)} style={{...button,flex:1,border:0,borderRadius:0,borderBottom:tab===key?'2px solid #2769e7':'2px solid transparent',color:tab===key?'#2769e7':'inherit',padding:'9px 1px'}}>{label}{key==='advice'&&freshAdvice?' ●':''}</button>)}</div>
    <div role="tabpanel" aria-label="会前准备" style={{flex:1,minHeight:0,display:tab==='brief'?'flex':'none',flexDirection:'column'}}><BriefEditor sessionId={sessionId} recordingId={preparing?undefined:meta?.id} call={call} getCwd={getCwd} cache={briefCache} onSaved={refresh} onStart={begin}/></div>
    <div role="tabpanel" aria-label="实时转写" style={{flex:1,minHeight:0,display:tab==='transcript'?'flex':'none',flexDirection:'column'}}>
      {meta?.error&&<p role="alert" style={{color:'#dc5e57',fontSize:12}}>{meta.error}</p>}
      {!!meta&&(meta.droppedBytes>0||meta.untranscribedBytes>0)&&<p role="alert">部分音频未完成转写，完整录音保留在本机。</p>}
      <div role="log" aria-label="转写内容" style={{overflowY:'auto',flex:1,minHeight:0,lineHeight:1.7}}>
        {meta&&status?.result?.entries.length?status.result.entries.map(entry=><div key={entry.line} style={{display:'flex',gap:10,padding:'8px 0',borderBottom:'1px solid #8882'}}><span style={{opacity:.5,fontVariantNumeric:'tabular-nums',flexShrink:0}}>{time(entry.ts-meta.startedAt)}</span><span style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{entry.text}</span></div>):<p style={{opacity:.6}}>{active&&!other&&!preparing?'正在聆听，识别完整语句后会显示在这里。':'在“会前准备”中设定背景并开始录音，转写会持续保存在本机。'}</p>}
      </div>
      <p style={{fontSize:12,opacity:.65,lineHeight:1.6,margin:'12px 0'}}>可在聊天框继续讨论；“发言建议”会结合你的定位，准备可能被问的问题和回答参考。</p>
      {meta&&<><div style={{display:'flex',gap:8}}><button style={button} disabled={exporting} onClick={()=>void exportText()}>{exporting?'导出中…':'导出文字'}</button><button style={button} onClick={()=>setSettings(true)}>语音设置</button></div><p style={{fontSize:10,opacity:.5,overflowWrap:'anywhere',marginBottom:0}}>{status?.result?.transcriptPath}</p></>}
    </div>
    <div role="tabpanel" aria-label="发言建议" style={{flex:1,minHeight:0,display:tab==='advice'?'flex':'none',flexDirection:'column'}}>{meta&&status?.coach?<AdvicePanel key={meta.id} sessionId={sessionId} recordingId={meta.id} status={status.coach} call={call} onRefresh={refresh}/>:<p style={{opacity:.65,lineHeight:1.8}}>先完成会前准备并开始会议，或选择已有会议记录。这里会显示可能被问的问题、两版回答和你可以提出的问题。</p>}</div>
  </section>;
  useEffect(()=>{
    if(panel)dockStore.set({id:PANEL_ID,order:20,title:'会议',render:()=>body,onClose:()=>setPanel(false)},wantFocus.current);
    else dockStore.close(PANEL_ID);
    wantFocus.current=false;
  });
  useEffect(()=>()=>{dockStore.close(PANEL_ID);},[]);
  return <div style={{display:'flex',alignItems:'center',gap:5}}>
    <button type="button" role="switch" aria-checked={active} aria-label="会议录音" disabled={local.busy||(!local.recording&&!!status?.active)} onClick={()=>void toggle()} title={other?'另一个会话正在录音':'先填写会前准备，再开始实时转写'} style={{...button,borderRadius:18,borderColor:active?'#dc5e57':'#8885',color:active?'#dc5e57':'inherit',display:'flex',alignItems:'center',gap:7}}>
      <span style={{width:8,height:8,borderRadius:'50%',background:active?'#dc5e57':'#888',boxShadow:active?`0 0 0 ${2+local.level*5}px #dc5e5725`:'none'}}/>{local.busy?'处理中…':'会议'}
    </button>
    <button type="button" style={button} onClick={togglePanel} aria-label="查看会议转写" aria-expanded={panel}>转写{freshAdvice&&<span title="有新的发言建议" style={{color:'#2769e7',marginLeft:4}}>●</span>}</button>
    <button type="button" style={{...button,border:0,padding:3}} onClick={()=>setSettings(true)} aria-label="会议设置" title="语音连接设置">⚙</button>
    {(local.error||error)&&!panel&&<button style={{...button,color:'#dc5e57'}} onClick={openPanel}>查看错误</button>}
    {settings&&<div role="dialog" aria-label="会议设置" aria-modal="true" style={{position:'fixed',inset:0,background:'#0006',display:'grid',placeItems:'center',zIndex:9999}}><div style={{width:510,maxWidth:'90vw',maxHeight:'85vh',overflow:'auto',background:THEME.background,color:THEME.color,border:THEME.border,borderRadius:14,padding:24}}><button style={{...button,float:'right'}} aria-label="关闭会议设置" onClick={()=>setSettings(false)}>×</button><MeetingSettings call={call} recording={active}/></div></div>}
  </div>;
}

export function MeetingSettings({call,recording=false}:{call:VoiceCall;recording?:boolean}){
  const [config,setConfig]=useState<Record<string,any>>({}),[message,setMessage]=useState(''),[busy,setBusy]=useState(false);
  useEffect(()=>{void call('config').then(setConfig).catch(e=>setMessage(e.message));},[call]);
  const field=(key:string,label:string,type='text')=><label style={{display:'grid',gap:6,marginTop:14,fontSize:13}}>{label}<input aria-label={label} type={type} autoComplete="off" value={config[key]??''} placeholder={type==='password'&&config.configured?'已保存；留空保持不变':''} onChange={e=>setConfig({...config,[key]:e.target.value})} style={{...button,width:'100%',boxSizing:'border-box',padding:9,cursor:'text'}}/></label>;
  const save=async()=>{setBusy(true);setMessage('');try{setConfig(await call('save',config));setMessage('已保存。打开会议开关即可开始录音。');}catch(e){setMessage(e instanceof Error?e.message:String(e));}finally{setBusy(false);}};
  return <section><h2 style={{margin:'0 0 10px',fontSize:20}}>会议语音</h2><p style={{fontSize:13,opacity:.7,lineHeight:1.7}}>使用本机麦克风，音频发送至配置的百炼服务进行转写。录音和文字保存在本机；Agent 按需读取文字。关闭开关结束录音。</p>
    {field('apiKey','百炼 API Key','password')}{field('wsBase','流式识别 WebSocket 地址')}{field('model','语音识别模型')}
    <label style={{display:'block',fontSize:12,marginTop:14}}>从原语音项目导入配置（.env / JSON）<input aria-label="导入语音配置" type="file" accept=".env,.json,text/plain,application/json" onChange={e=>{const file=e.target.files?.[0];if(file)void file.text().then(text=>{
      let imported:Record<string,string>;if(text.trim().startsWith('{'))imported=JSON.parse(text);else{imported={};for(const line of text.split('\n')){const match=line.trim().match(/^(?:export\s+)?([A-Z_]+)\s*=\s*(.*?)\s*$/);if(match)imported[match[1]!]=match[2]!.replace(/^['"]|['"]$/g,'');}}
      setConfig({...config,apiKey:imported.apiKey||imported.VR_API_KEY||imported.DASHSCOPE_API_KEY||config.apiKey,wsBase:imported.wsBase||imported.VR_SASR_WS_BASE||config.wsBase,model:imported.model||config.model});setMessage('已读取配置，请保存。');
    }).catch(()=>setMessage('无法读取配置文件。'));}} style={{display:'block',marginTop:8}}/></label>
    <button style={{...button,marginTop:18,background:'#2769e7',color:'white'}} disabled={busy||recording} onClick={()=>void save()}>{busy?'保存中…':'保存设置'}</button>
    {recording&&<p style={{fontSize:12}}>请先停止录音，再修改设置。</p>}
    {message&&<p role="status" style={{fontSize:12,overflowWrap:'anywhere'}}>{message}</p>}
    <p style={{fontSize:11,opacity:.55,lineHeight:1.6}}>麦克风首次使用需要 macOS 授权。当前不区分说话人，也不直接采集系统音频；转写服务按音频时长计费。</p>
  </section>;
}
