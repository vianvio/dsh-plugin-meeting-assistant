/**
 * 插件内部的 import 图**不能有环**。
 *
 * 这条断言来自一个真实的环：面板的类型层与会话状态机互相 import，两条边都是 `import type`，
 * 产物里被擦除，所以运行期没事、也没有任何测试会红；代价是所有权循环——两边的模块都改不动。
 *
 * 环的检测不能靠肉眼（现在 30 多个文件、上百条边，一眼看不出），所以把它固化成测试。这条测试同时
 * 守住将来重新长出来的环：新加一条 `import type` 就能造一个环，而它不会有任何症状。
 *
 * **拆成独立仓库之后这条更重要**：`src/shared/` 与 `src/vendor/` 是拷进来的外部代码，本仓要对它们
 * 的依赖方向负责——以前那种"上游两个包之间怎么绕都行"的自由没有了。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {relative} from 'node:path';
import {edges, resolveInside, root, sourceFiles, src, stripComments} from './helpers.js';

function cycle(): string[] | undefined {
  const graph = new Map<string, string[]>();
  for (const file of sourceFiles(src)) {
    const targets = edges(stripComments(readFileSync(file, 'utf8')))
      .map(({specifier}) => resolveInside(file, specifier))
      .filter((target): target is string => Boolean(target) && target!.startsWith(`${root}/`) && /\.tsx?$/.test(target!));
    graph.set(file, targets);
  }

  const visiting = new Set<string>();
  const done = new Set<string>();
  const stack: string[] = [];
  const walk = (node: string): string[] | undefined => {
    if (visiting.has(node)) return [...stack.slice(stack.indexOf(node)), node].map((file) => relative(root, file));
    if (done.has(node)) return undefined;
    visiting.add(node);
    stack.push(node);
    for (const next of graph.get(node) ?? []) {
      const found = walk(next);
      if (found) return found;
    }
    stack.pop();
    visiting.delete(node);
    done.add(node);
    return undefined;
  };
  for (const node of graph.keys()) {
    const found = walk(node);
    if (found) return found;
  }
  return undefined;
}

test('src/ 的 import 图没有环', () => {
  assert.equal(cycle(), undefined, `import 图里出现了环：${cycle()?.join(' → ')}`);
});
