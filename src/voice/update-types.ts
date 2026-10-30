export type PluginUpdatePhase='idle'|'checking'|'available'|'waiting'|'installing'|'restart'|'error'|'unsupported';
export interface PluginUpdateStatus {
  currentVersion:string;
  installedVersion:string|null;
  latestVersion:string|null;
  phase:PluginUpdatePhase;
  autoUpdate:boolean;
  lastCheckedAt:number|null;
  source:'npm'|'archive'|'development'|'unknown';
  canInstall:boolean;
  error:string|null;
}
