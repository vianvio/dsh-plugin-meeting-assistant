import React,{useState,useSyncExternalStore} from 'react';
import {createRoot} from 'react-dom/client';
import {MeetingToggle} from '../../src/voice/client';
import {MeetingCapture} from '../../src/voice/capture';
import {createRpcCall} from '../../src/shared/rpc-call';
import {sharedLog} from '../../src/shared/diag';
import {dockStore} from '../../src/shared/dock/dock-store';
import {EMPTY_BRIEF,COACH_RULE} from '../../src/voice/coach-types';

const query=new URLSearchParams(location.search);
const calls:any[]=[];let configured=!query.has('unconfigured'),permissionMode=query.get('permission')??'granted',stoppedTracks=0;
let nextQuestion:string|undefined,hostVersion=query.get('hostVersion')??'0.1.6';
let active:any=null,selected=new Map<string,string>(),records:any[]=[],revision=0;
const briefs=new Map<string,any>(),advices=new Map<string,any>(),coaches=new Map<string,any>();
let latestWorklet:any,routeFailures=0,failedRequests=0,analysisMode=query.get('analysis')??'ready',cancelMode=query.get('cancel')??'ready',holdStatus=false;
const analyses=new Map<string,any>(),heldStatuses:any[]=[],heldCancels:any[]=[];
const awaiting:any[]=[],polishes:any[]=[];let polishMode=query.get('polish')??'ready',setSession:(id:string)=>void,setCwd:(path:string)=>void;
const blank=()=>({...structuredClone(EMPTY_BRIEF),files:[],cwd:'/preview'});
const coach=()=>({throughLine:0,coveredChars:0,lastSuccessAt:0,lastAttemptAt:0,failedThroughLine:-1,latestId:null,running:null,error:null,history:[],autoEnabled:true,pendingChars:300,pendingLines:3,rule:COACH_RULE});
function addAdvice(recordingId:string,question='余额清零后，超出的费用应如何记账？'){
 const state=coaches.get(recordingId),id=`advice-${++revision}`;
 const item={id,createdAt:Date.now(),reason:'manual',fromLine:1,throughLine:70,briefRevision:1,omittedLines:0,model:'fixture',evidence:[{id:'T1',label:'会议讨论',excerpt:'计费异步，可能超额，余额清零。'}],content:{summary:'讨论了异步扣费与余额清零的规则。',askOthers:[{question,purpose:'明确实际消耗与余额之间的差额如何处理。',timing:'确认清零规则时。',sources:['T1']}],askedOfMe:[{question:'上线之前还需要确认什么？',why:'计费规则仍有待确认。',tactfulReply:'建议先确认调整流水的口径，再验证并发调用场景。',conciseReply:'先确认差额处理，再验证并发。',sources:['T1']}],uncertainties:['差额由哪一方承担。'],carryForward:'预算与消耗规则待确认。'}};
 advices.set(id,item);state.latestId=id;state.error=null;state.running=null;state.history.unshift((({content,evidence,model,omittedLines,...index})=>index)(item));return id;
}
// The preview substitutes both audio and service boundaries. No real microphone or model is contacted.
function stream(){const track:any={label:'模拟麦克风',stop(){stoppedTracks++;},addEventListener(){}};return {getTracks:()=>[track],getAudioTracks:()=>[track]};}
Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:()=>new Promise((resolve,reject)=>{calls.push({endpoint:'getUserMedia'});if(permissionMode==='pending')awaiting.push({resolve,reject});else if(permissionMode==='denied')reject(new DOMException('Denied','NotAllowedError'));else resolve(stream());})}});
class Context {destination={};audioWorklet={addModule:async()=>{}};async resume(){}async close(){}createMediaStreamSource(){return {connect(){},disconnect(){}};}}
class Worklet {constructor(){latestWorklet=this;}port:any={onmessage:null,postMessage:()=>queueMicrotask(()=>this.port.onmessage?.({data:'flushed'}))};connect(){}disconnect(){}}
Object.assign(window,{AudioContext:Context,AudioWorkletNode:Worklet});
let updates:any={currentVersion:'0.1.7',installedVersion:'0.1.7',latestVersion:query.has('updateAvailable')?'0.1.8':null,phase:query.has('updateAvailable')?'available':'idle',autoUpdate:true,lastCheckedAt:null,source:'npm',canInstall:true,error:null};
let holdUpdateStatus=false,updateCheckError=false,holdUpdateSettings=false;const heldUpdateStatuses:any[]=[],heldUpdateSettings:any[]=[];
const handleCall=async(endpoint:string,p:any={})=>{
 calls.push({endpoint,payload:p});
 if(endpoint==='update/status'){const snapshot=structuredClone(updates);if(holdUpdateStatus){holdUpdateStatus=false;return new Promise(resolve=>heldUpdateStatuses.push({resolve,snapshot}));}return snapshot;}
 if(endpoint==='update/check'){if(updateCheckError)throw new Error('network unavailable');updates.lastCheckedAt=Date.now();updates.latestVersion=query.has('updateAvailable')?'0.1.8':'0.1.7';updates.phase=updates.source==='development'?'unsupported':updates.latestVersion===updates.currentVersion?'idle':'available';return structuredClone(updates);}
 if(endpoint==='update/settings'){const apply=()=>{updates.autoUpdate=p.enabled;if(!p.enabled&&updates.phase==='waiting')updates.phase='available';return structuredClone(updates);};if(holdUpdateSettings)return new Promise(resolve=>heldUpdateSettings.push(()=>resolve(apply())));return apply();}
 if(endpoint==='update/install'){if(!updates.canInstall)throw new Error('unsupported');updates.phase=active||Array.from(coaches.values()).some(c=>c.running)?'waiting':'installing';return structuredClone(updates);}
 if(endpoint==='config')return {configured,wsBase:'wss://example.invalid/asr',model:'fixture',hostVersion};
 if(endpoint==='save'){if(!configured&&!p.apiKey)throw new Error('请填写百炼 API Key。');configured=true;return {configured,wsBase:p.wsBase,model:p.model};}
 if(endpoint==='brief/polish'){
  if(!p.goal?.trim())throw new Error('请先填写会议目标。');
  const options=[{id:'clarify',label:'明确结论',text:`围绕${p.goal}，确认计费差额的处理规则与验收依据。`},{id:'decide',label:'聚焦决策',text:`就${p.goal}形成可执行的方案，明确边界与后续行动。`},{id:'risks',label:'核对风险',text:`核对${p.goal}中的并发与对账风险，列出需要验证的假设。`}];
  if(polishMode==='pending')return new Promise((resolve,reject)=>polishes.push({resolve,reject,options}));
  if(polishMode==='error')throw new Error('润色暂时不可用，请重试。');
  return {options};
 }
 if(endpoint==='brief/get')return structuredClone(briefs.get(`${p.sessionId}/${p.recordingId??'draft'}`)??blank());
 if(endpoint==='brief/save'){const key=`${p.sessionId}/${p.recordingId??'draft'}`,previous=briefs.get(key);const value={...blank(),...p.brief,cwd:p.recordingId?(previous?.cwd??p.cwd):p.cwd,revision:++revision};briefs.set(key,value);return structuredClone(value);}
 if(endpoint==='start'){
  const id=`recording-${++revision}`,now=Date.now();const meta={id,sessionId:p.sessionId,startedAt:now,endedAt:null,state:'recording',segments:70,audioBytes:32000,error:null,reconnects:0,droppedBytes:0,untranscribedBytes:0,wsState:'ready'};
  records.unshift(meta);active={sessionId:p.sessionId,id,state:'recording'};selected.set(p.sessionId,id);coaches.set(id,coach());briefs.set(`${p.sessionId}/${id}`,briefs.get(`${p.sessionId}/draft`)??blank());return {token:id,recording:structuredClone(meta)};
 }
 if(endpoint==='stop'){const meta=records.find(r=>r.id===p.token);if(meta){meta.state='stopped';meta.endedAt=Date.now();}if(active?.id===p.token)active=null;return {stopped:true};}
 if(endpoint==='audio')return {accepted:true};
 const matching=records.filter(r=>r.sessionId===p.sessionId),meta=matching.find(r=>r.id===(p.recordingId??selected.get(p.sessionId)))??matching[0];
 const entries=meta?Array.from({length:meta.segments},(_,i)=>({line:i+1,ts:meta.startedAt+i*1000,startMs:(i%10)*1000,endMs:(i%10+1)*1000,text:`第 ${i+1} 段会议转写，正在确认计费和余额规则。` })):[];
 if(endpoint==='status'){const snapshot=structuredClone({hostVersion,updates,active,recordings:matching,result:meta?{recording:meta,entries:entries.slice(-60),transcriptPath:'/preview/transcript.jsonl'}:null,coach:meta?coaches.get(meta.id):null});if(holdStatus){holdStatus=false;return new Promise(resolve=>heldStatuses.push({resolve,snapshot}));}return snapshot;}
 if(endpoint==='select'){selected.set(p.sessionId,p.recordingId);return {selected:true};}
 if(endpoint==='read'){const result=entries.filter(e=>e.line>(p.afterLine??0)).slice(0,p.lines??200);return {entries:result,hasMore:result.at(-1)?.line<meta.segments,nextAfterLine:result.at(-1)?.line??0};}
 if(endpoint==='coach/generate'){if(analysisMode==='pending'){const id=`job-${++revision}`,state=coaches.get(p.recordingId);state.running={id,startedAt:Date.now(),reason:'manual',throughLine:meta.segments,briefRevision:1};state.error=null;analyses.set(id,{recordingId:p.recordingId,cancelled:false});return {accepted:true,jobId:id};}addAdvice(p.recordingId,nextQuestion);return {accepted:true};}
 if(endpoint==='coach/read')return structuredClone(advices.get(p.adviceId));
 if(endpoint==='coach/auto'){coaches.get(p.recordingId).autoEnabled=p.enabled;return {autoEnabled:p.enabled};}
 if(endpoint==='coach/cancel'){if(cancelMode==='error')throw new Error('取消暂时失败，请重试。');const apply=()=>{const state=coaches.get(p.recordingId),id=state.running?.id;if(!id||(p.jobId&&p.jobId!==id))return {cancelled:false};analyses.get(id).cancelled=true;state.running=null;state.error='已取消本次生成。';return {cancelled:true,jobId:id};};if(cancelMode==='pending')return new Promise(resolve=>heldCancels.push(()=>resolve(apply())));return apply();}
 if(endpoint==='files/list')return {root:'/preview',dir:'',entries:[],truncated:false};
 throw new Error(`Unexpected endpoint ${endpoint}`);
};
const call=createRpcCall({transport:{async call(_channel,endpoint,payload){
 if(endpoint==='audio'&&routeFailures>0){routeFailures--;failedRequests++;throw new Error('transport failure for /meeting-assistant/audio: HTTP 405');}
 try{return {ok:true,value:await handleCall(endpoint,payload)};}catch(error){return {ok:false,error:{message:error instanceof Error?error.message:String(error)}};}
}},channel:'/meeting-assistant',label:'会议助手',marker:'fixture',diag:sharedLog('meeting-ui-preview'),defaultDeadlineMs:30000,retry:{endpoints:['audio','stop','status'],delaysMs:[20,40,80,100]}});
const capture=new MeetingCapture(call),briefCache=new Map();

