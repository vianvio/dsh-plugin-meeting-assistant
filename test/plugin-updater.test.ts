import assert from 'node:assert/strict';
import test from 'node:test';
import {PluginUpdater,type PluginUpdaterOptions,type PluginInstallation,type UpdatePreferences} from '../src/voice/updater.js';

function deferred<T>(){
  let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;
  const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});
  return {promise,resolve,reject};
}
async function settle(){for(let i=0;i<16;i++)await Promise.resolve();}
function fixture(overrides:Partial<PluginUpdaterOptions>={}){
  const control={time:1_000,busy:false,installed:{version:'1.0.0',source:'npm',canInstall:true} as PluginInstallation,latest:'1.1.0',preferences:{} as Partial<UpdatePreferences>,saveError:null as Error|null};
  const calls={latest:[] as AbortSignal[],install:[] as Array<{version:string;signal:AbortSignal}>,saved:[] as UpdatePreferences[]};
  const updater=new PluginUpdater({
    version:'1.0.0',inspect:()=>({...control.installed}),busy:()=>control.busy,
    now:()=>control.time,load:()=>control.preferences,
    save:preferences=>{if(control.saveError)throw control.saveError;calls.saved.push({...preferences});control.preferences={...preferences};},
    latest:async signal=>{calls.latest.push(signal);return control.latest;},
    install:async(version,signal)=>{calls.install.push({version,signal});control.installed.version=version;},
    ...overrides,
  });
  return {updater,control,calls};
}

test('construction is offline, defaults enabled and snapshots cannot mutate updater state',()=>{
  const {updater,calls}=fixture();
  assert.equal(updater.snapshot().autoUpdate,true);assert.equal(updater.snapshot().phase,'idle');
  assert.equal(calls.latest.length,0);assert.equal(calls.install.length,0);
  const status=updater.snapshot();status.autoUpdate=false;assert.equal(updater.snapshot().autoUpdate,true);
});

test('manual request checks once, queues while busy, then installs at the first idle tick',async()=>{
  const {updater,control,calls}=fixture();control.busy=true;
  assert.equal((await updater.requestInstall()).phase,'waiting');assert.equal(calls.latest.length,1);assert.equal(calls.install.length,0);
  await updater.tick();assert.equal(calls.install.length,0);
  control.busy=false;await updater.tick();await settle();
  assert.equal(calls.install.length,1);assert.equal(calls.install[0].version,'1.1.0');assert.equal(updater.snapshot().phase,'restart');
});

test('request accepts installation immediately, publishes installing synchronously and shares installer',async()=>{
  const gate=deferred<void>();let installs=0;
  const {updater,control}=fixture({install:async()=>{installs++;await gate.promise;control.installed.version='1.1.0';}});
  await updater.check();const first=updater.requestInstall();assert.equal(updater.snapshot().phase,'installing');
  assert.throws(()=>updater.reserveActivity(),/插件正在更新，请稍后重试。/);
  const second=updater.requestInstall();
  assert.equal((await first).phase,'installing');assert.equal((await second).phase,'installing');assert.equal(installs,1);
  assert.equal((await updater.check()).phase,'installing');await updater.tick();assert.equal(installs,1);
  gate.resolve();await settle();assert.equal(updater.snapshot().phase,'restart');
});

test('concurrent check and requests share one latest request and one queued installation',async()=>{
  const gate=deferred<string>();let checks=0;
  const {updater,control,calls}=fixture({latest:async()=>{checks++;return gate.promise;}});control.busy=true;
  const check=updater.check(),duplicate=updater.check();assert.equal(check,duplicate);
  const first=updater.requestInstall(),second=updater.requestInstall();assert.equal(first,second);
  await settle();assert.equal(checks,1);gate.resolve('1.1.0');await Promise.all([check,first,second]);
  assert.equal(updater.snapshot().phase,'waiting');control.busy=false;await updater.tick();await settle();assert.equal(calls.install.length,1);
});

