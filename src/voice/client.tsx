import React,{useCallback,useEffect,useRef,useState,useSyncExternalStore} from 'react';
import {MeetingCapture,type VoiceCall} from './capture.js';
import type {MeetingMeta,TranscriptEntry} from './store.js';
import {dockStore} from '../shared/dock/dock-store.js';
import {BriefEditor,AdvicePanel,type BriefCache} from './coach-ui.js';
import type {CoachStatus,PublicBrief} from './coach-types.js';
import {THEME} from '../shared/theme.js';
import {PluginUpdates,isNewerPluginVersion} from './update-ui.js';
import type {PluginUpdateStatus} from './update-types.js';

const PANEL_ID='meeting-assistant-panel';
type Status={hostVersion?:string;updates?:PluginUpdateStatus;coach:CoachStatus|null;active:{sessionId:string;id:string;state:string}|null;recordings:MeetingMeta[];result:{recording:MeetingMeta;entries:TranscriptEntry[];transcriptPath:string}|null};
type PanelView='meeting'|'settings'|'background'|'history'|'updates';
type ContentTab='questions'|'replies'|'transcript';
const button:React.CSSProperties={border:'1px solid #8884',borderRadius:8,background:'transparent',color:'inherit',padding:'7px 11px',cursor:'pointer',fontSize:12,lineHeight:1.5};
const primary:React.CSSProperties={...button,background:'#2769e7',borderColor:'#2769e7',color:'white'};
const quiet:React.CSSProperties={...button,border:0,padding:'5px 7px'};
const muted:React.CSSProperties={fontSize:12,opacity:.6,lineHeight:1.7};
const time=(ms:number)=>{const seconds=Math.max(0,Math.floor(ms/1000));return `${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`;};
function Microphone(){return <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><rect x="9" y="2" width="6" height="13" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8"/></svg>;}
function RefreshIcon(){return <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-1l2 3M4 15l2 3a7 7 0 0 0 12-1"/></svg>;}

export function MeetingToggle({sessionId,call,capture,available,closeDetails,getCwd,briefCache,clientVersion=''}:{sessionId:string;clientVersion?:string;call:VoiceCall;capture:MeetingCapture;available:boolean;closeDetails:()=>void;getCwd:()=>string;briefCache:BriefCache}){
  const local=useSyncExternalStore(capture.subscribe,capture.snapshot);
  const [status,setStatus]=useState<Status|null>(null),[panel,setPanel]=useState(false);
  const [view,setView]=useState<PanelView>('meeting'),[tab,setTab]=useState<ContentTab>('questions');
  const [preparing,setPreparing]=useState(false),[adviceHistory,setAdviceHistory]=useState(false);
  const [statusError,setStatusError]=useState(''),[error,setError]=useState('');
  const [starting,setStarting]=useState(false),[exporting,setExporting]=useState(false);
  const [analysisOperation,setAnalysisOperation]=useState<{scope:string;request:number;endpoint:string}|null>(null);
  const [resumeAfterSettings,setResumeAfterSettings]=useState(false),[seenAdvice,setSeenAdvice]=useState<string|null>(null);
  const wantFocus=useRef(false),entry=useRef<HTMLButtonElement>(null),menu=useRef<HTMLDetailsElement>(null);
  const startIntent=useRef(0),startingRef=useRef(false),resumeStart=useRef(false),currentSession=useRef(sessionId);
  const statusRequest=useRef(0),statusApplied=useRef(0),analysisRequest=useRef(0),analysisScope=useRef('');
  currentSession.current=sessionId;
  const refresh=useCallback(async()=>{const request=++statusRequest.current,next:Status=await call('status',{sessionId});if(currentSession.current===sessionId&&request>=statusApplied.current){statusApplied.current=request;setStatus(next);setStatusError('');}},[call,sessionId]);
  useEffect(()=>{
    startIntent.current++;startingRef.current=false;resumeStart.current=false;
    setStarting(false);setPreparing(false);setView('meeting');setTab('questions');setAdviceHistory(false);setResumeAfterSettings(false);setSeenAdvice(null);setError('');
    if(!available)return;
    let cancelled=false,timer:ReturnType<typeof setTimeout>;setStatus(null);setStatusError('');
    const poll=async()=>{const observedAt=Date.now(),request=++statusRequest.current;try{const next:Status=await call('status',{sessionId});if(cancelled||request<statusApplied.current)return;statusApplied.current=request;setStatus(next);setStatusError('');capture.reconcile(next.active,observedAt);}catch(e){if(!cancelled)setStatusError(e instanceof Error?e.message:String(e));}finally{if(!cancelled)timer=setTimeout(()=>void poll(),1500);}};
    void poll();return ()=>{cancelled=true;clearTimeout(timer);};
  },[sessionId,call,capture,available]);
  const markViewed=useCallback((id:string)=>setSeenAdvice(id),[]),onDockClose=useCallback(()=>setPanel(false),[]);
  const meta=preparing?undefined:status?.result?.recording;
  const scope=`${sessionId}/${meta?.id??''}`;analysisScope.current=scope;
  const analysisBusy=analysisOperation?.scope===scope,cancelling=analysisBusy&&analysisOperation?.endpoint==='coach/cancel';
  const owner=status?.active?.sessionId??local.sessionId,active=!!status?.active||local.recording||local.busy;
  const other=active&&owner!==sessionId,selectedActive=!!meta&&meta.id===status?.active?.id;
  const activeMeta=status?.recordings.find(item=>item.id===status.active?.id);
  const pending=starting||(local.busy&&local.phase!=='stopping'),stopping=local.phase==='stopping'||status?.active?.state==='stopping';
  const liveHere=!other&&(selectedActive||(local.recording&&(!meta||meta.id===local.recordingId)));
  const freshAdvice=!preparing&&!!status?.coach?.latestId&&status.coach.latestId!==seenAdvice;
  const hasError=!!(error||statusError||local.error||meta?.error);
  const prepared=!meta&&!liveHere&&!other&&!pending&&!stopping;
  const hostOutdated=!!clientVersion&&!!status&&status.hostVersion!==clientVersion;
  const updates=status?.updates,installing=updates?.phase==='installing';
  const updateHint=isNewerPluginVersion(updates?.installedVersion,updates?.currentVersion)?'插件更新待重启':isNewerPluginVersion(updates?.latestVersion,updates?.currentVersion)?'有插件更新':null;
  const select=async(recordingId:string)=>{try{await call('select',{sessionId,recordingId});if(currentSession.current!==sessionId)return;setPreparing(false);setView('meeting');setError('');await refresh();}catch(e){setError(e instanceof Error?e.message:String(e));}};
  const openPanel=()=>{closeDetails();if(dockStore.has(PANEL_ID))dockStore.activate(PANEL_ID);wantFocus.current=true;setPanel(true);setView('meeting');if(status?.active?.sessionId===sessionId){setPreparing(false);if(meta?.id!==status.active.id)void select(status.active.id);}};
  const closePanel=()=>{setPanel(false);entry.current?.focus();};
  const closeMenu=()=>{if(menu.current)menu.current.open=false;};
  const back=()=>{resumeStart.current=false;setResumeAfterSettings(false);setView('meeting');};
  const newMeeting=()=>{closeMenu();setPreparing(true);setAdviceHistory(false);setTab('questions');setView('meeting');setError('');};
  const begin=async()=>{
    if(hostOutdated||installing||startingRef.current||capture.snapshot().busy||capture.snapshot().recording||status?.active)return;
    const intent=++startIntent.current;startingRef.current=true;setStarting(true);setError('');
    const valid=()=>startIntent.current===intent&&currentSession.current===sessionId;
    try{
      const config=await call('config');if(!valid())return;
      if(!config.configured){resumeStart.current=true;setResumeAfterSettings(true);setView('settings');return;}
      const key=`${sessionId}/draft`,draft:PublicBrief=briefCache.get(key)??await call('brief/get',{sessionId});if(!valid())return;
      const saved:PublicBrief=await call('brief/save',{sessionId,cwd:getCwd(),brief:{invitation:draft.invitation,goal:draft.goal??'',role:draft.role,initialViews:draft.initialViews,filePaths:[],autoEnabled:draft.autoEnabled}});
      if(!valid())return;briefCache.set(key,saved);
      await capture.start(sessionId);if(!valid())return;
      if(capture.snapshot().recording&&capture.snapshot().sessionId===sessionId){setPreparing(false);setView('meeting');setTab('questions');await refresh();}
    }catch(e){if(valid())setError(e instanceof Error?e.message:String(e));}
    finally{if(startIntent.current===intent){startingRef.current=false;setStarting(false);}}
  };
  const cancelStart=()=>{startIntent.current++;startingRef.current=false;resumeStart.current=false;setStarting(false);setResumeAfterSettings(false);void capture.stop().catch(e=>setError(e instanceof Error?e.message:String(e)));};
  const end=async()=>{try{await capture.stop();await refresh();}catch(e){setError(e instanceof Error?e.message:String(e));}};
  const analyze=async(endpoint:string,extra:Record<string,unknown>={})=>{
    if(!meta||analysisBusy)return;
    const request=++analysisRequest.current,operationScope=scope;setAnalysisOperation({scope:operationScope,request,endpoint});setError('');
    const current=()=>currentSession.current===sessionId&&analysisScope.current===operationScope&&analysisRequest.current===request;
    try{
      const result=await call(endpoint,{sessionId,recordingId:meta.id,...extra});if(!current())return;
      if(endpoint==='coach/cancel'&&result?.cancelled&&typeof result.jobId==='string'){
        statusApplied.current=++statusRequest.current;
        setStatus(previous=>{if(!previous?.coach||previous.result?.recording.id!==meta.id||previous.coach.running?.id!==result.jobId)return previous;return {...previous,coach:{...previous.coach,running:null,error:'已取消本次生成。'}};});
      }
      await refresh();
    }catch(e){if(current())setError(e instanceof Error?e.message:String(e));}
    finally{setAnalysisOperation(previous=>previous?.request===request?null:previous);}
  };
  const exportText=async()=>{
    if(!meta)return;setExporting(true);closeMenu();
    try{const text=[`会议记录 · ${new Date(meta.startedAt).toLocaleString()}`];let afterLine=0;
      for(let page=0;page<100;page++){const result=await call('read',{sessionId,recordingId:meta.id,afterLine,lines:200});for(const item of result.entries as TranscriptEntry[])if(item.line<=meta.segments)text.push(`[${time(item.ts-meta.startedAt)}] ${item.text}`);if(!result.hasMore||result.nextAfterLine>=meta.segments)break;if(result.nextAfterLine<=afterLine)throw new Error('转写读取未能继续');afterLine=result.nextAfterLine;}
      const url=URL.createObjectURL(new Blob([text.join('\n\n')],{type:'text/plain;charset=utf-8'}));const link=document.createElement('a');link.href=url;link.download=`会议-${new Date(meta.startedAt).toISOString().replace(/[:.]/g,'-')}.txt`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    }catch(e){setError(e instanceof Error?e.message:String(e));}finally{setExporting(false);}
  };
  const recordedAt=local.startedAt??activeMeta?.startedAt,elapsed=recordedAt?time(Date.now()-recordedAt):'';
  const entryText=local.phase==='permission'?'等待授权':stopping?'正在保存':pending?'正在准备':active?`会议${elapsed?` · ${elapsed}`:''}`:'会议助手';
  const sectionTitle=view==='updates'?'插件更新':view==='settings'?'语音设置':view==='background'?'会议背景':view==='history'?'历史记录':meta&&!liveHere?'会议记录':'会议助手';
  const editor=<BriefEditor key={`${sessionId}/${preparing?'draft':meta?.id??'draft'}`} sessionId={sessionId} recordingId={preparing?undefined:meta?.id} call={call} getCwd={getCwd} cache={briefCache} onSaved={refresh} onStart={begin} compact showStart={false} showSave={view==='background'} disabled={starting||local.busy||hostOutdated||installing}/>;
  const tabs:readonly [ContentTab,string][]=[['questions','追问'],['replies','回应'],['transcript','转写']];
  const body=<section aria-label="会议助手" onKeyDown={event=>{event.stopPropagation();if(event.key==='Escape'){event.preventDefault();if(menu.current?.open){closeMenu();menu.current?.querySelector('summary')?.focus();}else if(view!=='meeting')back();else closePanel();}}} onPaste={event=>event.stopPropagation()} onClick={event=>event.stopPropagation()} onPointerDown={event=>{event.stopPropagation();if(!menu.current?.contains(event.target as Node))closeMenu();}} style={{height:'100%',minHeight:0,boxSizing:'border-box',display:'flex',flexDirection:'column',padding:'18px 20px',fontSize:13}}>
    <header style={{display:'flex',alignItems:'center',justifyContent:'space-between',gap:10,minHeight:32,flexShrink:0,marginBottom:20}}>
      {view!=='meeting'?<div style={{display:'flex',alignItems:'center',gap:8,minWidth:0}}><button style={{...quiet,padding:'2px 5px',fontSize:22,lineHeight:1}} aria-label="返回会议" onClick={back}>‹</button><strong style={{fontSize:15}}>{sectionTitle}</strong></div>:liveHere||stopping?<div role="status" aria-label={stopping?'正在保存':'录音中'} style={{display:'flex',alignItems:'center',gap:9}}><span aria-hidden="true" style={{width:7,height:7,borderRadius:'50%',background:stopping?'#888':'#dc5e57'}}/><span style={{fontSize:18,fontWeight:550,fontVariantNumeric:'tabular-nums',letterSpacing:'.02em'}}>{elapsed||'0:00'}</span>{local.recording&&<meter aria-label="麦克风音量" title={local.deviceLabel||'麦克风'} min={0} max={1} value={local.level} style={{width:40,height:7,opacity:.65}}/>}</div>:<strong style={{fontSize:16}}>{sectionTitle}</strong>}
      <div style={{display:'flex',gap:5,alignItems:'center'}}>
        {liveHere&&local.recording&&<button aria-label="结束录音" style={{...quiet,display:'inline-flex',alignItems:'center',gap:6}} onClick={()=>void end()}><span aria-hidden="true" style={{width:8,height:8,borderRadius:2,background:'#dc5e57'}}/>结束</button>}
        {view==='meeting'&&meta&&!liveHere&&!active&&<button style={quiet} onClick={newMeeting}>新会议</button>}
        <details ref={menu} onBlur={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node))event.currentTarget.open=false;}} style={{position:'relative'}}>
          <summary aria-label="更多会议操作" title="更多" style={{...quiet,listStyle:'none',padding:'2px 7px',fontSize:21,lineHeight:1,cursor:'pointer'}}>⋯</summary>
          <nav aria-label="会议操作" style={{position:'absolute',right:0,top:'calc(100% + 9px)',zIndex:5,width:170,background:THEME.background,color:'inherit',border:'1px solid #8883',borderRadius:10,padding:5,boxShadow:'0 6px 22px #0002',display:'grid',gap:3}}>
            <button style={{...quiet,textAlign:'left'}} disabled={active||starting} onClick={newMeeting}>开始新会议</button>
            <button style={{...quiet,textAlign:'left'}} onClick={()=>{closeMenu();setView('background');}}>会议背景</button>
            {!!status?.coach&&meta&&<label style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'6px 7px',fontSize:12,cursor:'pointer'}}>自动分析<input type="checkbox" aria-label="自动分析" disabled={analysisBusy} checked={status.coach.autoEnabled} onChange={event=>void analyze('coach/auto',{enabled:event.target.checked})}/></label>}
            {!!status?.coach?.history.length&&<button style={{...quiet,textAlign:'left'}} onClick={()=>{closeMenu();setAdviceHistory(value=>!value);setView('meeting');if(tab==='transcript')setTab('questions');}}>历史建议</button>}
            <div style={{height:1,background:'#8882',margin:'3px 4px'}}/>
            <button style={{...quiet,textAlign:'left'}} onClick={()=>{closeMenu();setView('history');}}>历史记录</button>
            <button style={{...quiet,textAlign:'left'}} disabled={!meta||exporting} onClick={()=>void exportText()}>{exporting?'导出中…':'导出文字'}</button>
            <button style={{...quiet,textAlign:'left'}} onClick={()=>{closeMenu();resumeStart.current=false;setResumeAfterSettings(false);setView('settings');}}>语音设置</button>
            <div style={{height:1,background:'#8882',margin:'3px 4px'}}/>
            <button style={{...quiet,textAlign:'left',display:'flex',alignItems:'center',justifyContent:'space-between',gap:8}} onClick={()=>{closeMenu();setView('updates');}}>插件更新{updateHint&&<span aria-label={updateHint} style={{width:5,height:5,borderRadius:'50%',background:'#2769e7'}}/>}</button>
          </nav>
        </details>
        <button style={{...quiet,padding:'2px 5px',fontSize:20,lineHeight:1}} aria-label="收起会议助手" title="收起" onClick={closePanel}>×</button>
      </div>
    </header>
    {hostOutdated&&<p role="status" style={{...muted,margin:'0 0 16px'}}>会议服务尚未更新，请完整退出并重开 DSH。</p>}
    {(local.error||error||statusError)&&<div role="alert" style={{color:'#c24b43',padding:'0 0 16px',whiteSpace:'pre-wrap',overflowWrap:'anywhere',lineHeight:1.7}}>{local.error||error||statusError}{statusError&&<button style={{...quiet,display:'block',paddingLeft:0}} onClick={()=>void refresh().catch(e=>setStatusError(e.message))}>重新连接</button>}</div>}
    {view==='meeting'&&meta&&!liveHere&&!active&&<div style={{...muted,margin:'-8px 0 18px'}}>{new Date(meta.startedAt).toLocaleString()} · {time((meta.endedAt??Date.now())-meta.startedAt)}</div>}
    {view==='meeting'&&liveHere&&status?.active?.state==='reconnecting'&&<p role="status" style={{...muted,margin:'-8px 0 14px'}}>转写重连中…</p>}
    {view==='meeting'&&meta&&!liveHere&&active&&!other&&<button style={{...quiet,textAlign:'left',padding:'0 0 14px',color:'#2769e7'}} onClick={()=>void select(status?.active?.id??local.recordingId!)}>回到录音</button>}
    {view==='meeting'&&(liveHere||meta)&&!pending&&!stopping&&<div role="tablist" aria-label="会议内容" style={{display:'flex',alignItems:'center',gap:22,borderBottom:'1px solid #8882',marginBottom:18,flexShrink:0}}>
      {tabs.map(([key,label],index)=><button key={key} id={`meeting-tab-${key}`} role="tab" aria-selected={tab===key} aria-controls={key==='transcript'?'meeting-content-transcript':'meeting-content-advice'} tabIndex={tab===key?0:-1} onKeyDown={event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();event.stopPropagation();const next=event.key==='Home'?0:event.key==='End'?2:(index+(event.key==='ArrowRight'?1:2))%3;setTab(tabs[next]![0]);event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();}} onClick={()=>setTab(key)} style={{...quiet,padding:'8px 0 11px',borderRadius:0,borderBottom:tab===key?'2px solid currentColor':'2px solid transparent',opacity:tab===key?1:.5,fontWeight:tab===key?600:400,fontSize:13}}>{label}</button>)}
      {tab!=='transcript'&&meta&&status?.coach&&<div style={{marginLeft:'auto',display:'flex',alignItems:'center',gap:3}}>{status.coach.running?<button style={quiet} aria-label="取消分析" aria-busy={cancelling} disabled={analysisBusy} onClick={()=>void analyze('coach/cancel',{jobId:status.coach?.running?.id})}>{cancelling?'正在取消…':'取消分析'}</button>:<button style={{...quiet,display:'flex',padding:'5px 2px 9px'}} aria-label="更新建议" title="更新建议" disabled={analysisBusy||hostOutdated||installing} onClick={()=>void analyze('coach/generate')}><RefreshIcon/></button>}</div>}
    </div>}
    <div style={{overflowY:'auto',flex:1,minHeight:0,paddingRight:2}}>
      {view==='updates'?<PluginUpdates call={call} visible={panel&&view==='updates'} currentVersion={clientVersion}/>:view==='settings'?<MeetingSettings heading={false} call={call} recording={active} submitLabel={resumeAfterSettings?'保存并开始录音':undefined} onSaved={async()=>{const resume=resumeStart.current;resumeStart.current=false;setResumeAfterSettings(false);setView('meeting');if(resume)await begin();}}/>:view==='background'?editor:view==='history'?<div aria-label="历史会议记录">
        {status?.recordings.length?status.recordings.map(item=><button key={item.id} style={{...quiet,width:'100%',textAlign:'left',padding:'14px 0',borderRadius:0,borderBottom:'1px solid #8882',display:'flex',justifyContent:'space-between',gap:12}} onClick={()=>void select(item.id)}><span>{new Date(item.startedAt).toLocaleString()}</span><span style={{opacity:.5,fontVariantNumeric:'tabular-nums'}}>{time((item.endedAt??Date.now())-item.startedAt)}</span></button>):<p style={muted}>暂无记录</p>}
      </div>:other?<p role="status" style={{lineHeight:1.8,margin:0}}>另一会话正在{local.phase==='permission'?'等待录音授权':'录音'}。</p>:pending?<div role="status" style={{padding:'30px 0',display:'grid',gap:20,justifyItems:'center'}}><span>{local.phase==='permission'?'等待麦克风授权':local.phase==='connecting'?'正在连接麦克风':'准备录音…'}</span><button style={button} onClick={cancelStart}>取消启动</button></div>:stopping?<p role="status" style={muted}>正在保存录音…</p>:prepared?editor:meta?<>
        {meta.error&&<p role="alert" style={{color:'#c24b43',lineHeight:1.7,marginTop:0}}>{meta.error}</p>}
        {(meta.droppedBytes>0||meta.untranscribedBytes>0)&&<p role="alert" style={muted}>部分音频未完成转写，录音已保留。</p>}
        <div id="meeting-content-advice" role="tabpanel" aria-labelledby={`meeting-tab-${tab==='replies'?'replies':'questions'}`} hidden={tab==='transcript'}>
          {status?.coach?<AdvicePanel key={meta.id} sessionId={sessionId} recordingId={meta.id} status={status.coach} call={call} onRefresh={refresh} onViewed={markViewed} view={tab==='replies'?'replies':'questions'} actions={false} historyOpen={adviceHistory} visible={panel&&view==='meeting'&&tab!=='transcript'&&!other&&!pending&&!stopping}/>:<p style={muted}>暂时无法生成建议</p>}
        </div>
        <div id="meeting-content-transcript" role="tabpanel" aria-labelledby="meeting-tab-transcript" hidden={tab!=='transcript'}><Transcript key={meta.id} sessionId={sessionId} recording={meta} entries={status?.result?.entries??[]} call={call}/></div>
      </>:liveHere?<p style={muted}>正在连接转写…</p>:null}
    </div>
    {view==='meeting'&&prepared&&<footer style={{paddingTop:18,flexShrink:0}}><button style={{...primary,width:'100%',fontSize:14,padding:'10px 14px'}} disabled={!status||active||hostOutdated||installing} onClick={()=>void begin()}>{installing?'插件更新中…':status?'开始录音':'正在连接…'}</button></footer>}
  </section>;
  useEffect(()=>{if(panel&&available)dockStore.set({id:PANEL_ID,order:20,title:'会议',render:()=>body,onClose:onDockClose},wantFocus.current);else if(dockStore.getSnapshot().panels.some(item=>item.id===PANEL_ID&&item.onClose===onDockClose))dockStore.close(PANEL_ID);wantFocus.current=false;});
  useEffect(()=>()=>{if(dockStore.getSnapshot().panels.some(item=>item.id===PANEL_ID&&item.onClose===onDockClose))dockStore.close(PANEL_ID);},[onDockClose]);
  if(!available)return null;
  return <button ref={entry} type="button" aria-label="会议助手" aria-expanded={panel} onClick={openPanel} title={other?'另一会话正在录音':active?'打开当前会议':'会议助手'} style={{...button,borderRadius:18,display:'inline-flex',alignItems:'center',gap:7,borderColor:active?'#dc5e5766':'#8884',color:hasError?'#c24b43':'inherit',padding:'6px 11px'}}>{active?<span aria-hidden="true" style={{width:7,height:7,borderRadius:'50%',background:stopping?'#888':'#dc5e57',boxShadow:local.recording?`0 0 0 ${2+local.level*4}px #dc5e5720`:'none'}}/>:hasError?<span aria-hidden="true">⚠</span>:<Microphone/>}<span>{entryText}</span>{freshAdvice&&<span aria-label="有新建议" style={{width:5,height:5,borderRadius:'50%',background:'#2769e7'}}/>}</button>;
}

