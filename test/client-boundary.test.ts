/**
 * 客户端半的**源码可达图**里不许出现 Node 内建。
 *
 * 两半的边界是硬约束：`build.mjs` 用 `platform:'browser'` 打包客户端半，`node:fs` 这类东西进不去。
 * 但这条约束如果只靠"读产物"来守，源码层就是无人看管的：谁把 `import type {X}` 写成
 * `import {X}`（一个字符），在重新构建之前不会有任何反应——等换机器构建时才炸，而那时看到的是
 * esbuild 的一句 "Could not resolve node:fs"。
 *
 * 所以这里在**源码**上判：从 `src/client.tsx` 出发，沿仓库内相对 import 收集闭包，闭包里任何一条
 * **取值的**（非 `import type`）指向 `node:` 的边都算越界。类型边不算——它不进产物。
 * `ws` 这种 Node-only 的包同理（宿主半的 ASR 连接用它）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {join, relative} from 'node:path';
import {edges, importClosure, root, src, stripComments} from './helpers.js';

/** 只有宿主半才能取的模块/包。 */
const HOST_ONLY = ['node:', 'ws'];

test('客户端半的可达图里没有取值引用 Node 内建或 ws', () => {
  const closure = importClosure(join(src, 'client.tsx'));
  assert.ok(closure.length > 5, `客户端半的闭包只扫到 ${closure.length} 个文件——这条断言会因此变成真空`);

  const offenders: string[] = [];
  for (const file of closure) {
    if (!/\.tsx?$/.test(file)) continue;
    for (const {specifier, typeOnly} of edges(stripComments(readFileSync(file, 'utf8')))) {
      if (typeOnly) continue;
      for (const name of HOST_ONLY) {
        if (specifier === name || specifier.startsWith(name === 'ws' ? 'ws/' : name)) offenders.push(`${relative(root, file)}: ${specifier}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `客户端半取值引用了宿主半的东西（浏览器里解析不到）：\n${offenders.join('\n')}`);
});

test('宿主半的闭包**确实**用到了 node 内建（反证上面那条不是在真空里成立）', () => {
  // 否则"客户端闭包里没有 node:"可能只是"整个仓库都没用 node:"。
  const closure = importClosure(join(src, 'index.ts'));
  const usesNode = closure.some((file) => /\.tsx?$/.test(file) && edges(stripComments(readFileSync(file, 'utf8'))).some((edge) => edge.specifier.startsWith('node:')));
  assert.ok(usesNode, '宿主半的闭包里一条 node: 都没有——上面那条断言的判据失效了');
});
