import type {PluginUpdateStatus} from './update-types.js';

export interface UpdatePreferences {
  autoUpdate:boolean;
  lastCheckedAt:number|null;
  latestVersion:string|null;
}
export interface PluginInstallation {
  version:string|null;
  source:PluginUpdateStatus['source'];
  canInstall:boolean;
}
export interface PluginUpdaterOptions {
  version:string;
  inspect:()=>PluginInstallation;
  latest:(signal:AbortSignal)=>Promise<string>;
  install:(version:string,signal:AbortSignal)=>Promise<void>;
  busy:()=>boolean;
  load:()=>Partial<UpdatePreferences>;
  save:(preferences:UpdatePreferences)=>void;
  now?:()=>number;
  checkIntervalMs?:number;
  pollMs?:number;
  startDelayMs?:number;
}

const DAY=24*60*60*1000;
const CHECK_TIMEOUT=10_000;
const INSTALL_TIMEOUT=180_000;
const STOP_CHECK=Symbol('stop background update check');
const STABLE=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const stable=(value:unknown):value is string=>typeof value==='string'&&value.length<=256&&STABLE.test(value);
function compare(a:string,b:string):number {
  const left=a.split('.'),right=b.split('.');
  for(let i=0;i<3;i++){
    if(left[i].length!==right[i].length)return left[i].length>right[i].length?1:-1;
    if(left[i]!==right[i])return left[i]>right[i]?1:-1;
  }
  return 0;
}
const message=(error:unknown,fallback:string)=>error instanceof Error&&error.message?error.message.slice(0,500):fallback;
const duration=(value:number|undefined,fallback:number)=>value!==undefined&&Number.isFinite(value)&&value>=0?value:fallback;

/** Only coordinates updates. The injected driver owns registry access and installation. */
export class PluginUpdater {
  private readonly options:PluginUpdaterOptions;
  private readonly now:()=>number;
  private readonly checkIntervalMs:number;
  private readonly pollMs:number;
  private readonly startDelayMs:number;
  private state:PluginUpdateStatus;
  private persistenceError:string|null=null;
  private nextCheckAt:number;
  private failedVersion:string|null=null;
  private queuedVersion:string|null=null;
  private activities=0;
  private requestGeneration=0;
  private checkFlight:Promise<PluginUpdateStatus>|null=null;
  private checkController:AbortController|null=null;
  private backgroundCheck=false;
  private requestFlight:Promise<PluginUpdateStatus>|null=null;
  private installFlight:Promise<void>|null=null;
  private tickFlight:Promise<void>|null=null;
  private timer:ReturnType<typeof setTimeout>|null=null;
  private running=false;
  private scheduleGeneration=0;

  constructor(options:PluginUpdaterOptions){
    this.options=options;
    this.now=options.now??Date.now;
    this.checkIntervalMs=duration(options.checkIntervalMs,DAY);
    this.pollMs=Math.max(1,duration(options.pollMs,30_000));
    this.startDelayMs=duration(options.startDelayMs,30_000);
    this.state={currentVersion:options.version,installedVersion:null,latestVersion:null,phase:'idle',autoUpdate:true,lastCheckedAt:null,source:'unknown',canInstall:false,error:null};
    try{
      const prefs=options.load();
      if(prefs===null||typeof prefs!=='object')throw new Error('插件更新设置无效。');
      if(prefs.autoUpdate!==undefined&&typeof prefs.autoUpdate!=='boolean')throw new Error('插件更新设置无效。');
      if(prefs.lastCheckedAt!==undefined&&prefs.lastCheckedAt!==null&&(!Number.isFinite(prefs.lastCheckedAt)||prefs.lastCheckedAt<0))throw new Error('插件更新设置无效。');
      if(prefs.latestVersion!==undefined&&prefs.latestVersion!==null&&!stable(prefs.latestVersion))throw new Error('插件版本信息无效。');
      this.state.autoUpdate=prefs.autoUpdate??true;
      this.state.lastCheckedAt=prefs.lastCheckedAt??null;
      this.state.latestVersion=prefs.latestVersion??null;
    }catch(error){this.persistenceError=message(error,'无法读取插件更新设置。');}
    this.nextCheckAt=this.state.lastCheckedAt===null?0:Math.min(this.state.lastCheckedAt,this.now())+this.checkIntervalMs;
    if(!stable(options.version))this.fail('当前插件版本信息无效。');
    else if(this.inspect())this.setRestingPhase();
    if(this.persistenceError)this.fail(this.persistenceError);
  }