test('a cached version cannot start installation while a fresh check is in flight',async()=>{
  const gate=deferred<string>();let checks=0;
  const {updater,calls}=fixture({latest:async()=>++checks===1?'1.1.0':gate.promise});await updater.check();
  const check=updater.check(),request=updater.requestInstall();await settle();
  assert.equal(updater.snapshot().phase,'checking');assert.equal(calls.install.length,0);
  gate.resolve('1.2.0');await Promise.all([check,request]);await settle();assert.deepEqual(calls.install.map(row=>row.version),['1.2.0']);
});

test('busy is rechecked after synchronous installing flag and before the driver runs',async()=>{
  let probes=0;const {updater,calls}=fixture({busy:()=>++probes===2});await updater.check();
  const accepted=updater.requestInstall();assert.equal(updater.snapshot().phase,'installing');await accepted;await settle();
  assert.equal(updater.snapshot().phase,'waiting');assert.equal(calls.install.length,0);await updater.tick();await settle();assert.equal(calls.install.length,1);
});

test('disabling cancels manual waiting; disabled ticks are offline and explicit actions still work',async()=>{
  const {updater,control,calls}=fixture();control.busy=true;await updater.requestInstall();assert.equal(updater.snapshot().phase,'waiting');
  assert.equal(updater.setEnabled(false).autoUpdate,false);assert.notEqual(updater.snapshot().phase,'waiting');
  control.busy=false;control.time+=2*24*60*60*1000;await updater.tick();assert.equal(calls.install.length,0);assert.equal(calls.latest.length,1);
  await updater.check();assert.equal(calls.latest.length,2);await updater.requestInstall();await settle();assert.equal(calls.install.length,1);
});

test('an explicit request while disabled can wait for active work to finish',async()=>{
  const {updater,control,calls}=fixture();updater.setEnabled(false);control.busy=true;
  await updater.requestInstall();assert.equal(updater.snapshot().phase,'waiting');control.busy=false;await updater.tick();await settle();assert.equal(calls.install.length,1);
});

test('disabling a manual request during its check prevents later queueing',async()=>{
  const gate=deferred<string>();const {updater,calls}=fixture({latest:()=>gate.promise});
  const request=updater.requestInstall();updater.setEnabled(false);gate.resolve('1.1.0');await request;await settle();
  assert.equal(calls.install.length,0);assert.notEqual(updater.snapshot().phase,'waiting');
});

test('development and unknown sources can check but are never overwritten',async()=>{
  for(const source of ['development','unknown'] as const){
    const {updater,control,calls}=fixture({inspect:()=>({version:'1.0.0',source,canInstall:true})});assert.equal(updater.snapshot().canInstall,false);
    await updater.check();await updater.requestInstall();control.time+=24*60*60*1000;await updater.tick();await settle();
    assert.equal(calls.install.length,0);assert.equal(updater.snapshot().phase,'unsupported');assert.ok(calls.latest.length>=1);
  }
});

test('archive installation is eligible for updates',async()=>{
  const {updater,control,calls}=fixture();control.installed.source='archive';await updater.requestInstall();await settle();assert.equal(calls.install.length,1);
});

test('runtime or disk at latest or newer prevents reinstall and downgrade, with numeric comparison',async()=>{
  for(const [runtime,disk,latest] of [['1.0.0','1.0.0','1.0.0'],['2.0.0','2.0.0','1.99.0'],['1.10.0','1.10.0','1.9.0'],['1.0.0','1.2.0','1.1.0']]){
    const {updater,control,calls}=fixture({version:runtime,inspect:()=>({version:disk,source:'npm',canInstall:true})});control.latest=latest;
    await updater.check();await updater.requestInstall();await updater.tick();await settle();assert.equal(calls.install.length,0,`${runtime}/${disk}/${latest}`);
  }
});

