import React,{useEffect,useRef,useState} from 'react';
import type {VoiceCall} from './capture.js';
import {EMPTY_BRIEF,type Advice,type CoachStatus,type PublicBrief} from './coach-types.js';

const button:React.CSSProperties={border:'1px solid #8885',borderRadius:7,background:'transparent',color:'inherit',padding:'7px 10px',cursor:'pointer',fontSize:12};
const primary:React.CSSProperties={...button,background:'#2769e7',borderColor:'#2769e7',color:'white'};
const muted:React.CSSProperties={fontSize:12,opacity:.65,lineHeight:1.6,overflowWrap:'anywhere'};
type FileList={root:string;dir:string;truncated:boolean;entries:{name:string;path:string;directory:boolean;supported:boolean}[]};
export type BriefCache=Map<string,PublicBrief>;

export function BriefEditor({sessionId,recordingId,call,getCwd,cache,onSaved,onStart}:{sessionId:string;recordingId?:string;call:VoiceCall;getCwd:()=>string;cache:BriefCache;onSaved:()=>Promise<void>;onStart:()=>Promise<void>}){
  const key=`${sessionId}/${recordingId??'draft'}`;
  const [brief,setBrief]=useState<PublicBrief>({...EMPTY_BRIEF,files:[]}),[loaded,setLoaded]=useState(false),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[files,setFiles]=useState<FileList|null>(null),[browse,setBrowse]=useState(false),[filesBusy,setFilesBusy]=useState(false);
  useEffect(()=>{let cancelled=false;setLoaded(false);setMessage('');setBrowse(false);setFiles(null);
    const saved=cache.get(key);if(saved){setBrief(saved);setLoaded(true);return;}
    void call('brief/get',{sessionId,recordingId}).then((value:PublicBrief)=>{if(cancelled)return;const draft={...value,cwd:value.cwd||getCwd()};setBrief(draft);cache.set(key,draft);setLoaded(true);}).catch(error=>{if(!cancelled)setMessage(error.message);});return ()=>{cancelled=true;};
  },[key,call]);
  const change=(patch:Partial<PublicBrief>)=>{setBrief(previous=>{const next={...previous,...patch};cache.set(key,next);return next;});setMessage('');};
  const listFiles=async(dir='')=>{setFilesBusy(true);setMessage('');try{setFiles(await call('files/list',{sessionId,cwd:brief.cwd||getCwd(),dir}));setBrowse(true);}catch(e){setMessage(e instanceof Error?e.message:String(e));}finally{setFilesBusy(false);}};
  const save=async(start:boolean)=>{setBusy(true);setMessage('');try{
    const saved:PublicBrief=await call('brief/save',{sessionId,recordingId,cwd:brief.cwd||getCwd(),brief:{invitation:brief.invitation,role:brief.role,initialViews:brief.initialViews,filePaths:brief.filePaths,autoEnabled:brief.autoEnabled}});
    setBrief(saved);cache.set(key,saved);setMessage(recordingId?'基础信息已更新；下次生成会使用新内容。':'会前准备已保存。');await onSaved();if(start)await onStart();
  }catch(e){setMessage(e instanceof Error?e.message:String(e));}finally{setBusy(false);}};
  const area=(field:'invitation'|'role'|'initialViews',label:string,placeholder:string)=><label style={{display:'grid',gap:7,marginBottom:17,fontSize:13,fontWeight:500}}>{label}<textarea aria-label={label} disabled={!loaded||busy} maxLength={8000} value={brief[field]} onChange={event=>change({[field]:event.target.value})} placeholder={placeholder} rows={5} style={{resize:'vertical',minHeight:90,boxSizing:'border-box',width:'100%',border:'1px solid #8884',borderRadius:8,background:'transparent',color:'inherit',padding:10,font:'inherit',fontWeight:400,lineHeight:1.6}}/></label>;
  return <div style={{height:'100%',minHeight:0,display:'flex',flexDirection:'column'}}>
    <div style={{overflowY:'auto',flex:1,minHeight:0,paddingRight:2}}>
      <p style={{...muted,marginTop:0}}>{recordingId?'这些信息只属于所选会议，可随讨论进展补充。':'先设定背景，再开始录音。按提示自由填写或粘贴会邀，也可以留空。'}</p>
      {area('invitation','会邀与会议目标','会议主题：\n参与者 / 时间：\n议程：\n希望形成的结论：')}
      {area('role','我的角色定位','我的身份 / 职责：\n我能决定的事项：\n希望达成：\n不能承诺的事 / 顾虑：')}
      {area('initialViews','初始观点与立场','我当前的判断：\n倾向的方案及理由：\n需要验证的假设：')}
      <div style={{borderTop:'1px solid #8883',paddingTop:14}}><strong style={{fontSize:13}}>会议相关文件</strong><p style={{...muted,overflowWrap:'anywhere',margin:'7px 0'}}>资料目录：{brief.cwd||getCwd()||'尚未选择工作区'}</p>
        <div style={{display:'flex',gap:7,flexWrap:'wrap'}}><button style={button} disabled={busy||filesBusy||!loaded} onClick={()=>void listFiles()}>{filesBusy?'读取目录…':'选择工作区文件'}</button>{brief.cwd&&getCwd()&&brief.cwd!==getCwd()&&<button style={button} onClick={()=>{change({cwd:getCwd(),filePaths:[],files:[]});setFiles(null);setBrowse(false);}}>改用当前工作区</button>}{browse&&<button style={button} onClick={()=>setBrowse(false)}>收起文件列表</button>}</div>
        {browse&&files&&<div aria-label="会议资料文件列表" style={{marginTop:10,border:'1px solid #8883',borderRadius:8,padding:8,maxHeight:220,overflow:'auto'}}>
          <div style={{...muted,display:'flex',alignItems:'center',gap:6,marginBottom:6}}>{files.dir&&<button style={button} onClick={()=>void listFiles(files.dir.split(/[\\/]/).slice(0,-1).join('/'))}>上一级</button>}<span>{files.dir||'工作区根目录'}</span></div>
          {!files.entries.length&&<p style={muted}>目录中没有可显示的文件。</p>}
          {files.entries.map(file=>file.directory?<button key={file.path} style={{...button,display:'block',width:'100%',textAlign:'left',border:0,padding:'8px 4px'}} onClick={()=>void listFiles(file.path)}>▸ {file.name}</button>:<label key={file.path} title={file.supported?file.path:'支持文本、Markdown、CSV、JSON、Word(docx)'} style={{display:'flex',gap:8,alignItems:'center',padding:'7px 2px',fontSize:12,opacity:file.supported?1:.4,overflowWrap:'anywhere'}}><input type="checkbox" aria-label={`选择资料 ${file.path}`} checked={brief.filePaths.includes(file.path)} disabled={busy||!file.supported||(!brief.filePaths.includes(file.path)&&brief.filePaths.length>=8)} onChange={event=>change({filePaths:event.target.checked?[...brief.filePaths,file.path]:brief.filePaths.filter(path=>path!==file.path)})}/>{file.name}{!file.supported&&<small>暂不支持</small>}</label>)}
          {files.truncated&&<p style={muted}>目录较大，仅显示前 400 项；可进入子目录选择。</p>}
        </div>}
        {!!brief.filePaths.length&&<ul style={{paddingLeft:17,fontSize:12,lineHeight:1.8}}>{brief.filePaths.map(path=><li key={path} style={{overflowWrap:'anywhere'}}>{path}<button aria-label={`移除资料 ${path}`} style={{...button,border:0,padding:'0 5px'}} onClick={()=>change({filePaths:brief.filePaths.filter(p=>p!==path)})}>×</button></li>)}</ul>}
        {brief.files.some(file=>file.truncated)&&<p style={muted}>部分较长资料已截取开头内容。建议仅选择与本次会议直接相关的文件。</p>}
        <p style={muted}>最多 8 个文件，支持文本、Markdown、CSV、JSON 和 Word。保存时读取内容；文件后续变化时，可再次保存以更新。选中资料将与转写一起用于 DeepSeek Flash 发言建议。</p>
      </div>
      {recordingId?<p style={muted}>自动生成开关在“发言建议”页中调整。</p>:<label style={{display:'flex',gap:8,alignItems:'center',fontSize:13,margin:'16px 0'}}><input type="checkbox" aria-label="自动生成发言建议" checked={brief.autoEnabled} disabled={busy||!loaded} onChange={event=>change({autoEnabled:event.target.checked})}/>自动生成发言建议</label>}
      <p style={muted}>新增 500 字或满 5 分钟且有新增内容时触发；相邻自动请求至少间隔 60 秒。可随时手动生成，建议不会自动发到聊天中。</p>
    </div>
    {message&&<p role="status" style={{fontSize:12,lineHeight:1.5,overflowWrap:'anywhere'}}>{message}</p>}
    <div style={{display:'flex',gap:8,paddingTop:12,borderTop:'1px solid #8883',flexShrink:0}}><button style={recordingId?primary:button} disabled={!loaded||busy} onClick={()=>void save(false)}>{busy?'处理中…':recordingId?'保存基础信息':'保存草稿'}</button>{!recordingId&&<button style={primary} disabled={!loaded||busy} onClick={()=>void save(true)}>{busy?'处理中…':'保存并开始录音'}</button>}</div>
  </div>;
}

