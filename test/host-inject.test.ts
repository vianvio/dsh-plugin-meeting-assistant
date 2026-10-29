/**
 * 宿主半声明的服务，必须覆盖它真正用到的服务。
 *
 * 为什么值得一条测试：**漏一个就是整个 profile 起不来**，而且报错发生在加载阶段，看起来像
 * "这个插件坏了"。真事故：别人装完之后 DSH 直接启动失败——
 * `cannot get property "webServer" without inject`，因为 `ctx.connection.rpc.handle()` 把路由
 * 注册到**调用方 fiber** 的 `webServer` 上，而 inject 里没有它。开发机上没暴露，是因为那边的
 * DSH 版本按服务自身 fiber 判定，比对方宽松。
 *
 * 这条测试读源码文本：两半的 `ctx.<service>` 用法与各自导出的 `inject` 数组必须双向对得上。
 *
 * **拆成独立仓库之后它多守一件事**：宿主半与客户端半的 import 闭包现在包含 `src/shared/`
 * （拆包时拷进来的共享层）。以前那几份文件在另一个包里，谁用到了哪个服务只能靠一张手写的
 * `indirectlyUsed` 表记着；现在它们在闭包里，能直接扫到——手写表只剩下"代码里看不到 `ctx.<x>`
 * 但确实要声明"的那几条，每一条都必须写清理由。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {importClosure, readInject, root, serviceReads, src, stripComments} from './helpers.js';

/** `ctx.<x>` 里不是 cordis 服务、不需要 inject 的那些。 */
const notServices = new Set(['effect', 'on', 'off', 'get', 'set', 'provide', 'logger', 'scope', 'parallel', 'isolate', 'inject']);

/**
 * 代码里看不到 `ctx.<服务>`、但确实要声明的服务，以及为什么。
 *
 * 这个映射的用处就是这类"间接依赖"：**声明它们却不直接读，正是最难查的一类**（漏了会在别人的
 * 机器上炸、或者更糟——cordis 静默等待，界面上只剩一句 HTTP 405）。所以每一个都必须写清理由。
 */
const indirectlyUsed: Record<string, string> = {
  webServer: '通道注册在 src/shared/rpc-channel.ts 里逐项 try 读 ctx.webServer——DSH 把 webServer 隔离了，只有顶层 inject 声明过的 fiber 看得见它（读法写在 direct.webServer 上，正则扫不到那一步）',
  connection: '同一模块读 ctx.connection 拿 requestRejection（信任检查用 DSH 自己的那一套）与 rpc.handle 兜底；src/shared/host-scope.ts 再把它包进一个声明了 connection+webServer 的作用域',
};

/**
 * 客户端半里"看不到 `ctx.<服务>`、但确实要声明的服务"，以及为什么。
 *
 * `src/shared/right-panel.ts` 读服务用的是 `ctx.get('layout')`——**注入无关的安全读法**
 * （cordis 对没有声明 inject 的服务，属性读取会抛 `cannot get property ... without inject`）。
 * 静态扫描因此看不到 `ctx.layout`，但拖栏与面板进场前必须先让出右侧栏，而那一刻要在 `layout`
 * 上线之后：声明它是为了顺序，不是为了读它。
 */
const indirectlyUsedOnClient: Record<string, string> = {
  layout: '客户端半不直接读 `ctx.layout`（走 `ctx.get`，见 src/shared/right-panel.ts 的 yieldRightPanel），声明它是为了让"让出右侧栏"发生在它上线之后',
};

for (const half of [
  {name: '宿主半', entry: join(src, 'index.ts'), indirect: indirectlyUsed},
  {name: '客户端半', entry: join(src, 'client.tsx'), indirect: indirectlyUsedOnClient},
] as const) {
  test(`${half.name}: inject 与它真正读到的服务一致（双向）`, () => {
    const declared = readInject(readFileSync(half.entry, 'utf8'));
    assert.ok(declared.length > 0, `${half.name}的 inject 应该是一份非空清单`);

    const used = new Set<string>();
    for (const file of importClosure(half.entry)) {
      if (!/\.tsx?$/.test(file)) continue;
      for (const name of serviceReads(stripComments(readFileSync(file, 'utf8')))) {
        if (notServices.has(name)) continue;
        used.add(name);
      }
    }
    assert.ok(used.size > 0, `${half.name}一个服务都没扫到——扫描器失效了，这条断言会因此变成真空`);

    const missing = [...used].filter((name) => !declared.includes(name));
    assert.deepEqual(missing, [], `${half.name}用到了但没声明：${missing.join(', ')}（漏一个就会让整个 profile 起不来）`);

    // 反过来也看一眼：声明的服务都得真的需要——直接用到，或在上面的表里写明理由——否则就是
    // 白白抬高加载门槛（inject 是加载门槛，多声明一个就可能让某些部署装不上）。
    const needed = new Set([...used, ...Object.keys(half.indirect)]);
    const unused = declared.filter((name) => !needed.has(name));
    assert.deepEqual(unused, [], `${half.name}的 inject 里声明了却没用到：${unused.join(', ')}（多声明一条就是白白抬高加载门槛）`);
  });
}

test('包声明的入口与产物一致', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {main?: string; exports?: Record<string, string>; files?: string[]};
  assert.equal(manifest.main, 'lib/index.js');
  assert.equal((manifest.exports?.['./client'] ?? '').replace(/^\.\//, ''), 'lib/client.js');
  assert.match((manifest.exports?.['.'] ?? '').replace(/^\.\//, ''), /^lib\/index\.js$/);
  assert.ok(manifest.files?.includes('lib'), '产物目录必须随包发布，否则装上的是个空壳');
  // 客户端半的自注册 id 必须与包名逐字相同，否则与别的插件互相顶掉（构建脚本里也是这一条）。
  assert.match(readFileSync(join(root, 'build.mjs'), 'utf8'), /const MODULE_ID = pkg\.name;/, 'build.mjs 的客户端 id 必须取自包名');
});

test('宿主半的 import 闭包里没有插件入口', () => {
  // `src/voice/host.ts` 是"装一个功能"，`src/index.ts` 是"插件入口"：入口带模块级副作用
  // （一行加载日志 + 20 秒看门狗）。宿主半反向 import 入口，就会让"只 import 宿主半"也跑一遍
  // 那些副作用——行为判据在 `meeting-host-isolation.test.ts`，这条钉结构。
  const closure = importClosure(join(src, 'voice', 'host.ts')).map((file) => file.replace(`${root}/`, ''));
  assert.ok(closure.length > 1, `宿主半的闭包只扫到一个文件（${closure.join(', ')}）——这条断言会因此变成真空`);
  assert.deepEqual(closure.filter((file) => file === 'src/index.ts'), [], '宿主半的闭包里出现了插件入口 src/index.ts（入口是有副作用的模块）');
});
