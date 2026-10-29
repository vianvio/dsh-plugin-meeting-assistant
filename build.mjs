#!/usr/bin/env node
import {build, context} from 'esbuild';
import {mkdir, readFile} from 'node:fs/promises';

/**
 * `npm run build` —— 一次性构建；`npm run dev` —— 监听源码。
 *
 * # 这一份 build.mjs 是包自己的
 *
 * 拆包之前，这个插件的两半产物由 `agent-mesh/desktop/scripts/build.mjs` 一起打出来（那份脚本同时
 * 伺候另一个插件，构建入口写死在仓库里）。搬进独立仓库之后，构建只服务这一个包：入口就是
 * `src/index.ts` 与 `src/client.tsx`，不再有"别人的插件"需要在这个脚本里登记。
 *
 * # 两半产物，两种生效方式
 *
 * * **宿主半**（`src/index.ts` → `lib/index.js`）跑在 DSH 宿主进程里，ESM 只导入一次，而且桌面端
 *   有意禁用了 loader 的缓存清理——**改了要重启 DSH**。
 * * **客户端半**（`src/client.tsx` → `lib/client.js`）由 DSH 的客户端 HMR 接收器接住，**不用重启**，
 *   但前提是有东西在它眼皮底下把 bundle 重建出来（`npm run dev` 就是干这个的）。
 *
 * 客户端产物必须是**经典脚本**：页面用 `<script src>` 加载，走不了 ESM。所以打成 CJS 包在一个
 * 自注册外壳里（`window.__ModuleLoader__.load({id, factory})`），`id` 必须与包名逐字相同——写错
 * 的后果不是报错，而是与别的插件互相顶掉。
 *
 * # 谁可以保持外部
 *
 * 只有 DSH 运行环境提供的：`@deepseek-ai/*` 与 react 三件套。`ws` / `fflate` 反而是**打进来**的
 * （`platform:'node'` 的默认就是 bundle），因为目标读者常常只有 DSH Desktop 这个 app：装上插件
 * 就要求那台机器能跑包管理器把依赖装齐，是拆包前就踩过的坑。`bufferutil` / `utf-8-validate` 是
 * `ws` 的可选原生加速件，没装也得能跑，所以留在 external。
 *
 * # 音频 worklet
 *
 * 采集用的 AudioWorklet 源码不能 `require`（音频线程里没有模块加载器），所以先在构建期打成一段
 * IIFE 文本，再用 `define` 注入成 `__MEETING_WORKLET__` 字面量——`src/voice/capture.ts` 拿它造
 * Blob URL。它只在自己源码变了的时候才变。
 */
const watch = process.argv.includes('--watch');
/** 客户端产物注册进 DSH 模块加载器用的 id —— 必须与包名一致，否则两个插件会互相顶掉。 */
const pkg = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'));
const MODULE_ID = pkg.name;

await mkdir('lib', {recursive: true});

const hostOptions = {
  entryPoints: ['src/index.ts'],
  outfile: 'lib/index.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['@deepseek-ai/*', 'bufferutil', 'utf-8-validate'],
  sourcemap: true,
  metafile: true,
  // 版本号**只有一处真源**：`package.json`。构建时注入，避免"包是 0.1.x、诊断报告里写着另一个版本"。
  define: {__PLUGIN_VERSION__: JSON.stringify(pkg.version)},
  // 打进来的依赖（ws / fflate）是 CJS，它们在 ESM 产物里用 `require`——esbuild 会生成一个会抛
  // 「Dynamic require of "events" is not supported」的壳。给它一个真的 require 即可。
  banner: {js: "import { createRequire as __meetingCreateRequire } from 'node:module'; const require = __meetingCreateRequire(import.meta.url);"},
};

const clientOptions = (workletText) => ({
  entryPoints: ['src/client.tsx'],
  outfile: 'lib/client.js',
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  target: 'es2022',
  external: ['react', 'react-dom', 'react/jsx-runtime', '@deepseek-ai/*'],
  define: {
    'process.env.NODE_ENV': '"production"',
    __PLUGIN_VERSION__: JSON.stringify(pkg.version),
    __MEETING_WORKLET__: JSON.stringify(workletText),
  },
  banner: {js: `window.__ModuleLoader__.load({id:"${MODULE_ID}",factory:(require)=>{var module={exports:{}};var exports=module.exports;`},
  footer: {js: 'return module.exports;}});'},
  sourcemap: true,
  metafile: true,
});

/** 音频线程那份源码：打成 IIFE 文本，随客户端产物一起内联。 */
const workletText = async () => (await build({
  entryPoints: ['src/voice/audio.worklet.ts'], bundle: true, platform: 'browser', format: 'iife', target: 'es2022', write: false,
})).outputFiles[0].text;

if (!watch) {
  const worklet = await workletText();
  const host = await build(hostOptions);
  const client = await build(clientOptions(worklet));
  for (const [label, result] of [['lib/index.js', host], ['lib/client.js', client]]) {
    const bytes = result.metafile?.outputs?.[label]?.bytes ?? 0;
    console.log(`${label}  ${(bytes / 1024).toFixed(1)} KiB`);
  }
  console.log(`构建完成（v${pkg.version}）。宿主半改了要重启 DSH；客户端半由 HMR 接住。`);
} else {
  const report = (file) => () => console.log(`${new Date().toLocaleTimeString()}  ${file} 重建完成`);
  const watcher = (file) => ({
    name: `report-${file}`,
    setup(pluginBuild) {
      pluginBuild.onEnd((result) => { if (result.errors.length === 0) report(file)(); });
    },
  });
  const worklet = await workletText();
  await context({...hostOptions, plugins: [watcher('lib/index.js')]}).then((ctx) => ctx.watch());
  await context({...clientOptions(worklet), plugins: [watcher('lib/client.js')]}).then((ctx) => ctx.watch());
  console.log('监听中：src/**（宿主半改了要重启；客户端半会被 HMR 接住）。worklet 的改动要重启 `npm run dev`。');
}