test('only stable semver metadata is accepted and malformed installed metadata is visible',async()=>{
  for(const latest of ['v1.1.0','1.1.0-rc.1','1.1.0+build','01.1.0','1.1','latest','',null,{}]){
    const {updater,calls}=fixture({latest:async()=>latest as string});assert.equal((await updater.check()).phase,'error');assert.match(updater.snapshot().error!,/版本/);
    await updater.requestInstall();await settle();assert.equal(calls.install.length,0);
  }
  const {updater}=fixture({inspect:()=>({version:'broken',source:'npm',canInstall:true})});assert.equal(updater.snapshot().phase,'error');assert.match(updater.snapshot().error!,/版本/);
});

test('failed install remains visible without poll retries; manual retry can succeed',async()=>{
  let attempts=0;const {updater,control}=fixture({install:async version=>{if(++attempts===1)throw new Error('native install failed');control.installed.version=version;}});
  await updater.requestInstall();await settle();assert.equal(updater.snapshot().phase,'error');assert.match(updater.snapshot().error!,/native install failed/);
  for(let i=0;i<5;i++){control.time+=30_000;await updater.tick();}assert.equal(attempts,1);assert.equal(updater.snapshot().phase,'error');
  await updater.requestInstall();await settle();assert.equal(attempts,2);assert.equal(updater.snapshot().phase,'restart');
});

test('failed background metadata check is throttled and manual check retries immediately',async()=>{
  let attempts=0;const {updater,control}=fixture({latest:async()=>{if(++attempts===1)throw new Error('registry offline');return '1.1.0';}});
  await updater.tick();assert.equal(updater.snapshot().phase,'error');for(let i=0;i<5;i++){control.time+=30_000;await updater.tick();}
  assert.equal(attempts,1);await updater.check();assert.equal(attempts,2);assert.equal(updater.snapshot().phase,'available');
});

test('installed newer version requires restart and hot reload clears it without another installer',async()=>{
  const {updater,control,calls}=fixture();await updater.requestInstall();await settle();assert.equal(updater.snapshot().phase,'restart');
  for(let i=0;i<3;i++){await updater.requestInstall();await updater.tick();}assert.equal(calls.install.length,1);
  updater.setVersion('1.1.0');assert.equal(updater.snapshot().currentVersion,'1.1.0');assert.equal(updater.snapshot().phase,'idle');
  control.latest='1.2.0';await updater.check();assert.equal(updater.snapshot().phase,'available');
});

test('pre-existing pending restart is detected without installation or a registry call',async()=>{
  const {updater,calls}=fixture({inspect:()=>({version:'1.3.0',source:'npm',canInstall:true})});assert.equal(updater.snapshot().phase,'restart');await updater.requestInstall();
  assert.equal(calls.latest.length,0);assert.equal(calls.install.length,0);updater.setVersion('1.3.0');assert.equal(updater.snapshot().phase,'idle');
});

test('activity tokens queue updates until all tokens are released, and release is idempotent',async()=>{
  const {updater,calls}=fixture();const first=updater.reserveActivity(),second=updater.reserveActivity();await updater.requestInstall();assert.equal(updater.snapshot().phase,'waiting');
  first();first();await updater.tick();assert.equal(calls.install.length,0);second();await updater.tick();await settle();assert.equal(calls.install.length,1);
});

test('only nonsecret preferences persist and failed setting saves are visible without changing the toggle',async()=>{
  const {updater,control,calls}=fixture();await updater.check();assert.deepEqual(calls.saved.at(-1),{autoUpdate:true,lastCheckedAt:1_000,latestVersion:'1.1.0'});
  control.saveError=new Error('disk full');const status=updater.setEnabled(false);assert.equal(status.autoUpdate,true);assert.equal(status.phase,'error');assert.match(status.error!,/无法保存.*disk full/);
  await updater.tick();assert.equal(calls.install.length,0);control.saveError=null;assert.equal(updater.setEnabled(false).autoUpdate,false);assert.equal(updater.snapshot().error,null);
});

