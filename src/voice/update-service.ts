import type {Context} from '@deepseek-ai/cordis';
import {createUpdateDriver} from './update-driver.js';
import {PluginUpdater} from './updater.js';

type Binding={version:string;busy:()=>boolean};
type Entry={driver:ReturnType<typeof createUpdateDriver>;updater:PluginUpdater;owners:Map<symbol,Binding>};
const shared=globalThis as unknown as {__dshMeetingUpdatersV1?:Map<string,Entry>};
const entries=shared.__dshMeetingUpdatersV1??(shared.__dshMeetingUpdatersV1=new Map());

/** Timers have plugin owners; an in-flight native install can outlive self HMR. */
export function acquirePluginUpdater(ctx:Context,version:string,busy:()=>boolean,options:{driver?:ReturnType<typeof createUpdateDriver>}={}){
  const driver=options.driver??createUpdateDriver(ctx),key=driver.key;
  let entry=key?entries.get(key):undefined;
  if(!entry){
    const owners=new Map<symbol,Binding>();
    let created:Entry|undefined;
    const current=()=>created?.driver??driver;
    const updater=new PluginUpdater({version,inspect:()=>current().inspect(),load:()=>current().load(),save:prefs=>current().save(prefs),latest:signal=>current().latest(signal),install:(target,signal)=>current().install(target,signal),busy:()=>{
      for(const binding of owners.values()){try{if(binding.busy())return true;}catch{return true;}}
      return false;
    }});
    entry=created={driver,updater,owners};if(key)entries.set(key,entry);
  }
  const active=entry,id=Symbol('updater owner');active.driver=driver;
  active.owners.set(id,{version,busy});active.updater.setVersion(version);active.updater.start();
  let released=false;
  return {updater:active.updater,release:()=>{
    if(released)return;released=true;active.owners.delete(id);
    const latest=[...active.owners.values()].at(-1);
    if(latest)active.updater.setVersion(latest.version);else active.updater.stop();
  }};
}