  snapshot():PluginUpdateStatus{return {...this.state};}

  check():Promise<PluginUpdateStatus>{return this.beginCheck(false);}

  /** Resolves after accepting/queuing work, never after the installer completes. */
  requestInstall():Promise<PluginUpdateStatus>{
    if(this.requestFlight)return this.requestFlight;
    if(this.installFlight||this.state.phase==='installing')return Promise.resolve(this.snapshot());
    try{
      if(!this.inspect())return Promise.resolve(this.snapshot());
      if(this.needsRestart()){this.setRestingPhase();return Promise.resolve(this.snapshot());}
      if(!this.state.canInstall){this.state.phase='unsupported';return Promise.resolve(this.snapshot());}
      if(this.state.latestVersion!==null&&!this.checkFlight){this.queueInstall(this.state.latestVersion);return Promise.resolve(this.snapshot());}
    }catch(error){this.fail(message(error,'无法安排插件更新。'));return Promise.resolve(this.snapshot());}
    const generation=this.requestGeneration;
    this.requestFlight=(async()=>{
      try{
        const checked=await this.check();
        if(generation===this.requestGeneration&&checked.phase!=='error'&&this.state.latestVersion!==null)this.queueInstall(this.state.latestVersion);
      }catch(error){this.fail(message(error,'无法安排插件更新。'));}
      finally{this.requestFlight=null;}
      return this.snapshot();
    })();
    return this.requestFlight;
  }

  setEnabled(enabled:boolean):PluginUpdateStatus{
    if(!enabled){
      this.requestGeneration++;
      if(this.backgroundCheck)this.checkController?.abort(STOP_CHECK);
      this.queuedVersion=null;
      if(this.state.phase==='waiting')this.setRestingPhase();
    }
    if(this.persist({...this.preferences(),autoUpdate:enabled})){
      this.state.autoUpdate=enabled;
      if(this.state.phase!=='installing'&&this.state.phase!=='checking')this.setRestingPhase();
    }
    return this.snapshot();
  }

  tick():Promise<void>{
    if(this.tickFlight)return this.tickFlight;
    const generation=this.scheduleGeneration;
    this.tickFlight=(async()=>{
      try{
        if(this.installFlight||this.state.phase==='installing')return;
        if(this.state.autoUpdate&&!this.persistenceError&&this.now()>=this.nextCheckAt)await this.beginCheck(true);
        if(generation!==this.scheduleGeneration||this.state.phase==='error'||this.state.phase==='checking')return;
        if(this.queuedVersion!==null){this.queueInstall(this.queuedVersion);return;}
        if(!this.state.autoUpdate||this.persistenceError)return;
        const version=this.state.latestVersion;
        if(version!==null&&version!==this.failedVersion&&this.state.canInstall&&!this.needsRestart())this.queueInstall(version);
      }catch(error){this.fail(message(error,'后台插件更新失败。'));}
      finally{this.tickFlight=null;}
    })();
    // Even a tick which does no asynchronous work must release its shared flight.
    const flight=this.tickFlight;
    void flight.then(()=>{if(this.tickFlight===flight)this.tickFlight=null;});
    return flight;
  }

  start():void{
    if(this.running)return;
    this.running=true;
    this.scheduleGeneration++;
    this.schedule(this.startDelayMs,this.scheduleGeneration);
  }

