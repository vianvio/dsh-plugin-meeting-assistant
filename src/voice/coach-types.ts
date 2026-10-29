export const COACH_RULE={characters:500,intervalMs:5*60_000,cooldownMs:60_000} as const;
export interface ReferenceFile {path:string;size:number;text:string;truncated:boolean;savedAt:number}
export interface MeetingBrief {
  invitation:string;role:string;initialViews:string;cwd:string;filePaths:string[];
  autoEnabled:boolean;revision:number;updatedAt:number;files:ReferenceFile[];
}
export interface BriefDraft {invitation:string;role:string;initialViews:string;filePaths:string[];autoEnabled:boolean}
export type PublicBrief=Omit<MeetingBrief,'files'> & {files:Array<Omit<ReferenceFile,'text'> & {characters:number}>};
export const EMPTY_BRIEF:MeetingBrief={invitation:'',role:'',initialViews:'',cwd:'',filePaths:[],autoEnabled:true,revision:0,updatedAt:0,files:[]};
export interface Evidence {id:string;label:string;excerpt:string}
interface AskedQuestion {question:string;why:string;tactfulReply:string;conciseReply:string;sources:string[]}
interface AskQuestion {question:string;purpose:string;timing:string;sources:string[]}
export interface AdviceContent {summary:string;askedOfMe:AskedQuestion[];askOthers:AskQuestion[];uncertainties:string[];carryForward:string}
export interface AdviceIndex {id:string;createdAt:number;reason:'manual'|'characters'|'time';fromLine:number;throughLine:number;briefRevision:number}
export interface Advice extends AdviceIndex {content:AdviceContent;evidence:Evidence[];omittedLines:number;model:string}
interface CoachJob {id:string;startedAt:number;throughLine:number;briefRevision:number;reason:AdviceIndex['reason']}
export interface CoachState {
  throughLine:number;coveredChars:number;lastSuccessAt:number;lastAttemptAt:number;
  failedThroughLine:number;latestId:string|null;running:CoachJob|null;error:string|null;history:AdviceIndex[];
}
export interface CoachStatus extends CoachState {autoEnabled:boolean;pendingChars:number|null;pendingLines:number;rule:typeof COACH_RULE}
export type GenerateAdvice=(input:{system:string;prompt:string},signal:AbortSignal,sessionId:string)=>Promise<string>;