function Panel(){const state=useSyncExternalStore(dockStore.subscribe,dockStore.getSnapshot);const panel=state.panels.find(p=>p.id===state.active);return panel?<aside id="preview-panel">{panel.render()}</aside>:null;}
function App(){const [sessionId,set]=useState('preview-session'),[cwd,updateCwd]=useState('/preview/project');setSession=set;setCwd=updateCwd;return <main><div className="conversation"><div className="empty-chat">会议助手交互验证<small>模拟录音与 AI 候选，供交互验收。</small></div><footer id="meeting-entry"><MeetingToggle clientVersion={query.get('clientVersion')??undefined} sessionId={sessionId} call={call} capture={capture} available closeDetails={()=>{}} getCwd={()=>cwd} briefCache={briefCache}/><MeetingToggle sessionId="preview-child" call={call} capture={capture} available={false} closeDetails={()=>{}} getCwd={()=>cwd} briefCache={briefCache}/></footer></div><Panel/></main>;}
(window as any).__meetingTest={calls,setUpdates(value:any){Object.assign(updates,value);},get updates(){return updates;},holdNextUpdateStatus(){holdUpdateStatus=true;},get heldUpdateStatusCount(){return heldUpdateStatuses.length;},resolveUpdateStatus(){for(const item of heldUpdateStatuses.splice(0))item.resolve(item.snapshot);},holdUpdateSettings(){holdUpdateSettings=true;},resolveUpdateSettings(){holdUpdateSettings=false;for(const apply of heldUpdateSettings.splice(0))apply();},setUpdateCheckError(value:boolean){updateCheckError=value;},finishPluginUpdate(){if(active||Array.from(coaches.values()).some(c=>c.running))return false;updates.installedVersion=updates.latestVersion;updates.phase='restart';return true;},setHostVersion(version:string){hostVersion=version;},setAnalysisMode(mode:string){analysisMode=mode;},setCancelMode(mode:string){cancelMode=mode;},resolveCancel(){for(const apply of heldCancels.splice(0))apply();},holdNextStatus(){holdStatus=true;},resolveStatus(){for(const p of heldStatuses.splice(0))p.resolve(p.snapshot);},get heldStatusCount(){return heldStatuses.length;},get currentJobId(){return coaches.get(active?.id??records[0]?.id)?.running?.id;},finishAnalysis(id:string,question:string){const job=analyses.get(id),state=job&&coaches.get(job.recordingId);if(!job||job.cancelled||state.running?.id!==id)return false;addAdvice(job.recordingId,question);state.running=null;return true;},failAudio(count:number){routeFailures=count;},emitAudio(){latestWorklet.port.onmessage?.({data:new Uint8Array(3200)});},get failedRequests(){return failedRequests;},setPolishMode(mode:string){polishMode=mode;},resolvePolish(){for(const p of polishes.splice(0))p.resolve({options:p.options});},setCwd(path:string){setCwd(path);},get capture(){return capture.snapshot();},get active(){return active;},get stoppedTracks(){return stoppedTracks;},resolvePermission(){for(const p of awaiting.splice(0))p.resolve(stream());permissionMode='granted';},setPermission(mode:string){permissionMode=mode;},setNextQuestion(question:string){nextQuestion=question;},pushAdvice(question:string){return addAdvice(active?.id??records[0].id,question);},setSession(id:string){setSession(id);},get records(){return records;}};
createRoot(document.getElementById('root')!).render(<App/>);