  /** Hot reload must not cancel, wait for, or unlock an existing installation. */
  stop():void{
    this.running=false;
    this.scheduleGeneration++;
    if(this.timer!==null){clearTimeout(this.timer);this.timer=null;}
    if(this.backgroundCheck)this.checkController?.abort(STOP_CHECK);
  }

  setVersion(version:string):void{
    if(!stable(version)){
      if(this.state.phase==='installing')this.state.error='当前插件版本信息无效。';
      else this.fail('当前插件版本信息无效。');
      return;
    }
    this.state.currentVersion=version;
    if(this.state.phase==='installing'||this.state.phase==='checking')return;
    if(this.inspect())this.setRestingPhase();
  }

  reserveActivity():()=>void{
    if(this.state.phase==='installing')throw new Error('插件正在更新，请稍后重试。');
    this.activities++;
    let released=false;
    return ()=>{if(!released){released=true;this.activities--;}};
  }

  private schedule(delay:number,generation:number):void{
    this.timer=setTimeout(()=>{
      this.timer=null;
      if(!this.running||generation!==this.scheduleGeneration)return;
      void this.tick().finally(()=>{
        if(this.running&&generation===this.scheduleGeneration)this.schedule(this.pollMs,generation);
      });
    },delay);
    this.timer.unref?.();
  }

  private beginCheck(background:boolean):Promise<PluginUpdateStatus>{
    if(this.checkFlight){if(!background)this.backgroundCheck=false;return this.checkFlight;}
    if(this.installFlight||this.state.phase==='installing')return Promise.resolve(this.snapshot());
    const controller=new AbortController();
    this.checkController=controller;
    this.backgroundCheck=background;
    this.nextCheckAt=this.now()+this.checkIntervalMs;
    this.state.phase='checking';
    this.state.error=this.persistenceError;
    const timer=setTimeout(()=>controller.abort(new Error('检查插件更新超时，请稍后重试。')),CHECK_TIMEOUT);
    timer.unref?.();
    const aborted=new Promise<never>((_,reject)=>controller.signal.addEventListener('abort',()=>reject(controller.signal.reason),{once:true}));
    this.checkFlight=(async()=>{
      try{
        const version=await Promise.race([Promise.resolve().then(()=>{controller.signal.throwIfAborted();return this.options.latest(controller.signal);}),aborted]);
        if(!stable(version))throw new Error('插件版本信息无效，只接受稳定版本 X.Y.Z。');
        this.state.latestVersion=version;
        if(this.queuedVersion!==null)this.queuedVersion=version;
        this.state.lastCheckedAt=this.now();
        this.nextCheckAt=this.state.lastCheckedAt+this.checkIntervalMs;
        if(this.inspect()){
          this.persist(this.preferences());
          this.setRestingPhase();
        }
      }catch(error){
        if(controller.signal.aborted&&controller.signal.reason===STOP_CHECK)this.setRestingPhase();
        else this.fail(message(error,'检查插件更新失败，请稍后重试。'));
      }finally{
        clearTimeout(timer);
        this.checkFlight=null;
        this.checkController=null;
        this.backgroundCheck=false;
      }
      return this.snapshot();
    })();
    return this.checkFlight;
  }

  private queueInstall(version:string):void{
    if(this.installFlight||this.checkFlight||this.state.phase==='installing')return;
    if(!stable(version)||!stable(this.state.currentVersion)){this.fail('插件版本信息无效。');return;}
    if(!this.inspect()){this.queuedVersion=null;return;}
    if(this.needsRestart()){this.queuedVersion=null;this.setRestingPhase();return;}
    if(!this.state.canInstall){this.queuedVersion=null;this.state.phase='unsupported';return;}
    if(!this.isNewer(version)){this.queuedVersion=null;this.setRestingPhase();return;}
    if(this.isBusy()){
      this.queuedVersion=version;
      this.state.phase='waiting';
      this.state.error=this.persistenceError;
      return;
    }
    this.queuedVersion=null;
    this.state.phase='installing';
    this.state.error=this.persistenceError;
    this.failedVersion=null;
    // Publish the lock synchronously; enter the driver only in a later microtask.
    this.installFlight=Promise.resolve().then(()=>this.runInstall(version)).finally(()=>{this.installFlight=null;});
  }

