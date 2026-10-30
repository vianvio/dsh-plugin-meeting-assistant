import assert from 'node:assert/strict';
import test from 'node:test';
import {isNewerPluginVersion} from '../src/voice/update-ui.js';

test('update UI only offers strictly newer stable versions',()=>{
  for(const [candidate,current] of [['0.1.8','0.1.7'],['0.10.0','0.9.99'],['1.0.0','0.99.99'],['10.0.0','9.99.99']]){
    assert.equal(isNewerPluginVersion(candidate,current),true,`${candidate} must upgrade ${current}`);
    assert.equal(isNewerPluginVersion(current,candidate),false,`${current} must not downgrade ${candidate}`);
    assert.equal(isNewerPluginVersion(candidate,candidate),false,'equal versions never indicate updates');
  }
});

test('update UI compares large version components without rounding',()=>{
  assert.equal(isNewerPluginVersion('1.0.9007199254740993','1.0.9007199254740992'),true);
  assert.equal(isNewerPluginVersion('1.9007199254740992.999','1.9007199254740993.0'),false);
  assert.equal(isNewerPluginVersion('999999999999999999999999.0.0','999999999999999999999998.99.99'),true);
});

test('update UI ignores unsupported or malformed version values',()=>{
  for(const version of [null,undefined,'','1.2','v1.2.3','01.2.3','1.02.3','1.2.03','1.2.3-beta.1','1.2.3+build.1','1.2.3.4',' 1.2.3','1.2.3\n',`${'9'.repeat(257)}.0.0`]){
    assert.equal(isNewerPluginVersion(version,'0.0.1'),false,`invalid candidate ${JSON.stringify(version)}`);
    assert.equal(isNewerPluginVersion('99.0.0',version),false,`invalid current ${JSON.stringify(version)}`);
  }
});
