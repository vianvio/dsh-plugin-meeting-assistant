import assert from 'node:assert/strict';
import test,{type TestContext} from 'node:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createUpdateDriver,updateSource,UPDATE_PACKAGE,UPDATE_REGISTRY,type RunUpdate,type UpdateProfile} from '../src/voice/update-driver.js';

function fixture(t:TestContext,spec='^0.1.7'){
  const root=mkdtempSync(join(tmpdir(),'meeting-update-driver-')),dir=join(root,'profile');
  mkdirSync(join(dir,'node_modules',UPDATE_PACKAGE),{recursive:true});
  const manifest={dependencies:{[UPDATE_PACKAGE]:spec,'other-plugin':'1.2.3'},dsh:{profile:{bundles:[UPDATE_PACKAGE,'other-plugin']}}};
  writeFileSync(join(dir,'package.json'),JSON.stringify(manifest));
  const installed=join(dir,'node_modules',UPDATE_PACKAGE,'package.json');
  writeFileSync(installed,JSON.stringify({name:UPDATE_PACKAGE,version:'0.1.7'}));
  const profile:UpdateProfile={profile:'test',dir,installAnchor:join(root,'runtime.json'),packageManager:{command:'bundled-node',args:['bundled-pnpm.mjs'],env:{FIXTURE:'1'}}};
  const ctx={get:(name:string)=>name==='profileContext'?profile:name==='pluginManager'?{listBundles(){}}:undefined} as never;
  t.after(()=>{assert.ok(root.startsWith(join(tmpdir(),'meeting-update-driver-')));rmSync(root,{recursive:true,force:true});});
  return {root,dir,profile,ctx,manifest,installed,setVersion(version:string){writeFileSync(installed,JSON.stringify({name:UPDATE_PACKAGE,version}));}};
}

test('distinguishes npm/archive installations from local development sources',()=>{
  for(const spec of ['^0.1.7','0.1.7','~1.2.0','latest','>=1.0.0 <2.0.0'])assert.equal(updateSource(spec),'npm',spec);
  for(const spec of ['file:/tmp/meeting-0.1.7.tgz','/tmp/meeting.tgz','https://example.invalid/meeting.tgz'])assert.equal(updateSource(spec),'archive',spec);
  for(const spec of ['link:/tmp/repo','file:/tmp/repo','workspace:*','github:user/repo','git+https://example.invalid/repo.git','https://example.invalid/repo','../repo'])assert.equal(updateSource(spec),'development',spec);
  for(const spec of [undefined,'','npm:some-other-package@latest','unrecognized'])assert.equal(updateSource(spec),'unknown');
});

test('reads the owning profile and stores only update preferences with private permissions',t=>{
  const f=fixture(t),driver=createUpdateDriver(f.ctx);
  assert.equal(driver.key,f.dir);assert.deepEqual(driver.inspect(),{version:'0.1.7',source:'npm',canInstall:true});
  assert.deepEqual(driver.load(),{});
  driver.save({autoUpdate:false,lastCheckedAt:123,latestVersion:'0.1.8'});
  assert.deepEqual(driver.load(),{autoUpdate:false,lastCheckedAt:123,latestVersion:'0.1.8'});
  assert.equal(statSync(join(f.dir,'.meeting-assistant-updates.json')).mode&0o777,0o600);
  assert.deepEqual(JSON.parse(readFileSync(join(f.dir,'package.json'),'utf8')),f.manifest);
});

test('without the optional platform capability installation remains disabled',t=>{
  const f=fixture(t);
  const ctx={get:(name:string)=>name==='profileContext'?f.profile:undefined} as never;
  assert.equal(createUpdateDriver(ctx).inspect().canInstall,false);
  const absent=createUpdateDriver({get:()=>undefined} as never);
  assert.deepEqual(absent.inspect(),{version:null,source:'unknown',canInstall:false});
  assert.throws(()=>absent.save({autoUpdate:true}),/未提供/);
});