  private async runInstall(version:string):Promise<void>{
    let timer:ReturnType<typeof setTimeout>|undefined;
    const controller=new AbortController();
    try{
      // A recorder can have become busy between accepting the request and this turn.
      if(this.isBusy()){this.queuedVersion=version;this.state.phase='waiting';return;}
      if(!this.inspect())return;
      if(this.needsRestart()||!this.isNewer(version)){this.setRestingPhase();return;}
      if(!this.state.canInstall){this.state.phase='unsupported';return;}
      timer=setTimeout(()=>{
        const error=new Error('插件更新超时，正在等待安装程序结束，请稍后重试。');
        this.state.error=error.message;
        controller.abort(error);
        // Keep phase=installing and the shared lock until the driver actually settles.
      },INSTALL_TIMEOUT);
      timer.unref?.();
      await this.options.install(version,controller.signal);
      controller.signal.throwIfAborted();
      if(!this.inspect())return;
      if(this.state.installedVersion===null||compare(this.state.installedVersion,version)<0)throw new Error('尚未确认新版插件已安装，请稍后重试。');
      this.state.error=this.persistenceError;
      this.state.phase=this.needsRestart()?'restart':this.persistenceError?'error':'idle';
    }catch(error){
      this.failedVersion=version;
      const failure=message(error,'插件更新失败，请稍后重试。');
      this.inspect();
      this.state.error=failure;
      this.state.phase=this.needsRestart()?'restart':'error';
    }finally{if(timer!==undefined)clearTimeout(timer);}
  }

  private inspect():boolean{
    try{
      const installed=this.options.inspect();
      if(installed===null||typeof installed!=='object'||!['npm','archive','development','unknown'].includes(installed.source)||typeof installed.canInstall!=='boolean'||(installed.version!==null&&!stable(installed.version)))throw new Error('已安装插件的版本信息无效。');
      this.state.installedVersion=installed.version;
      this.state.source=installed.source;
      this.state.canInstall=installed.canInstall&&(installed.source==='npm'||installed.source==='archive');
      return true;
    }catch(error){this.fail(message(error,'无法读取插件安装信息。'));return false;}
  }

  private isBusy():boolean{return this.activities>0||this.options.busy();}
  private needsRestart():boolean{return stable(this.state.currentVersion)&&this.state.installedVersion!==null&&compare(this.state.installedVersion,this.state.currentVersion)>0;}
  private isNewer(version:string):boolean{return compare(version,this.state.currentVersion)>0&&(this.state.installedVersion===null||compare(version,this.state.installedVersion)>0);}
  private preferences():UpdatePreferences{return {autoUpdate:this.state.autoUpdate,lastCheckedAt:this.state.lastCheckedAt,latestVersion:this.state.latestVersion};}
  private persist(preferences:UpdatePreferences):boolean{
    try{this.options.save({...preferences});this.persistenceError=null;this.state.error=null;return true;}
    catch(error){this.persistenceError='无法保存插件更新设置：'+message(error,'写入失败。');if(this.state.phase==='installing')this.state.error=this.persistenceError;else this.fail(this.persistenceError);return false;}
  }
  private setRestingPhase():void{
    if(!stable(this.state.currentVersion)){this.fail('当前插件版本信息无效。');return;}
    this.state.error=this.persistenceError;
    const restart=this.needsRestart();
    if(restart||!this.state.canInstall||(this.queuedVersion!==null&&!this.isNewer(this.queuedVersion)))this.queuedVersion=null;
    this.state.phase=restart?'restart':this.persistenceError?'error':!this.state.canInstall?'unsupported':this.queuedVersion!==null?'waiting':this.state.latestVersion!==null&&this.isNewer(this.state.latestVersion)?'available':'idle';
  }
  private fail(error:string):void{this.state.error=error;this.state.phase='error';}
}
