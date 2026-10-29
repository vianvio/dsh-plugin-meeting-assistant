/**
 * 会议助手的**宿主半**必须能单独 import：不执行插件入口的模块级语句、也不往共享诊断日志里
 * 写假故障。
 *
 * 入口原先被宿主半反向 import（`voice/host.ts` 取那里的一份共享 `diag`），于是两个后果：
 *
 * * 入口的模块级语句被执行（"宿主半模块已加载"那一条）；
 * * 入口挂的 20 秒看门狗（"apply 还没跑 = inject 没满足"）也被挂上，什么都不做等 20 秒就会往
 *   共享日志里补一条 `level:error`。那份日志会被导出成操作者看的诊断报告，报告里于是多出一条
 *   不存在的 inject 故障——排查的人照着它去追一个没有发生的加载失败。
 *
 * 所以判据是"只 import 宿主半，日志里一条都不能多"，而且这条判据要在**子进程**里量：本进程
 * 早就把入口加载过了，模块级语句不会跑第二遍。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {execFileSync} from 'node:child_process';
import {root} from './helpers.js';

test('只 import 宿主半：不执行插件入口，也不写一条日志', () => {
  const code = `
    const {sharedLog} = await import('./src/shared/diag.ts');
    await import('./src/voice/host.ts');
    const entries = sharedLog('meeting-assistant-host').list().map(entry => ({level: entry.level, message: entry.message}));
    console.log('ENTRIES=' + JSON.stringify(entries));
  `;
  const output = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    // 宿主半 import 时不该碰磁盘；真碰了也不许碰本机那份诊断目录。
    env: {...process.env, MESH_DIAG_DIR: `${root}/.local/diag-isolation`},
  });
  const line = output.split('\n').find((candidate) => candidate.startsWith('ENTRIES='));
  assert.ok(line, `子进程没有输出日志快照：${output.slice(-500)}`);
  const entries = JSON.parse(line.slice('ENTRIES='.length)) as Array<{level: string; message: string}>;
  assert.deepEqual(entries, [], `只 import 宿主半不该产生任何日志（入口的模块级语句被执行了）：${JSON.stringify(entries)}`);
});
