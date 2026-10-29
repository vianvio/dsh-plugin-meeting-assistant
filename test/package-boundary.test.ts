/**
 * 这个包**能单独装**这件事，由三条边界判据守着。
 *
 * 拆成独立仓库之后，最容易复发的一种退化是"悄悄又连回 Agent Mesh"：源码里写一句指向仓库外的
 * 相对 import、manifest 里挂一条 `file:` 依赖、产物里混进另一个包的名字。它们在本机都不会报错
 * ——因为本机恰好有那个目录、恰好装过那个包——代价出现在别人的机器上，而且是"装上但不工作"。
 *
 * 所以判三条：
 *
 *  1. **源码里每一条相对 import 都落在本仓内**（`src/shared`、`src/vendor` 就是为此存在的：
 *     要共享的东西拷进来，而不是指过去）；
 *  2. **manifest 里没有 `file:` / `link:` / `portal:` 依赖**，也没有指向另一个插件的依赖；
 *  3. **产物里没有别的插件的痕迹**（`lib/` 是发布出去的那一份）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {existsSync, readFileSync} from 'node:fs';
import {join, relative, sep} from 'node:path';
import {edges, resolveInside, root, sourceFiles, src, stripComments} from './helpers.js';

/** 别的插件/平台的包名：出现在任何一处都算连回去了。 */
const FOREIGN = ['dsh-plugin-agent-mesh', '@agent-mesh/', 'agent-mesh-platform'];

test('源码里每一条相对 import 都落在本仓内', () => {
  const outside: string[] = [];
  const unresolved: string[] = [];
  for (const file of sourceFiles(src)) {
    for (const {specifier} of edges(stripComments(readFileSync(file, 'utf8')))) {
      if (!specifier.startsWith('.')) continue;
      const target = resolveInside(file, specifier);
      if (!target) { unresolved.push(`${relative(root, file)}: ${specifier}`); continue; }
      if (!target.startsWith(`${root}${sep}`)) outside.push(`${relative(root, file)}: ${specifier}`);
    }
  }
  assert.deepEqual(unresolved, [], `这些相对 import 解析不到实际文件：\n${unresolved.join('\n')}`);
  assert.deepEqual(outside, [], `这些相对 import 越出了本仓（独立插件不许指向别的仓库）：\n${outside.join('\n')}`);
});

test('源码里没有指向别的插件/平台的说明符', () => {
  const offenders: string[] = [];
  for (const file of sourceFiles(src)) {
    for (const {specifier} of edges(stripComments(readFileSync(file, 'utf8')))) {
      for (const name of FOREIGN) {
        if (specifier === name || specifier.startsWith(name) || specifier.includes(`/${name}`)) offenders.push(`${relative(root, file)}: ${specifier}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `这些 import 连回了别的插件/平台：\n${offenders.join('\n')}`);
});

test('manifest 里没有指向本机的依赖形态', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Record<string, Record<string, string> | undefined>;
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const [name, version] of Object.entries(manifest[field] ?? {})) {
      assert.doesNotMatch(version, /^(file|link|portal):/, `${field}.${name} 是 ${version}：本机路径依赖会让别人的安装失败，源码要拷进 src/`);
      for (const foreign of FOREIGN) assert.ok(!name.includes(foreign), `${field}.${name} 指向了别的插件/平台`);
    }
  }
  // 这两份副本不是包：不许有人给它们加 package.json 后当依赖挂上去（那样又变回"两个仓库"了）。
  for (const dir of ['src/shared', 'src/vendor/voice-kernel']) {
    assert.equal(existsSync(join(root, dir, 'package.json')), false, `${dir} 不该有自己的 manifest——它是本包的源码，不是包`);
  }
});

test('产物里没有别的插件的痕迹，客户端产物自带两份必须内联的东西', () => {
  const host = join(root, 'lib', 'index.js');
  const client = join(root, 'lib', 'client.js');
  assert.ok(existsSync(host), 'lib/index.js 不存在——`npm run build` 没跑过（`npm test` 的 pretest 会先建）');
  assert.ok(existsSync(client), 'lib/client.js 不存在');

  for (const [label, file] of [['宿主半', host], ['客户端半', client]] as const) {
    const text = readFileSync(file, 'utf8');
    for (const foreign of ['dsh-plugin-agent-mesh', '@agent-mesh/']) {
      assert.equal(text.includes(foreign), false, `${label}产物里混进了 ${foreign}——发布出去的这一份会在别人的机器上找它`);
    }
  }

  // 客户端产物：自注册外壳的 id 必须是包名（写错不是报错，而是与别的插件互相顶掉）。
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {name: string};
  assert.match(readFileSync(client, 'utf8'), new RegExp(`window\\.__ModuleLoader__\\.load\\(\\{id:"${manifest.name}"`));
  // 音频 worklet 没有模块加载器可用，必须在构建期打成文本内联进来；漏了它麦克风一开就抛。
  assert.match(readFileSync(client, 'utf8'), /PcmEncoder/, '客户端产物里没有 worklet 的内联文本（__MEETING_WORKLET__ 没注入）');
});