function Transcript({sessionId,recording,entries,call}:{sessionId:string;recording:MeetingMeta;entries:TranscriptEntry[];call:VoiceCall}){
  const [all,setAll]=useState<TranscriptEntry[]|null>(null),[loading,setLoading]=useState(false),[error,setError]=useState('');
  const generation=useRef(0);
  useEffect(()=>()=>{generation.current++;},[]);
  const load=async()=>{
    const request=++generation.current,throughLine=recording.segments;setLoading(true);setError('');
    try{
      const result:TranscriptEntry[]=[];let afterLine=0;
      for(let page=0;page<100;page++){
        const next=await call('read',{sessionId,recordingId:recording.id,afterLine,lines:200});
        if(request!==generation.current)return;
        result.push(...(next.entries as TranscriptEntry[]).filter(item=>item.line<=throughLine));
        if(!next.hasMore||next.nextAfterLine>=throughLine)break;
        if(next.nextAfterLine<=afterLine)throw new Error('转写读取未能继续');
        afterLine=next.nextAfterLine;
      }
      setAll(result);
    }catch(e){if(request===generation.current)setError(e instanceof Error?e.message:String(e));}
    finally{if(request===generation.current)setLoading(false);}
  };
  const shown=all?[...all,...entries.filter(item=>item.line>(all.at(-1)?.line??0))]:entries;
  return <div style={{marginTop:10}}>
    {!all&&entries.length<recording.segments&&<button style={button} disabled={loading} onClick={()=>void load()}>{loading?'正在读取…':'加载更早的转写'}</button>}
    {error&&<p role="alert" style={{color:'#c24b43',fontSize:12}}>{error}</p>}
    <div role="log" aria-label="转写内容" style={{lineHeight:1.8}}>
      {shown.length?shown.map(item=><div key={item.line} style={{display:'flex',gap:10,padding:'9px 0',borderBottom:'1px solid #8882'}}><span style={{...muted,fontVariantNumeric:'tabular-nums',flexShrink:0}}>{time(item.ts-recording.startedAt)}</span><span style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{item.text}</span></div>):<p style={muted}>{recording.endedAt?'本场会议没有转写内容。':'识别完成的语句会显示在这里。'}</p>}
    </div>
  </div>;
}

