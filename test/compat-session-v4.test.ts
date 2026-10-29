/**
 * 会议助手**真的注入出去的那条消息**，必须能被当前宿主代的会话格式编码器接受。
 *
 * 失败的样子（真事）：0.2.1-rc.2 的会话格式升到 v4，编码器只收"生产者自己的 kind"，对
 * `source.kind === 'plugin'` 直接抛
 * `SessionFormatError: format v4 message requires a producer-owned source kind`；
 * 而上一版 `voice/context.ts` 写死的正是 `{kind:'plugin',plugin:'dsh-plugin-meeting-assistant'}`。
 * 症状不在插件里：会议照录，注入照发，只是**每一条都进不了会话日志**。
 *
 * 这条用例不手写那条 source：起一个真的 `MeetingContextFeed`，把它的 `agent.inject` 直接接到
 * **真的 v4 编码器**上——插件今天注入什么，就由编码器今天判一次。另外留一条对照（被 v4 明确
 * 拒收的那套写法仍然被拒），否则"通过了"可能只是因为断言什么都没测。
 *
 * 编码器不是宿主安装树里的那份，而是本仓 devDependencies 钉住的同代 npm 包
 * （`@deepseek-ai/dsh-session-format-catalog`），所以 `npm test` 不需要一棵宿主树。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {sessionFormatCatalog as catalog} from '@deepseek-ai/dsh-session-format-catalog';
import {SESSION_FORMAT_VERSION} from '@deepseek-ai/dsh-session';
import {MeetingStore} from '../src/voice/store.js';
import {MeetingContextFeed} from '../src/voice/context.js';

type Source = Record<string, unknown>;
const event = (source: Source) => ({
  type: 'user/message' as const, seq: 1, time: 0,
  data: {id: 'm1', role: 'user' as const, source, content: [{type: 'text' as const, text: 'hi'}]},
});

test('跑的是会话格式 v4（否则后面的断言没有意义）', () => {
  assert.equal(SESSION_FORMAT_VERSION, 4);
  assert.equal(catalog.currentVersion, 4);
});

test('插件真的注入出去的那条消息能被 v4 编码器接受', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'meeting-v4-'));
  try {
    const store = new MeetingStore(dir);
    const meta = store.create('s1');
    meta.state = 'recording';
    meta.segments = 1;
    store.save(meta);
    store.append(meta, {text: '先把目录理一遍', wallTs: Date.now(), beginMs: 0, endMs: 500});
    store.save(meta);

    const injected: Source[] = [];
    const agent = {
      inject: (message: Source) => {
        // 真的编码器：`{kind:'plugin'}` 那种写法就是在这一步被拒的。
        catalog.encodeCurrentEvent({type: 'user/message', seq: injected.length + 1, time: 0, data: message as never});
        injected.push(message);
      },
    };
    const ctx = {get: (name: string) => (name === 'agents' ? {get: () => agent} : undefined)};
    const feed = new MeetingContextFeed(store, ctx as never, () => Date.now());
    assert.equal(await feed.refresh(meta), true, '第一次快照必须注入成功');
    assert.equal(injected.length, 1);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('对照：被 v4 明确拒收的那套写法仍然被拒（这条判据不是摆设）', () => {
  const retired = {kind: 'plugin', plugin: 'dsh-plugin-meeting-assistant', form: 'snapshot', sections: [{name: 's', text: 't'}]};
  assert.throws(() => catalog.encodeCurrentEvent(event(retired) as never), /producer-owned source kind/);
});