test('check persistence errors and load errors stay visible and prevent unattended updates',async()=>{
  const {updater,control,calls}=fixture();control.saveError=new Error('readonly');assert.equal((await updater.check()).phase,'error');await updater.tick();assert.equal(calls.install.length,0);
  const broken=fixture({load:()=>{throw new Error('cannot read preferences');}});assert.equal(broken.updater.snapshot().phase,'error');await broken.updater.tick();assert.equal(broken.calls.latest.length,0);
  assert.equal(broken.updater.setEnabled(false).autoUpdate,false);assert.equal(broken.updater.snapshot().error,null);
});

test('persisted daily schedule is respected and automatic checking/installing occurs once due',async()=>{
  let clock=1_000;const {updater,calls}=fixture({now:()=>clock,load:()=>({autoUpdate:true,lastCheckedAt:1_000,latestVersion:'1.0.0'})});
  await updater.tick();assert.equal(calls.latest.length,0);clock+=24*60*60*1000-1;await updater.tick();assert.equal(calls.latest.length,0);
  clock++;await updater.tick();await settle();assert.equal(calls.latest.length,1);assert.equal(calls.install.length,1);
});

test('start delays first check, polls busy transitions, is idempotent, and stop removes scheduling',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const {updater,control,calls}=fixture();control.busy=true;
  updater.start();updater.start();t.mock.timers.tick(29_999);await settle();assert.equal(calls.latest.length,0);
  t.mock.timers.tick(1);await settle();assert.equal(calls.latest.length,1);assert.equal(updater.snapshot().phase,'waiting');
  control.busy=false;t.mock.timers.tick(29_999);await settle();assert.equal(calls.install.length,0);t.mock.timers.tick(1);await settle();assert.equal(calls.install.length,1);
  updater.stop();control.time+=48*60*60*1000;t.mock.timers.tick(120_000);await settle();assert.equal(calls.latest.length,1);
});

test('stop before initial delay and restart use a fresh initial delay',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const {updater,calls}=fixture();updater.start();t.mock.timers.tick(15_000);updater.stop();
  t.mock.timers.tick(60_000);await settle();assert.equal(calls.latest.length,0);updater.start();t.mock.timers.tick(29_999);await settle();assert.equal(calls.latest.length,0);
  t.mock.timers.tick(1);await settle();assert.equal(calls.latest.length,1);updater.stop();
});

test('stop aborts background latest request without scheduling installation or exposing a failure',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const gate=deferred<string>();let signal:AbortSignal|undefined;
  const {updater,calls}=fixture({latest:async value=>{signal=value;return gate.promise;}});updater.start();t.mock.timers.tick(30_000);await settle();assert.equal(updater.snapshot().phase,'checking');
  updater.stop();assert.equal(signal!.aborted,true);await settle();assert.notEqual(updater.snapshot().phase,'error');gate.resolve('1.1.0');await settle();assert.equal(calls.install.length,0);assert.equal(updater.snapshot().latestVersion,null);
});

test('stop preserves manual shared check and never aborts an accepted install',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const latest=deferred<string>(),installed=deferred<void>();let checkSignal:AbortSignal|undefined,installSignal:AbortSignal|undefined;
  const {updater,control}=fixture({latest:async signal=>{checkSignal=signal;return latest.promise;},install:async(version,signal)=>{installSignal=signal;await installed.promise;control.installed.version=version;}});
  updater.start();t.mock.timers.tick(30_000);await settle();const manual=updater.check();updater.stop();assert.equal(checkSignal!.aborted,false);latest.resolve('1.1.0');await manual;
  await updater.requestInstall();await settle();updater.stop();assert.equal(installSignal!.aborted,false);assert.equal(updater.snapshot().phase,'installing');installed.resolve();await settle();assert.equal(updater.snapshot().phase,'restart');
});

test('latest requests have a ten-second deadline even when the registry ignores abort',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const gate=deferred<string>();let signal:AbortSignal|undefined;
  const {updater}=fixture({latest:async value=>{signal=value;return gate.promise;}});const check=updater.check();await settle();t.mock.timers.tick(9_999);assert.equal(signal!.aborted,false);
  t.mock.timers.tick(1);assert.equal((await check).phase,'error');assert.equal(signal!.aborted,true);assert.match(updater.snapshot().error!,/超时/);gate.resolve('8.0.0');await settle();assert.equal(updater.snapshot().latestVersion,null);
});

