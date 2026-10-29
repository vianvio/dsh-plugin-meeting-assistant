/**
 * 宿主半产物：按 `main` / `exports` 声明的入口 import 一次，看它到底导出了什么。
 *
 * 宿主那一半在 DSH 里是 ESM 一次导入的模块，`inject` 是加载门槛、`apply` 是唯一入口、
 * `hostBuild()` 回答"加载的是哪一份"。这三样少任何一个，症状都不是"报错"而是"这个插件没上线"
 * ——所以对着**产物**核一遍，而不是只看源码。
 *
 * 放在子进程里跑：入口的模块级语句会往 stderr 打构建标记，也会挂一个 unref 过的 20 秒看门狗；
 * 让它们留在子进程里，不污染本进程的日志断言（`meeting-host-isolation.test.ts` 判的就是那一份）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {root} from './helpers.js';

test('宿主产物导出 name / inject / apply / hostBuild', () => {
  const code = `
    const mod = await import('./lib/index.js');
    console.log('SHAPE=' + JSON.stringify({
      name: mod.name,
      inject: mod.inject,
      apply: typeof mod.apply,
      hostBuild: typeof mod.hostBuild,
      exports: Object.keys(mod).sort(),
    }));
  `;
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    // 入口只写日志、不碰磁盘；万一以后碰了，也不许落到本机那份诊断目录里。
    env: {...process.env, MESH_DIAG_DIR: join(root, '.local', 'diag-host-bundle')},
  });
  const line = output.split('\n').find((candidate) => candidate.startsWith('SHAPE='));
  assert.ok(line, `子进程没有输出产物形状：${output.slice(-500)}`);
  const shape = JSON.parse(line.slice('SHAPE='.length)) as {name: string; inject: string[]; apply: string; hostBuild: string; exports: string[]};
  assert.equal(shape.name, 'meeting-assistant');
  assert.deepEqual(shape.inject, ['tools', 'connection', 'webServer', 'llm']);
  assert.equal(shape.apply, 'function');
  assert.equal(shape.hostBuild, 'function');
  for (const key of ['diag', 'hostBuild', 'inject', 'name']) assert.ok(shape.exports.includes(key), `产物少了导出 ${key}（实际：${shape.exports.join(', ')}）`);
});

test('产物里的版本号来自 package.json，不是写死的字符串', () => {
  // 以前版本号在三个地方各写一份（宿主常量、客户端报告头、诊断报告），于是"包是 0.1.x、报告里
  // 写着另一个版本"一定会发生。现在只有 `package.json` 一处真源，构建时用 define 注入。
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {version: string};
  const host = readFileSync(join(root, 'lib', 'index.js'), 'utf8');
  assert.ok(host.includes(`"${manifest.version}"`), `宿主产物里没有 ${manifest.version}——构建时 __PLUGIN_VERSION__ 没注入`);
});
