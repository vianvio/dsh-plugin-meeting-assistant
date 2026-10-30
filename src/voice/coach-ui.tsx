import React,{useEffect,useId,useRef,useState} from 'react';
import type {VoiceCall} from './capture.js';
import {EMPTY_BRIEF,type Advice,type CoachStatus,type PublicBrief} from './coach-types.js';

const button:React.CSSProperties={border:'1px solid #8885',borderRadius:7,background:'transparent',color:'inherit',padding:'7px 10px',cursor:'pointer',fontSize:12};
const primary:React.CSSProperties={...button,background:'#2769e7',borderColor:'#2769e7',color:'white'};
const muted:React.CSSProperties={fontSize:12,opacity:.65,lineHeight:1.6,overflowWrap:'anywhere'};
export type BriefCache=Map<string,PublicBrief>;
type GoalOption={id:string;label:string;text:string};
type GoalPolish={key:string;request:number;loading:boolean;options:GoalOption[];selected:string|null};
type BriefEditorProps={
  sessionId:string;recordingId?:string;call:VoiceCall;getCwd:()=>string;cache:BriefCache;
  onSaved:()=>Promise<void>;onStart:()=>Promise<void>;compact?:boolean;showStart?:boolean;
  showSave?:boolean;disabled?:boolean;onDraftChange?:(brief:PublicBrief)=>void;
};

