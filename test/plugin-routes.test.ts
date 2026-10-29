/**
 * 会议助手走自己那条通道（`/meeting-assistant`），并且**不认调用方给的路径**。
 *
 * 两件事都由这个包自己证明，因为它现在是独立仓库：以前"会议不注册 mesh 的通道"这条是看在两个
 * 包同时在场时才成立的，拆开之后没人替它验证——而通道名撞了/漏了，界面上只表现为"面板打不开"。
 *
 * 最容易出错的性质放在最后：**恢复出来的会话在 Agent 还没回到内存时也要能读状态**（否则 DSH 重启
 * 后打开旧会话，会议面板是一块空白），而调用方给的任何路径一律不认（它只接受 sessionId）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {apply} from '../src/index.js';

type Dispatch = (endpoint: string, payload: unknown) => Promise<any>;

test('注册自己那条 RPC 通道，并且不认调用方给的路径', async () => {
  // 真目录真落盘：`apply()` 会碰配置与诊断文件，不隔离就等于往本机 `~/.agent-mesh` 里写测试数据。
  const home = mkdtempSync(join(tmpdir(), 'meeting-routes-'));
  const previousHome = process.env.MESH_VOICE_HOME;
  const previousDiag = process.env.MESH_DIAG_DIR;
  process.env.MESH_VOICE_HOME = join(home, 'voice');
  process.env.MESH_DIAG_DIR = join(home, 'logs');
  const channels = new Map<string, Dispatch>();
  const ctx = {
    tools: {register() {}},
    on() {},
    effect(callback: () => unknown) { return callback(); },
    logger: {warn() {}, error() {}},
    connection: {rpc: {handle(channel: string, handler: Dispatch) {
      assert.equal(channels.has(channel), false, `通道 ${channel} 被注册了两次`);
      channels.set(channel, handler);
      return async () => {};
    }}},
  };
  try {
    apply(ctx as never);
    const dispatch = channels.get('/meeting-assistant');
    assert.ok(dispatch, '会议助手应该注册它自己的通道');

    const status = await dispatch('status', {sessionId: 'session-unloaded-ui-probe'});
    assert.equal(status.ok, true, '恢复的界面会话可以在 Agent 还没上线时读状态');
    assert.equal(status.value.result, null);

    const invalid = await dispatch('status', {sessionId: '../../private'});
    assert.equal(invalid.ok, false, '调用方给的路径不能被当成会话目录');
  } finally {
    if (previousHome === undefined) delete process.env.MESH_VOICE_HOME; else process.env.MESH_VOICE_HOME = previousHome;
    if (previousDiag === undefined) delete process.env.MESH_DIAG_DIR; else process.env.MESH_DIAG_DIR = previousDiag;
    rmSync(home, {recursive: true, force: true});
  }
});
