import assert from 'node:assert/strict';
import test,{type TestContext} from 'node:test';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {installVoice} from '../src/voice/host.js';
import {PluginUpdater} from '../src/voice/updater.js';

function deferred<T=void>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(yes=>{resolve=yes;});return {promise,resolve};}
const turn=()=>new Promise<void>(resolve=>setImmediate(resolve));
function fixture(t:TestContext,stream?:()=>any){
  const root=mkdtempSync(join(tmpdir(),'meeting-update-routes-')),voice=join(root,'voice'),project=join(root,'project');mkdirSync(project);
  const old=process.env.MESH_VOICE_HOME;process.env.MESH_VOICE_HOME=voice;
  const cleanups:Array<()=>unknown>=[],install=deferred(),versions:string[]=[];let installed='0.1.7';
  const updater=new PluginUpdater({version:'0.1.7',inspect:()=>({version:installed,source:'npm',canInstall:true}),latest:async()=>'0.1.8',
    install:async(version)=>{versions.push(version);await install.promise;installed=version;},busy:()=>false,
    load:()=>({autoUpdate:false,lastCheckedAt:1,latestVersion:'0.1.8'}),save(){}});
  let dispatch!:(endpoint:string,payload:unknown)=>Promise<any>;
  const ctx={tools:{register(){}},on(){},logger:{warn(){},error(){}},
    get:(key:string)=>key==='sessionController'?{projections:async()=>({kind:'sequenced',values:{modelSelection:{next:{provider:'fixture',model:'fixture'},lastUsed:null}}})}:undefined,
    llm:{stream:()=>{assert.ok(stream,'unexpected model request');return stream!();}},
    effect(fn:()=>unknown){const value=fn();if(typeof value==='function')cleanups.push(value as ()=>unknown);return value;},
    connection:{rpc:{handle(_channel:string,handler:typeof dispatch){dispatch=handler;return ()=>{};}}},
  };
  installVoice(ctx as never,{updater});
  t.after(async()=>{install.resolve();updater.stop();for(const fn of cleanups.reverse())await fn();if(old===undefined)delete process.env.MESH_VOICE_HOME;else process.env.MESH_VOICE_HOME=old;await turn();assert.ok(root.startsWith(join(tmpdir(),'meeting-update-routes-')));rmSync(root,{recursive:true,force:true});});
  return {root,voice,project,updater,dispatch,install,versions};
}

test('update RPCs are profile scoped, validate settings and accept only the fixed checked target',async t=>{
  const f=fixture(t);
  assert.equal((await f.dispatch('update/status',{})).value.currentVersion,'0.1.7');
  assert.equal((await f.dispatch('update/settings',{enabled:'true'})).ok,false);
  assert.equal((await f.dispatch('update/settings',{enabled:false})).value.autoUpdate,false);
  const accepted=await f.dispatch('update/install',{version:'999.0.0',package:'other-package',registry:'https://example.invalid/'});
  assert.equal(accepted.ok,true);assert.equal(accepted.value.phase,'installing');
  await turn();assert.deepEqual(f.versions,['0.1.8']);
  f.install.resolve();await turn();await turn();
  assert.equal((await f.dispatch('update/status',{})).value.phase,'restart');
  await f.dispatch('update/install',{});assert.equal(f.versions.length,1);
});

test('installation blocks new recording and AI work while status and stop remain available',async t=>{
  const f=fixture(t);await f.dispatch('update/install',{});
  for(const [endpoint,payload] of [
    ['start',{sessionId:'session-a'}],
    ['coach/generate',{sessionId:'session-a',recordingId:'not-started'}],
    ['brief/polish',{sessionId:'session-a',cwd:f.project,invitation:'review',goal:'goal'}],
  ] as const){
    const result=await f.dispatch(endpoint,payload);assert.equal(result.ok,false);assert.match(result.error.message,/插件正在更新/);
  }
  const status=await f.dispatch('status',{sessionId:'session-a'});
  assert.equal(status.ok,true);assert.equal(status.value.updates.phase,'installing');assert.equal(status.value.active,null);
  assert.equal((await f.dispatch('stop',{})).ok,true);
});

test('goal polishing reserves activity so updates wait until the in-flight model finishes',async t=>{
  const started=deferred(),finish=deferred();
  const result={options:[{id:'one',label:'明确目标',text:'确认接口和验收标准。'},{id:'two',label:'核对风险',text:'讨论方案风险和待验证问题。'}]};
  const f=fixture(t,()=>({async *[Symbol.asyncIterator](){started.resolve();await finish.promise;yield {type:'text-delta',text:JSON.stringify(result)};yield {type:'finish',reason:{kind:'stop'}};}}));
  const polishing=f.dispatch('brief/polish',{sessionId:'session-a',cwd:f.project,invitation:'review',goal:'goal'});
  await started.promise;
  assert.equal((await f.dispatch('update/install',{})).value.phase,'waiting');
  await f.updater.tick();assert.deepEqual(f.versions,[]);
  finish.resolve();assert.equal((await polishing).ok,true);
  await f.updater.tick();await turn();assert.deepEqual(f.versions,['0.1.8']);
});
