/**
 * 客户端半，按 DSH 加载它的方式加载一次。
 *
 * 其它用例跑的是**源码**模块：那证明逻辑对，但不证明操作者真正盯着的那一份——构建出来的 bundle
 * 能不能在浏览器加载器下解析它的 external、认领它该认领的槽位。加载即抛的 bundle 会带走整个插件的
 * 界面（开关、面板、设置），而失败的样子是"更新没生效"，不是一条报错。
 *
 * 产物是 CJS 包在 DSH 运行时提供的 `window.__ModuleLoader__.load({id, factory})` 里，所以这里用
 * 替身全局 + 替身 `require` 就能执行它。
 *
 * 还有一条比"能加载"更细的判据：**读一个没在 `inject` 里声明过的服务就抛**。cordis 的服务隔离是
 * 读属性即抛，`ctx?.sessions` 的 `?.` 挡不住——真事故里客户端半少声明一个服务，装完之后 DSH 起不来
 * （`web boot: 1 entry did not activate`），而在"什么都能读"的替身 ctx 上这条测试会全绿。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {root} from './helpers.js';
import {DOCK_SEATS} from '../src/shared/dock/mounts.js';

interface Registration { name: string; id: string; order?: number }

/** React 替身：`apply` 只**定义**组件，从不渲染。 */
const react = {
  Component: class { props: unknown; constructor(props: unknown) { this.props = props; } setState(_next: unknown) {} },
  createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({type, props, children}),
  useState: (value: unknown) => [value, () => {}],
  useEffect: () => {}, useCallback: (fn: unknown) => fn, useMemo: (fn: () => unknown) => fn(), useRef: (value: unknown) => ({current: value}),
  useLayoutEffect: () => {}, useSyncExternalStore: (_subscribe: unknown, get: () => unknown) => get(),
  Fragment: 'Fragment',
};

/** `harness()` 的 ctx 上那些**不是服务**的键：读它们不受 inject 约束。 */
const NOT_SERVICE_KEYS = new Set(['get', 'effect', 'on', 'off', 'logger', 'slots', 'provide', 'set', 'scope', 'query']);

function harness() {
  const slots: Registration[] = [];
  const injected: string[] = [];
  const disposers: (() => void)[] = [];
  const ctx: Record<string, unknown> = {
    effect(callback: () => unknown) { const dispose = callback(); if (typeof dispose === 'function') disposers.push(dispose as () => void); return dispose ?? (() => {}); },
    connection: {rpc: {call: async () => ({ok: true, value: {}}), handle() { return async () => {}; }}},
    sessions: {get: () => undefined, list: {getSnapshot: () => ({byId: {}, current: undefined}), subscribe: () => () => {}}, subagentAddress: () => undefined},
    layout: {closeDetails() {}, openDetails() {}, toggleSidebar() {}},
    get: () => undefined,
    slots: {
      inject: (name: string, register: () => unknown) => { injected.push(name); return register(); },
      register: (options: Registration) => { slots.push(options); return () => {}; },
    },
  };
  return {ctx, slots, injected, disposeAll() { for (const dispose of disposers.splice(0)) { try { dispose(); } catch {} } }};
}

/** 按 inject 契约执行 `apply`：读一个没声明过的服务就抛（与 cordis 同形）。 */
function enforceInject(plugin: {inject?: readonly string[]}, ctx: Record<string, unknown>): Record<string, unknown> {
  const declared = new Set(plugin.inject ?? []);
  const services = Object.keys(ctx).filter((name) => !NOT_SERVICE_KEYS.has(name));
  return new Proxy(ctx, {
    get(target, property, receiver) {
      if (typeof property === 'string' && services.includes(property) && !declared.has(property)) {
        throw new Error(`cannot get property "${property}" without inject`);
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

test('客户端产物在模块加载器下能加载，认领它的三个入口，且只用 inject 里声明的服务', () => {
  const source = readFileSync(join(root, 'lib', 'client.js'), 'utf8');
  let factory: ((require: (id: string) => unknown) => {apply?: (ctx: unknown) => void; inject?: readonly string[]}) | undefined;
  const window = {
    __ModuleLoader__: {load: ({factory: loaded}: {factory: typeof factory}) => { factory = loaded; }},
    addEventListener() {}, removeEventListener() {}, localStorage: {getItem: () => null, setItem() {}},
  };
  const document = {querySelector: () => null, createElement: () => ({style: {}, dataset: {}, setAttribute() {}, appendChild() {}, remove() {}}), head: {appendChild() {}}};
  // `new Function` 把产物隔离在这个模块的作用域之外：它的全局就是这里给的替身，与浏览器加载器一致。
  new Function('window', 'document', 'localStorage', 'globalThis', 'React', source)(window, document, window.localStorage, {}, react);
  assert.ok(factory, '产物必须向模块加载器注册一个 factory');

  const plugin = factory((id: string) => {
    if (id === 'react' || id === 'react/jsx-runtime') return react;
    if (id === 'react-dom') return {createPortal: (node: unknown) => node};
    return {};
  });
  const h = harness();
  try {
    assert.equal(typeof plugin.apply, 'function');
    assert.doesNotThrow(() => plugin.apply!(enforceInject(plugin, h.ctx)), '产物一抛，整个客户端插件在界面上就消失了');
  } finally {
    h.disposeAll();
  }
  assert.deepEqual([...new Set(h.injected)].sort(), [...new Set(['conversation.input.left', DOCK_SEATS.overlay.name, 'settings.section'])].sort());
  assert.ok(h.slots.length >= 3, `认领的槽位都要有注册项，实际注册了 ${h.slots.length} 个`);
});