test('installer deadline aborts signal but retains installing lock until the driver has stopped',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const gate=deferred<void>();let signal:AbortSignal|undefined,attempts=0;
  const {updater,control}=fixture({install:async(version,value)=>{attempts++;signal=value;if(attempts===1)await gate.promise;else control.installed.version=version;}});
  await updater.requestInstall();await settle();t.mock.timers.tick(179_999);assert.equal(signal!.aborted,false);t.mock.timers.tick(1);assert.equal(signal!.aborted,true);assert.equal(updater.snapshot().phase,'installing');assert.match(updater.snapshot().error!,/超时/);
  await updater.requestInstall();await updater.tick();assert.equal(attempts,1);assert.throws(()=>updater.reserveActivity(),/正在更新/);updater.stop();assert.equal(updater.snapshot().phase,'installing');
  gate.resolve();await settle();assert.equal(updater.snapshot().phase,'error');await updater.requestInstall();await settle();assert.equal(attempts,2);assert.equal(updater.snapshot().phase,'restart');
});

test('driver exceptions, inspect errors and a false success are contained in update status',async()=>{
  const failed=fixture({busy:()=>{throw new Error('busy unavailable');}});assert.equal((await failed.updater.requestInstall()).phase,'error');
  const inspect=fixture({inspect:()=>{throw new Error('manifest unavailable');}});assert.equal(inspect.updater.snapshot().phase,'error');await inspect.updater.tick();assert.equal(inspect.calls.install.length,0);
  const success=fixture({install:async()=>{}});await success.updater.requestInstall();await settle();assert.equal(success.updater.snapshot().phase,'error');assert.match(success.updater.snapshot().error!,/尚未确认/);
});

test('checking a waiting request retains waiting phase and refreshes the queued target',async()=>{
  const {updater,control,calls}=fixture();control.busy=true;await updater.requestInstall();control.latest='1.2.0';await updater.check();
  assert.equal(updater.snapshot().phase,'waiting');control.busy=false;await updater.tick();await settle();assert.deepEqual(calls.install.map(row=>row.version),['1.2.0']);
});

test('daily checks refresh a long-waiting queue and network failures remain visible without polling retries',async()=>{
  let attempts=0;
  const {updater,control,calls}=fixture({latest:async()=>{if(++attempts===2)throw new Error('offline');return attempts===1?'1.1.0':'1.2.0';}});
  control.busy=true;await updater.requestInstall();control.time+=24*60*60*1000;await updater.tick();
  assert.equal(attempts,2);assert.equal(updater.snapshot().phase,'error');
  control.busy=false;for(let i=0;i<3;i++)await updater.tick();assert.equal(attempts,2);assert.equal(calls.install.length,0);
  await updater.check();assert.equal(updater.snapshot().phase,'waiting');await updater.tick();await settle();
  assert.deepEqual(calls.install.map(row=>row.version),['1.2.0']);
});

test('hot reload and disable cannot unlock an in-flight driver; loaded version determines final phase',async()=>{
  const gate=deferred<void>();let signal:AbortSignal|undefined;
  const {updater,control}=fixture({install:async(version,value)=>{signal=value;await gate.promise;control.installed.version=version;}});await updater.requestInstall();await settle();
  updater.setVersion('invalid');assert.equal(updater.snapshot().phase,'installing');assert.throws(()=>updater.reserveActivity(),/正在更新/);
  updater.setVersion('1.1.0');updater.setEnabled(false);assert.equal(updater.snapshot().phase,'installing');assert.equal(signal!.aborted,false);
  gate.resolve();await settle();assert.equal(updater.snapshot().phase,'idle');assert.equal(updater.snapshot().currentVersion,'1.1.0');
});