export function MeetingSettings({call,recording=false,onSaved,submitLabel,heading=true}:{call:VoiceCall;recording?:boolean;onSaved?:()=>void|Promise<void>;submitLabel?:string;heading?:boolean}){
  const [config,setConfig]=useState<Record<string,any>>({}),[message,setMessage]=useState(''),[busy,setBusy]=useState(false),[loaded,setLoaded]=useState(false);
  useEffect(()=>{let cancelled=false;void call('config').then(value=>{if(!cancelled){setConfig(value);setLoaded(true);}}).catch(e=>{if(!cancelled)setMessage(e.message);});return()=>{cancelled=true;};},[call]);
  const field=(key:string,label:string,type='text')=><label style={{display:'grid',gap:6,marginTop:14,fontSize:13}}>{label}<input aria-label={label} type={type} autoComplete="off" disabled={busy||recording||!loaded} value={config[key]??''} placeholder={type==='password'&&config.configured?'已保存；留空保持不变':''} onChange={event=>setConfig({...config,[key]:event.target.value})} style={{...button,width:'100%',boxSizing:'border-box',padding:9,cursor:'text'}}/></label>;
  const save=async()=>{
    setBusy(true);setMessage('');
    try{setConfig(await call('save',config));setMessage('语音设置已保存。');await onSaved?.();}
    catch(e){setMessage(e instanceof Error?e.message:String(e));}
    finally{setBusy(false);}
  };
  return <section aria-label="语音设置">
    {heading&&<h2 style={{margin:'0 0 10px',fontSize:18}}>语音设置</h2>}
    <p style={{...muted,marginTop:0}}>{submitLabel?'保存后继续开始录音，并在需要时申请麦克风权限。':'配置会议转写服务。保存设置不会打开麦克风；开始录音时才申请使用权限。'}</p>
    {field('apiKey','百炼 API Key','password')}
    <details style={{marginTop:16}}><summary style={{cursor:'pointer',fontSize:12}}>服务地址与模型</summary>{field('wsBase','流式识别 WebSocket 地址')}{field('model','语音识别模型')}</details>
    <details style={{marginTop:16}}><summary style={{cursor:'pointer',fontSize:12}}>导入已有配置</summary>
      <label style={{display:'block',...muted,marginTop:10}}>选择 .env 或 JSON 文件<input aria-label="导入语音配置" type="file" disabled={busy||recording||!loaded} accept=".env,.json,text/plain,application/json" onChange={event=>{
        const file=event.target.files?.[0];if(!file)return;
        void file.text().then(text=>{
          let imported:Record<string,string>;
          if(text.trim().startsWith('{'))imported=JSON.parse(text);
          else{imported={};for(const line of text.split('\n')){const match=line.trim().match(/^(?:export\s+)?([A-Z_]+)\s*=\s*(.*?)\s*$/);if(match)imported[match[1]!]=match[2]!.replace(/^['"]|['"]$/g,'');}}
          setConfig(previous=>({...previous,apiKey:imported.apiKey||imported.VR_API_KEY||imported.DASHSCOPE_API_KEY||previous.apiKey,wsBase:imported.wsBase||imported.VR_SASR_WS_BASE||previous.wsBase,model:imported.model||previous.model}));setMessage('已读取配置，请保存。');
        }).catch(()=>setMessage('无法读取配置文件。'));
      }} style={{display:'block',marginTop:8,maxWidth:'100%'}}/></label>
    </details>
    <button style={{...primary,marginTop:20}} disabled={!loaded||busy||recording} onClick={()=>void save()}>{busy?'保存中…':submitLabel??'保存设置'}</button>
    {recording&&<p style={muted}>结束录音后可修改转写服务。</p>}
    {message&&<p role="status" style={{...muted,overflowWrap:'anywhere'}}>{message}</p>}
    <p style={{fontSize:11,opacity:.55,lineHeight:1.7,marginTop:18}}>当前采集麦克风声音，不直接采集系统声音。音频发送至配置的百炼服务，录音与转写保存在本机；转写服务按音频时长计费。</p>
  </section>;
}