export function BriefEditor({sessionId,recordingId,call,getCwd,cache,onSaved,onStart,compact=false,showStart=true,showSave=true,disabled=false,onDraftChange}:BriefEditorProps){
  const key=`${sessionId}/${recordingId??'draft'}`,workspaceCwd=getCwd(),inputId=useId();
  const [brief,setBrief]=useState<PublicBrief>({...EMPTY_BRIEF,files:[]});
  const [loadedKey,setLoadedKey]=useState<string|null>(null),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
  const [polish,setPolish]=useState<GoalPolish|null>(null);
  const loaded=loadedKey===key,locked=disabled||busy||!loaded;
  const draft=useRef(brief),activeKey=useRef(key),generation=useRef(0),polishRequest=useRef(0);
  const services=useRef({call,getCwd}),draftChange=useRef(onDraftChange);
  activeKey.current=key;services.current={call,getCwd};draftChange.current=onDraftChange;
  const projectCwd=recordingId?(brief.cwd||workspaceCwd):workspaceCwd;
  const currentProject=()=>recordingId?(draft.current.cwd||services.current.getCwd()):services.current.getCwd();
  const normalize=(value:PublicBrief):PublicBrief=>({...EMPTY_BRIEF,...value,goal:value.goal??'',cwd:recordingId?(value.cwd||workspaceCwd):workspaceCwd,filePaths:[],files:value.files??[]});
  const invalidatePolish=()=>{polishRequest.current++;setPolish(null);};

  // A callback identity change must not reload the form or discard an unsaved draft.
  useEffect(()=>{
    let cancelled=false;const version=++generation.current;
    setLoadedKey(null);setBusy(false);setMessage('');invalidatePolish();
    const publish=(value:PublicBrief)=>{
      if(cancelled||generation.current!==version)return;
      const next=normalize(value);draft.current=next;cache.set(key,next);setBrief(next);setLoadedKey(key);
    };
    const saved=cache.get(key);
    if(saved)publish(saved);
    else void services.current.call('brief/get',{sessionId,recordingId}).then((value:PublicBrief)=>publish(cache.get(key)??value)).catch(error=>{
      if(!cancelled)setMessage(error instanceof Error?error.message:String(error));
    });
    return ()=>{cancelled=true;generation.current++;polishRequest.current++;};
  },[key,recordingId?'':workspaceCwd,cache]);
  useEffect(()=>{if(loadedKey===key)draftChange.current?.(brief);},[brief,key,loadedKey]);

  const change=(patch:Partial<PublicBrief>)=>{
    if(locked)return;
    invalidatePolish();
    const next={...draft.current,...patch,cwd:currentProject(),filePaths:[]};
    draft.current=next;cache.set(key,next);setBrief(next);setMessage('');
  };
  const polishGoal=async()=>{
    if(locked||!draft.current.goal.trim()||polish?.loading)return;
    const source=draft.current,project=currentProject(),request=++polishRequest.current;
    const current=()=>polishRequest.current===request&&activeKey.current===key&&currentProject()===project&&draft.current.goal===source.goal&&draft.current.invitation===source.invitation;
    setMessage('');setPolish({key,request,loading:true,options:[],selected:null});
    try{
      const result:{options:GoalOption[]}=await services.current.call('brief/polish',{sessionId,recordingId,cwd:project,invitation:source.invitation,goal:source.goal,role:source.role,initialViews:source.initialViews});
      if(!current())return;
      const options=result.options.filter(option=>option.id&&option.label&&option.text?.trim()).slice(0,3);
      if(!options.length)throw new Error('暂未生成候选，请重试。');
      setPolish({key,request,loading:false,options,selected:null});
    }catch(error){
      if(current()){setPolish(null);setMessage(error instanceof Error?error.message:String(error));}
    }
  };
  const save=async(start:boolean)=>{
    if(locked)return;
    const version=generation.current,source=draft.current,project=currentProject();
    const current=()=>generation.current===version&&activeKey.current===key;
    invalidatePolish();setBusy(true);setMessage('');
    try{
      const value:PublicBrief=await services.current.call('brief/save',{sessionId,recordingId,cwd:project,brief:{invitation:source.invitation,goal:source.goal,role:source.role,initialViews:source.initialViews,filePaths:[],autoEnabled:source.autoEnabled}});
      const saved={...value,goal:value.goal??source.goal,cwd:recordingId?(value.cwd||project):project,filePaths:[]};
      if(cache.get(key)===source)cache.set(key,saved);
      if(!current())return;
      draft.current=saved;setBrief(saved);setMessage('已保存。');await onSaved();
      if(start&&current())await onStart();
    }catch(error){if(current())setMessage(error instanceof Error?error.message:String(error));}
    finally{if(current())setBusy(false);}
  };
  const area=(field:'invitation'|'goal'|'role'|'initialViews',label:string,placeholder:string,rows=3)=><div style={{marginBottom:compact?14:20}}>
    <div style={{display:'flex',justifyContent:'space-between',gap:8,alignItems:'center',marginBottom:7}}>
      <label htmlFor={`${inputId}-${field}`} style={{fontSize:13,fontWeight:500}}>{label}</label>
      {field==='goal'&&<button type="button" style={{...button,border:0,padding:'3px 0',color:'#2769e7',opacity:(locked||!brief.goal.trim()||polish?.loading)?0.5:1}} disabled={locked||!brief.goal.trim()||!!polish?.loading} onClick={()=>void polishGoal()}>{polish?.key===key&&polish.loading?'润色中…':'AI 润色'}</button>}
    </div>
    <textarea id={`${inputId}-${field}`} aria-label={label} disabled={locked} maxLength={8000} value={brief[field]} onChange={event=>change({[field]:event.target.value})} placeholder={placeholder} rows={rows} style={{resize:'vertical',minHeight:compact?60:76,boxSizing:'border-box',width:'100%',border:'1px solid #8884',borderRadius:8,background:'transparent',color:'inherit',padding:compact?8:10,font:'inherit',fontSize:13,lineHeight:1.7}}/>
  </div>;
  const candidates=polish?.key===key&&polish.request===polishRequest.current?polish:null;
  const folder=projectCwd.replace(/[\\/]+$/,'').split(/[\\/]/).pop()||projectCwd||'当前项目';
  return <div>
    {area('invitation','会邀','会议主题、议程、参与者，或直接粘贴会邀',compact?2:3)}
    {area('goal','会议目标','希望会议形成什么结论、作出哪些决定？',compact?2:3)}
    {candidates&&<div role="group" aria-label="会议目标润色候选" aria-busy={candidates.loading} style={{margin:'-3px 0 20px'}}>
      {candidates.loading?null:<div role="radiogroup" aria-label="选择会议目标" style={{display:'grid',gap:8,marginBottom:10}}>
        {candidates.options.map(option=><label key={option.id} style={{display:'flex',alignItems:'flex-start',gap:9,border:`1px solid ${candidates.selected===option.id?'#2769e7':'#8884'}`,borderRadius:8,padding:11,cursor:locked?'default':'pointer'}}>
          <input type="radio" name={`${inputId}-goal-option`} aria-label={option.label} checked={candidates.selected===option.id} disabled={locked} onChange={()=>setPolish(previous=>previous?.request===candidates.request?{...previous,selected:option.id}:previous)} style={{marginTop:4}}/>
          <span style={{minWidth:0,overflowWrap:'anywhere'}}><strong style={{fontSize:12,fontWeight:500}}>{option.label}</strong><span style={{display:'block',fontSize:13,lineHeight:1.7,whiteSpace:'pre-wrap',marginTop:5}}>{option.text}</span></span>
        </label>)}
      </div>}
      <div style={{display:'flex',gap:8}}>
        {!candidates.loading&&<button type="button" style={primary} disabled={locked||!candidates.selected} onClick={()=>{const option=candidates.options.find(item=>item.id===candidates.selected);if(option)change({goal:option.text});}}>采用</button>}
        <button type="button" style={button} disabled={locked} onClick={invalidatePolish}>取消</button>
      </div>
    </div>}
    <details style={{borderTop:'1px solid #8883',padding:'12px 0 0',marginBottom:16}}>
      <summary aria-disabled={locked} onClick={event=>{if(locked)event.preventDefault();}} style={{fontSize:13,cursor:locked?'default':'pointer'}}>更多背景</summary>
      <div style={{paddingTop:16}}>{area('role','角色','你的职责与可决定的范围',2)}{area('initialViews','立场','当前判断、倾向的方案与待验证的假设',2)}</div>
    </details>
    <div title={projectCwd} style={{...muted,display:'flex',gap:7,alignItems:'center',minWidth:0}}>
      <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" style={{flexShrink:0}}><path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10H3Z"/></svg>
      <span style={{overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{folder}</span>
    </div>
    {message&&<p role="status" style={{fontSize:12,lineHeight:1.6,overflowWrap:'anywhere'}}>{message}</p>}
    {(showSave||(showStart&&!recordingId))&&<div style={{display:'flex',gap:8,flexWrap:'wrap',marginTop:16,paddingTop:12,borderTop:'1px solid #8883'}}>
      {showSave&&<button type="button" style={recordingId||!showStart?primary:button} disabled={locked} onClick={()=>void save(false)}>{busy?'处理中…':recordingId?'保存背景':'保存草稿'}</button>}
      {showStart&&!recordingId&&<button type="button" style={primary} disabled={locked} onClick={()=>void save(true)}>{busy?'处理中…':'保存并开始录音'}</button>}
    </div>}
  </div>;
}

function Sources({ids,advice}:{ids:string[];advice:Advice}){
  const evidence=advice.evidence.filter(item=>ids.includes(item.id));
  return evidence.length?<details style={{...muted,marginTop:12}}><summary style={{cursor:'pointer'}}>来源</summary>{evidence.map(item=><p key={item.id} style={{whiteSpace:'pre-wrap',borderLeft:'2px solid #8884',paddingLeft:9,margin:'9px 0 0'}}><strong style={{fontWeight:500}}>{item.label}</strong><br/>{item.excerpt}</p>)}</details>:null;
}
function Reply({label,text}:{label:string;text:string}){
  const [copied,setCopied]=useState(false);
  useEffect(()=>setCopied(false),[text]);
  return <div style={{marginTop:16}}><div style={{display:'flex',justifyContent:'space-between',alignItems:'center',gap:8}}><strong style={{fontSize:12,fontWeight:500,opacity:.7}}>{label}</strong><button type="button" style={{...button,border:0,padding:'1px 3px',opacity:.7}} onClick={()=>{void navigator.clipboard.writeText(text).then(()=>setCopied(true)).catch(()=>setCopied(false));}}>{copied?'已复制':'复制'}</button></div><p style={{fontSize:13,lineHeight:1.8,whiteSpace:'pre-wrap',overflowWrap:'anywhere',margin:'7px 0 0'}}>{text}</p></div>;
}
const reasonName={manual:'手动生成',characters:'新增 500 字',time:'5 分钟更新'};
type AdviceRead={scope:string;id:string;value:Advice|null;error:string;loading:boolean};
type AdvicePanelProps={sessionId:string;recordingId:string;status:CoachStatus;call:VoiceCall;onRefresh:()=>Promise<void>;onViewed?:(adviceId:string)=>void;view?:'questions'|'replies';actions?:boolean;historyOpen?:boolean;visible?:boolean};
export function AdvicePanel({sessionId,recordingId,status,call,onRefresh,onViewed,view='questions',actions=true,historyOpen=false,visible=true}:AdvicePanelProps){
  const scope=`${sessionId}/${recordingId}`;
  const [selection,setSelection]=useState({scope,id:status.latestId}),[read,setRead]=useState<AdviceRead|null>(null);
  const [operation,setOperation]=useState({scope,busy:false,error:''});
  const selected=selection.scope===scope?selection.id:null;
  const activeRead=read?.scope===scope&&read.id===selected?read:null;
  const advice=activeRead?.value??null,loading=!!selected&&(!activeRead||activeRead.loading);
  const busy=operation.scope===scope&&operation.busy;
  const viewed=useRef<string|null>(null),viewCallback=useRef(onViewed),service=useRef(call),activeScope=useRef(scope),actionRequest=useRef(0);
  const settings=useRef<HTMLDetailsElement>(null);
  viewCallback.current=onViewed;service.current=call;activeScope.current=scope;
  useEffect(()=>{if(settings.current)settings.current.open=historyOpen;},[historyOpen,scope]);
  // New results wait for an explicit click once a version has been selected.
  useEffect(()=>{setSelection(current=>current.scope!==scope?{scope,id:status.latestId}:!current.id&&status.latestId?{scope,id:status.latestId}:current);},[scope,status.latestId]);
  useEffect(()=>{
    if(!selected)return;
    let cancelled=false;setRead({scope,id:selected,value:null,error:'',loading:true});
    void service.current('coach/read',{sessionId,recordingId,adviceId:selected}).then((value:Advice)=>{
      if(!cancelled)setRead({scope,id:selected,value,error:'',loading:false});
    }).catch(error=>{if(!cancelled)setRead({scope,id:selected,value:null,error:error instanceof Error?error.message:String(error),loading:false});});
    return ()=>{cancelled=true;};
  },[selected,scope]);
  useEffect(()=>{if(!visible||!advice||loading)return;const key=`${scope}/${advice.id}`;if(viewed.current!==key){viewed.current=key;viewCallback.current?.(advice.id);}},[advice,loading,scope,visible]);
  const action=async(endpoint:string,extra={})=>{
    if(busy)return;
    const request=++actionRequest.current,current=()=>activeScope.current===scope&&actionRequest.current===request;
    setOperation({scope,busy:true,error:''});
    try{await service.current(endpoint,{sessionId,recordingId,...extra});if(current())await onRefresh();}
    catch(error){if(current())setOperation({scope,busy:false,error:error instanceof Error?error.message:String(error)});}
    finally{if(current())setOperation(previous=>({...previous,busy:false}));}
  };
  const visibleError=(operation.scope===scope?operation.error:'')||activeRead?.error||status.error;
  const newAdvice=!!status.latestId&&selected!==status.latestId;
  return <div>
    {!actions&&historyOpen&&!!status.history.length&&<select aria-label="选择发言建议版本" value={selected??''} onChange={event=>setSelection({scope,id:event.target.value})} style={{...button,width:'100%',minWidth:0,marginBottom:16}}>{status.history.map(item=><option key={item.id} value={item.id}>{new Date(item.createdAt).toLocaleTimeString()} · {reasonName[item.reason]}</option>)}</select>}
    {(actions||newAdvice)&&<div style={{display:'grid',gap:10,marginBottom:16}}>
      {actions&&<div style={{display:'flex',gap:8,flexWrap:'wrap'}}><button type="button" style={primary} disabled={busy||!!status.running} onClick={()=>void action('coach/generate')}>{status.running?'正在生成…':'立即生成'}</button>{status.running&&<button type="button" style={button} disabled={busy} onClick={()=>void action('coach/cancel')}>取消</button>}</div>}
      {newAdvice&&<button type="button" style={{...button,color:'#2769e7',textAlign:'left'}} onClick={()=>setSelection({scope,id:status.latestId})}>有新建议，点击查看</button>}
    </div>}
    {visibleError==='已取消本次生成。'?<p role="status" style={muted}>已取消</p>:visibleError&&<p role="alert" style={{color:'#dc5e57',fontSize:12,lineHeight:1.6,overflowWrap:'anywhere'}}>{visibleError}</p>}
    {loading?<p style={muted}>读取建议…</p>:advice?<article key={advice.id} aria-label="会议发言建议内容">
      {advice.content.summary.trim()&&<p style={{fontSize:13,lineHeight:1.8,opacity:.7,whiteSpace:'pre-wrap',overflowWrap:'anywhere',margin:'0 0 8px'}}>{advice.content.summary}</p>}
      {view==='questions'?<div aria-label="值得追问">
        {advice.content.askOthers.slice(0,3).map((question,index)=>{
          const timing=question.timing.trim(),showTiming=timing&&timing!==question.purpose.trim()&&!/^(随时|适时|必要时|合适时机|适当时机)[。.!！]?$/.test(timing);
          return <section key={index} style={{display:'grid',gridTemplateColumns:'22px minmax(0,1fr)',gap:10,padding:'20px 0',borderBottom:'1px solid #8882'}}>
            <span aria-hidden="true" style={{fontSize:18,lineHeight:1.55,opacity:.32,fontVariantNumeric:'tabular-nums'}}>{index+1}</span>
            <div><h3 style={{fontSize:16,lineHeight:1.65,fontWeight:600,margin:0,overflowWrap:'anywhere'}}>{question.question}</h3>
              {question.purpose.trim()&&<p style={{fontSize:13,lineHeight:1.8,margin:'10px 0 0',overflowWrap:'anywhere'}}>{question.purpose}</p>}
              {showTiming&&<p style={{...muted,margin:'7px 0 0'}}>{timing}</p>}
              <Sources ids={question.sources} advice={advice}/>
            </div>
          </section>;
        })}
        {!advice.content.askOthers.length&&<p style={{...muted,margin:'20px 0'}}>本轮没有值得追问的问题。</p>}
      </div>:<div aria-label="回应参考">
        {advice.content.askedOfMe.map((question,index)=><details key={index} style={{padding:'18px 0',borderBottom:'1px solid #8882'}}>
          <summary style={{fontSize:15,fontWeight:600,lineHeight:1.7,cursor:'pointer',overflowWrap:'anywhere'}}>{question.question}</summary>
          {question.why.trim()&&<p style={{fontSize:13,lineHeight:1.8,opacity:.7,margin:'12px 0 0',overflowWrap:'anywhere'}}>{question.why}</p>}
          <Reply label="精简版" text={question.conciseReply}/><Reply label="高情商版" text={question.tactfulReply}/><Sources ids={question.sources} advice={advice}/>
        </details>)}
        {!advice.content.askedOfMe.length&&<p style={{...muted,margin:'20px 0'}}>本轮没有回应参考。</p>}
      </div>}
      {!!advice.content.uncertainties.length&&<details style={{...muted,padding:'14px 0'}}><summary style={{cursor:'pointer'}}>待确认</summary><ul style={{paddingLeft:18,margin:'8px 0 0'}}>{advice.content.uncertainties.map((item,index)=><li key={index}>{item}</li>)}</ul></details>}
    </article>:!activeRead?.error&&<p style={{...muted,margin:'20px 0'}}>暂时没有建议。</p>}
    {actions&&<details ref={settings} style={{borderTop:'1px solid #8883',padding:'14px 0',marginTop:14}}>
      <summary style={{fontSize:12,opacity:.65,cursor:'pointer'}}>分析设置</summary>
      <div style={{display:'grid',gap:16,paddingTop:14}}>
        <label style={{display:'flex',gap:8,alignItems:'center',fontSize:12}}><input type="checkbox" aria-label="会议期间自动生成建议" disabled={busy} checked={status.autoEnabled} onChange={event=>void action('coach/auto',{enabled:event.target.checked})}/>自动分析</label>
        {!!status.history.length&&<label style={{display:'grid',gap:7,fontSize:12}}>历史建议<select aria-label="选择发言建议版本" value={selected??''} onChange={event=>setSelection({scope,id:event.target.value})} style={{...button,width:'100%',minWidth:0}}><option value="" disabled>选择版本</option>{status.history.map(item=><option key={item.id} value={item.id}>{new Date(item.createdAt).toLocaleString()} · {reasonName[item.reason]}</option>)}</select></label>}
      </div>
    </details>}
  </div>;
}
