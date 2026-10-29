/**
 * 侧栏（`DockHost`）的两个落点与配色，判据各一条。
 *
 * 这些断言原来在 Agent Mesh 仓里，盯的是**两个插件共用**的那份共享层。拆包之后本仓自带一份
 * （`src/shared/dock/`），于是它自己的产物也得同样被盯住——而且这里多了一条以前没有的判据：
 * 落点的 `order` 只能来自共享表，不许再在包里写字面量。
 *
 * 起因是一次真实的黑屏：面板被硬编码成 `grid-row:1`，而 DSH 0.1.5 起外壳是
 * "**32px 表头 + 内容**"两行，于是面板只占了最上面 32px 的一条缝；配色则取了一个从不存在的
 * 主题变量、退回系统色 `CanvasText`——浅色外观 + 暗色主题 = 黑字画在黑底上。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {DOCK_COLORS, dockRowFor} from '../src/shared/dock/dock-layout.js';
import {DOCK_SEATS, dockMount} from '../src/shared/dock/mounts.js';
import {src} from './helpers.js';

test('行号按网格几何推：一行的壳是第 1 行，带表头的两行壳是第 2 行', () => {
  assert.equal(dockRowFor('917px'), 1, '只有一行轨道');
  assert.equal(dockRowFor(''), 1, '读不到就按第 1 行');
  // DSH 0.1.5 的实测值：32px 表头 + 917px 内容。
  assert.equal(dockRowFor('32px 917px'), 2, '表头 32px 不是内容行');
  assert.equal(dockRowFor('917px 32px'), 1, '顺序反过来也一样按高度选');
  assert.equal(dockRowFor('32px 1fr'), 2);
  assert.equal(dockRowFor('32px auto 1fr'), 2, '并列时取靠前的那个非固定轨道');
  assert.equal(dockRowFor('60px 40px 32px'), 1, '全是 px 时取最高的');
});

test('主题变量用真实存在的名字，且兜底不是系统色', () => {
  assert.match(DOCK_COLORS.color, /--dsw-alias-label-primary/);
  assert.match(DOCK_COLORS.color, /inherit\)$/, '兜底必须是 inherit，不能是 CanvasText');
  assert.doesNotMatch(DOCK_COLORS.color, /CanvasText|Canvas\)/);
  assert.match(DOCK_COLORS.background, /--dsw-alias-bg-base/);
  assert.match(DOCK_COLORS.background, /inherit\)$/);
  assert.doesNotMatch(DOCK_COLORS.background, /\bCanvas\)/);
});

test('两个落点来自同一张表，且 name 是 DSH 真实槽位', () => {
  assert.deepEqual(dockMount('fallback', 'x'), {name: 'conversation.input.left', id: 'x', order: 999});
  assert.deepEqual(dockMount('overlay', 'y'), {name: 'shell.overlay', id: 'y', order: 70});
  assert.notEqual(DOCK_SEATS.overlay.name, DOCK_SEATS.fallback.name, '两个落点必须是两个不同的槽位');
});

test('客户端半通过共享表声明落点，order 不再写在包里', () => {
  const source = readFileSync(join(src, 'client.tsx'), 'utf8');
  const calls = [...source.matchAll(/dockMount\(\s*'(overlay|fallback)'\s*,\s*'([^']+)'\s*\)/g)];
  assert.equal(calls.length, 2, '两个落点都应当走 dockMount()');
  assert.deepEqual(calls.map((call) => call[1]).sort(), ['fallback', 'overlay']);
  for (const call of calls) assert.match(call[2]!, /^meeting-/, `落点 id 应当带本插件前缀：${call[2]}`);
  // 字面量写法不许再出现：它正是那份"两份可以各自漂移的真相"。
  assert.doesNotMatch(source, /order:\s*(999|70|50)/, '落点的 order 不该再写在包里');
});