function Sources({ids,advice}:{ids:string[];advice:Advice}){const evidence=advice.evidence.filter(item=>ids.includes(item.id));return evidence.length?<details style={{...muted,marginTop:10}}><summary style={{cursor:'pointer'}}>依据 · {evidence.map(item=>item.label).join(' / ')}</summary>{evidence.map(item=><p key={item.id} style={{whiteSpace:'pre-wrap',borderLeft:'2px solid #8884',paddingLeft:8}}><strong>{item.label}</strong><br/>{item.excerpt}</p>)}</details>:<p style={muted}>预演参考，需结合现场确认。</p>;}
function Reply({label,text}:{label:string;text:string}){const [copied,setCopied]=useState(false);useEffect(()=>setCopied(false),[text]);return <div style={{marginTop:10,padding:'10px 11px',borderRadius:8,background:'color-mix(in srgb, currentColor 5%, transparent)'}}><div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}><strong style={{fontSize:12}}>{label}</strong><button style={{...button,border:0,padding:'1px 3px',opacity:.7}} onClick={()=>{void navigator.clipboard.writeText(text).then(()=>setCopied(true)).catch(()=>setCopied(false));}}>{copied?'已复制':'复制'}</button></div><p style={{fontSize:13,lineHeight:1.8,whiteSpace:'pre-wrap',margin:'7px 0 0'}}>{text}</p></div>;}
const reasonName={manual:'手动生成',characters:'新增 500 字',time:'5 分钟更新'};
export function AdvicePanel({sessionId,recordingId,status,call,onRefresh}:{sessionId:string;recordingId:string;status:CoachStatus;call:VoiceCall;onRefresh:()=>Promise<void>}){
  const [selected,setSelected]=useState<string|null>(status.latestId),[advice,setAdvice]=useState<Advice|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[loading,setLoading]=useState(false);
  // The two lists are peers, not a sequence: "what I may be asked" and "what I
  // could ask" are consulted at different moments, so stacking them meant always
  // scrolling past the first to reach the second.
  const [tab,setTab]=useState<'askedOfMe'|'askOthers'>('askedOfMe');
  const previousLatest=useRef(status.latestId);
  useEffect(()=>{if(status.latestId!==previousLatest.current){if(!selected||selected===previousLatest.current)setSelected(status.latestId);previousLatest.current=status.latestId;}},[status.latestId,selected]);
  useEffect(()=>{if(!selected){setAdvice(null);return;}let cancelled=false;setLoading(true);void call('coach/read',{sessionId,recordingId,adviceId:selected}).then(value=>{if(!cancelled){setAdvice(value);setError('');}}).catch(e=>{if(!cancelled)setError(e.message);}).finally(()=>{if(!cancelled)setLoading(false);});return ()=>{cancelled=true;};},[selected,sessionId,recordingId,call]);
  const action=async(endpoint:string,extra={})=>{setBusy(true);setError('');try{await call(endpoint,{sessionId,recordingId,...extra});await onRefresh();}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}};
  const ready=!!advice&&!loading;
  const panels=([['askedOfMe','可能问到我'],['askOthers','我可以追问']] as const).map(([key,label])=>({key,label,questions:key==='askedOfMe'?advice?.content.askedOfMe??[]:advice?.content.askOthers??[]}));
  return <div style={{height:'100%',minHeight:0,display:'flex',flexDirection:'column'}}>
    <div style={{paddingBottom:12,borderBottom:'1px solid #8883',flexShrink:0}}><div style={{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap'}}><button style={primary} disabled={busy||!!status.running} onClick={()=>void action('coach/generate')}>{status.running?'正在生成…':'立即生成发言建议'}</button>{status.running&&<button style={button} disabled={busy} onClick={()=>void action('coach/cancel')}>取消</button>}</div>
      <label style={{display:'flex',gap:7,alignItems:'center',fontSize:12,marginTop:10}}><input type="checkbox" aria-label="会议期间自动生成建议" disabled={busy} checked={status.autoEnabled} onChange={event=>void action('coach/auto',{enabled:event.target.checked})}/>会议期间自动生成</label>
      <p role="status" style={{...muted,margin:'8px 0 0'}}>{status.running?'正在根据本次内容快照分析，期间的新转写会留给下一轮。':`待分析新增 ${status.pendingChars??status.pendingLines}${status.pendingChars===null?' 段':' 字'} · DeepSeek Flash`}</p>
    </div>
    {(error||status.error)&&<p role="alert" style={{color:'#dc5e57',fontSize:12,lineHeight:1.6,overflowWrap:'anywhere',flexShrink:0}}>{error||status.error}</p>}
    {/* Navigation, not content: the version picker and the two-list switch stay
        put while the list below scrolls, which is the whole point of the split. */}
    {!!status.history.length&&<select aria-label="选择发言建议版本" value={selected??''} onChange={event=>setSelected(event.target.value)} style={{...button,width:'100%',margin:'12px 0 0',flexShrink:0}}>{status.history.map(item=><option key={item.id} value={item.id}>{new Date(item.createdAt).toLocaleTimeString()} · {reasonName[item.reason]}</option>)}</select>}
    {status.latestId&&selected!==status.latestId&&<button style={{...button,margin:'8px 0 0',flexShrink:0}} onClick={()=>setSelected(status.latestId)}>查看最新建议</button>}
    {ready&&<div role="tablist" aria-label="发言建议分类" style={{display:'flex',gap:4,borderBottom:'1px solid #8883',marginTop:12,flexShrink:0}}>
      {panels.map(panel=><button type="button" role="tab" aria-selected={tab===panel.key} key={panel.key} onClick={()=>setTab(panel.key)} style={{...button,flex:1,border:0,borderRadius:0,borderBottom:tab===panel.key?'2px solid #2769e7':'2px solid transparent',color:tab===panel.key?'#2769e7':'inherit',padding:'9px 1px'}}>{panel.label}<span style={{opacity:.55,marginLeft:5,fontVariantNumeric:'tabular-nums'}}>{panel.questions.length}</span></button>)}
    </div>}
    <div style={{overflowY:'auto',flex:1,minHeight:0,paddingTop:12,paddingRight:2}}>
      {loading?<p style={muted}>读取建议…</p>:advice?<article aria-label="会议发言建议内容">
        <p style={{fontSize:13,lineHeight:1.8,marginTop:0}}>{advice.content.summary}</p>
        <p style={muted}>{advice.fromLine?`依据转写第 ${advice.fromLine}–${advice.throughLine} 段`:'会前资料预演'} · 基础信息 v{advice.briefRevision}</p>
        {advice.omittedLines>0&&<p style={muted}>本轮使用最近的转写窗口，并参考此前生成的事实摘要；更早内容可在“实时转写”中查看。</p>}
        <div role="tabpanel" aria-label={tab==='askedOfMe'?'可能问到我':'我可以追问'}>
          {tab==='askedOfMe'&&advice.content.askedOfMe.map((question,index)=><section key={index} style={{border:'1px solid #8883',borderRadius:10,padding:12,marginBottom:12}}><strong style={{fontSize:14,lineHeight:1.7}}>{index+1}. {question.question}</strong><p style={{...muted,margin:'8px 0'}}>{question.why}</p><Reply label="高情商版" text={question.tactfulReply}/><Reply label="精简版" text={question.conciseReply}/><Sources ids={question.sources} advice={advice}/></section>)}
          {tab==='askOthers'&&advice.content.askOthers.map((question,index)=><section key={index} style={{border:'1px solid #8883',borderRadius:10,padding:12,marginBottom:12}}><strong style={{fontSize:14,lineHeight:1.7}}>{index+1}. {question.question}</strong><p style={{fontSize:12,lineHeight:1.7}}><b>目的：</b>{question.purpose}<br/><b>时机：</b>{question.timing}</p><Sources ids={question.sources} advice={advice}/></section>)}
        </div>
      </article>:<div style={{...muted,padding:'20px 0'}}>会议中新增 500 字，或满 5 分钟且有新内容时，会根据你的角色生成建议。也可以点击上方按钮，主动预演或分析当前内容。<p>建议只显示在这里，不会自动代你发言或发送消息。</p></div>}
    </div>
    {/* Round-level, not list-level: it would otherwise be duplicated into both
        tabs, so it sits outside them and stays collapsed until asked for. */}
    {ready&&!!advice!.content.uncertainties.length&&<details style={{...muted,flexShrink:0,borderTop:'1px solid #8883',paddingTop:10,paddingBottom:2}}>
      <summary style={{cursor:'pointer'}}>需要确认 · {advice!.content.uncertainties.length}</summary>
      <ul style={{paddingLeft:18,margin:'8px 0 0'}}>{advice!.content.uncertainties.map((item,index)=><li key={index}>{item}</li>)}</ul>
    </details>}
  </div>;
}