test('checks only the fixed official stable package and validates registry metadata',async t=>{
  const f=fixture(t),requests:any[]=[];
  const driver=createUpdateDriver(f.ctx,{fetch:async(url,options)=>{requests.push({url,options});return Response.json({name:UPDATE_PACKAGE,version:'0.1.8',dsh:{bundle:{patch:'./cordis.patch.yml'}}});}});
  const controller=new AbortController();
  assert.equal(await driver.latest(controller.signal),'0.1.8');
  assert.equal(requests[0].url,UPDATE_REGISTRY+UPDATE_PACKAGE+'/latest');
  assert.equal(requests[0].options.redirect,'error');assert.equal(requests[0].options.signal,controller.signal);
  for(const metadata of [{name:'other',version:'0.1.8',dsh:{bundle:{}}},{name:UPDATE_PACKAGE,version:'0.1.8-beta',dsh:{bundle:{}}},{name:UPDATE_PACKAGE,version:'0.1.8'}]){
    const bad=createUpdateDriver(f.ctx,{fetch:async()=>Response.json(metadata)});
    await assert.rejects(bad.latest(controller.signal),/稳定版/);
  }
  const unavailable=createUpdateDriver(f.ctx,{fetch:async()=>new Response('',{status:503})});
  await assert.rejects(unavailable.latest(controller.signal),/暂时无法/);
});

test('installs one exact package through the native locked API and verifies installed bytes metadata',async t=>{
  const f=fixture(t),calls:any[]=[];
  const run:RunUpdate=async(profile,args,options)=>{calls.push({profile,args,options});f.setVersion('0.1.8');return {exitCode:0};};
  const driver=createUpdateDriver(f.ctx,{run}),signal=new AbortController().signal;
  await driver.install('0.1.8',signal);
  assert.equal(calls.length,1);
  assert.deepEqual(calls[0].args,['add',UPDATE_PACKAGE+'@0.1.8','--save-exact','--registry='+UPDATE_REGISTRY]);
  assert.equal(calls[0].profile.dir,f.dir);assert.equal(calls[0].profile.cwd,f.dir);
  assert.equal(calls[0].options.execution,'service');assert.equal(calls[0].options.command,'bundled-node');
  assert.deepEqual(calls[0].options.args,['bundled-pnpm.mjs']);assert.equal(calls[0].options.signal,signal);
  assert.deepEqual(JSON.parse(readFileSync(join(f.dir,'package.json'),'utf8')),f.manifest);
});

test('development sources and invalid version arguments cannot invoke package operations',async t=>{
  const f=fixture(t,'link:/tmp/source');let calls=0;
  const driver=createUpdateDriver(f.ctx,{run:async()=>{calls++;return {exitCode:0};}});
  await assert.rejects(driver.install('0.1.8',new AbortController().signal),/安装方式/);
  assert.equal(calls,0);
  const normal=fixture(t),standard=createUpdateDriver(normal.ctx,{run:async()=>{calls++;return {exitCode:0};}});
  for(const version of ['latest','0.1.8 --other','../anything','0.1.8-beta','9.9.9\n']){
    await assert.rejects(standard.install(version,new AbortController().signal),/版本无效/);
  }
  assert.equal(calls,0);
});

test('native rejection and an unconfirmed installation never report success',async t=>{
  const f=fixture(t),signal=new AbortController().signal;
  for(const [result,pattern] of [[{exitCode:1},/更新失败/],[{exitCode:0,timedOut:true},/更新失败/],[{exitCode:1,incompatible:[{}]},/不兼容/],[{exitCode:0},/尚未确认/]] as const){
    const driver=createUpdateDriver(f.ctx,{run:async()=>result as any});
    await assert.rejects(driver.install('0.1.8',signal),pattern);
  }
});


test('a plugin manager that becomes available after startup enables the existing driver',t=>{
  const f=fixture(t);let available=false;
  const ctx={get:(name:string)=>name==='profileContext'?f.profile:name==='pluginManager'&&available?{listBundles(){}}:undefined} as never;
  const driver=createUpdateDriver(ctx);assert.equal(driver.inspect().canInstall,false);
  available=true;assert.equal(driver.inspect().canInstall,true);
});


test('normalizes the public profileContext.name used by DSH Desktop into the native command context',async t=>{
  const f=fixture(t);let observed:any;
  const profile={...f.profile,name:'desktop',profile:undefined};
  const driver=createUpdateDriver(f.ctx,{profile,run:async(context)=>{observed=context;f.setVersion('0.1.8');return {exitCode:0};}});
  assert.equal(driver.inspect().canInstall,true);
  await driver.install('0.1.8',new AbortController().signal);
  assert.equal(observed.profile,'desktop');assert.equal(observed.dir,f.dir);
});
