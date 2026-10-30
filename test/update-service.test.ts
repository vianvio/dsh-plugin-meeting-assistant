import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {acquirePluginUpdater} from '../src/voice/update-service.js';
import type {createUpdateDriver} from '../src/voice/update-driver.js';

const ctx={get:()=>undefined} as never;
const turn=()=>new Promise<void>(resolve=>setImmediate(resolve));
function fixture(){
  let installed='0.1.7',finish!:()=>void;const pending=new Promise<void>(resolve=>{finish=resolve;});
  const key='/fixture/'+randomUUID(),calls:string[]=[],signals:AbortSignal[]=[];
  const driver=(label:string):ReturnType<typeof createUpdateDriver>=>({
    key,inspect:()=>({version:installed,source:'npm',canInstall:true}),
    load:()=>({autoUpdate:false}),save(){},latest:async()=>'0.1.8',
    install:async(version,signal)=>{calls.push(label);signals.push(signal);await pending;installed=version;},
  });
  return {driver,calls,signals,finish};
}

test('an updater survives its own replacement without duplicate installs or aborting the native operation',async()=>{
  const f=fixture(),first=acquirePluginUpdater(ctx,'0.1.7',()=>false,{driver:f.driver('first')});
  await first.updater.check();await first.updater.requestInstall();await turn();
  assert.deepEqual(f.calls,['first']);
  const next=acquirePluginUpdater(ctx,'0.1.8',()=>false,{driver:f.driver('next')});
  assert.equal(next.updater,first.updater);first.release();
  await next.updater.requestInstall();assert.deepEqual(f.calls,['first']);assert.equal(f.signals[0].aborted,false);
  f.finish();await turn();await turn();
  assert.equal(next.updater.snapshot().currentVersion,'0.1.8');assert.equal(next.updater.snapshot().phase,'idle');
  next.release();
});

test('in-flight activity reservations survive replacement and block installation until released',async()=>{
  const f=fixture(),first=acquirePluginUpdater(ctx,'0.1.7',()=>false,{driver:f.driver('first')});
  const release=first.updater.reserveActivity();await first.updater.check();await first.updater.requestInstall();
  assert.equal(first.updater.snapshot().phase,'waiting');
  first.release();const next=acquirePluginUpdater(ctx,'0.1.7',()=>false,{driver:f.driver('next')});
  await next.updater.tick();assert.deepEqual(f.calls,[]);
  release();release();await next.updater.tick();await turn();assert.deepEqual(f.calls,['next']);
  f.finish();await turn();next.release();
});

test('different profiles use separate updater state and preferences',()=>{
  const a=fixture(),b=fixture();
  const first=acquirePluginUpdater(ctx,'0.1.7',()=>false,{driver:a.driver('a')});
  const second=acquirePluginUpdater(ctx,'0.1.7',()=>false,{driver:b.driver('b')});
  assert.notEqual(first.updater,second.updater);
  first.updater.setEnabled(true);
  assert.equal(first.updater.snapshot().autoUpdate,true);assert.equal(second.updater.snapshot().autoUpdate,false);
  first.release();second.release();
});
