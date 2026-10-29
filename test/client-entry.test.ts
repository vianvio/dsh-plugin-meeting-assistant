/**
 * 客户端半的**源码入口**真的加载一次。
 *
 * 为什么值得：唯一跑客户端那一半的用例跑的是**构建产物**（`test/package-boundary.test.ts` 只读产物
 * 里的几处标记），而那不在模块图里——`src/client.tsx` 自己的 `apply()` 可以一行都没被执行过，
 * 测试照样全绿。真出事时看到的是"这个插件在界面上消失了"，没有报错。
 *
 * 这里直接 import 源码、调 `apply(ctx)`，并把它认领的槽位与它自己广告的那份名单对一遍。槽位名
 * 是否在**宿主**里存在，需要一棵宿主安装树；本仓不靠那棵树也能跑，所以那条判据留在 Agent Mesh
 * 仓的 `test/client-entry.test.ts` 里（它本来就装着宿主树）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {DOCK_SEATS} from '../src/shared/dock/mounts.js';

// 客户端插件跑在浏览器里，`window` 是它脚下真实存在的东西（栏的挂载点、会话桥都从它上面取）。
// 这里给的是一份最小替身——不是为了模拟浏览器，只是让"源码入口能不能加载"在 Node 里也能问一次。
const globals = globalThis as unknown as {window?: any; document?: any};
if (!globals.window) {
  globals.window = {
    addEventListener() {}, removeEventListener() {},
    localStorage: {getItem: () => null, setItem() {}, removeItem() {}},
    document: {querySelector: () => null, createElement: () => ({style: {}, dataset: {}, setAttribute() {}, appendChild() {}, remove() {}}), head: {appendChild() {}}},
  };
}
if (!globals.document) globals.document = globals.window.document;

/** 一个"什么都收"的客户端 ctx 替身：够把入口跑完，并记下它认领的槽位。 */
function harness() {
  const injected: string[] = [];
  const slots: {name: string; id: string}[] = [];
  const disposers: (() => void)[] = [];
  const ctx = {
    effect(callback: () => unknown) { const dispose = callback(); if (typeof dispose === 'function') disposers.push(dispose as () => void); return dispose ?? (() => {}); },
    connection: {rpc: {call: async () => ({ok: true, value: {}}), handle() { return async () => {}; }}},
    sessions: {get: () => undefined, list: {getSnapshot: () => ({byId: {}, current: undefined}), subscribe: () => () => {}}, subagentAddress: () => undefined},
    layout: {closeDetails() {}, openDetails() {}, toggleSidebar() {}},
    get: () => undefined,
    slots: {
      inject: (name: string, register: () => unknown) => { injected.push(name); return register(); },
      register: (options: {name: string; id: string}) => { slots.push(options); return () => {}; },
    },
  };
  return {ctx, injected, slots, disposeAll() { for (const dispose of disposers.splice(0)) { try { dispose(); } catch {} } }};
}

test('客户端半的源码入口能加载，并认领它广告的那几个槽位', async (t) => {
  const {apply} = await import('../src/client.js');
  const h = harness();
  t.after(h.disposeAll);
  assert.equal(typeof apply, 'function', '客户端半必须导出 apply()');
  assert.doesNotThrow(() => apply(h.ctx as never), '源码入口一抛，整个客户端插件在界面上就消失了');
  // 两个落点里 `fallback` 就是 `conversation.input.left`（回退宿主 = 已经在渲染的输入框槽位），
  // 所以这里比的是**去重后**的槽位名：三个入口，两个落点。
  assert.deepEqual([...new Set(h.injected)].sort(), [...new Set(['conversation.input.left', DOCK_SEATS.fallback.name, DOCK_SEATS.overlay.name, 'settings.section'])].sort());
  assert.ok(h.slots.length >= 3, `认领的槽位都要有注册项，实际注册了 ${h.slots.length} 个`);
  for (const slot of h.slots) assert.match(slot.id, /^meeting-/, `注册的 id 应当带本插件前缀：${slot.id}`);
});

test('客户端半的 inject 与它真正读到的服务一致', async () => {
  const {inject} = await import('../src/client.js');
  assert.deepEqual([...inject].sort(), ['connection', 'layout', 'sessions', 'slots'].sort());
});
