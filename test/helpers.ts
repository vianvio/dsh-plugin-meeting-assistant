/**
 * 几条测试共用的源码扫描工具。
 *
 * 这一份是本仓自己的（拆包前它们散在 `agent-mesh/desktop/test/*.test.ts` 里各写一遍）。抽出来的
 * 理由很具体：**边界判据必须用同一套解析**——"包内相对 import 的闭包"这件事，`host-inject`
 * （inject 覆盖）、`client-boundary`（客户端半不许碰 Node 内建）、`import-graph`（不许有环）、
 * `package-boundary`（不许指向仓库外）四处都要算一遍。各写一遍的下场是某一处漏了 `.mjs` 或
 * `index.tsx` 的解析规则，于是同一个包在三处的"闭包"不是同一个东西，而失败的只有其中一处。
 */
import {existsSync, readdirSync, readFileSync} from 'node:fs';
import {dirname, join, resolve, sep} from 'node:path';

/** 仓库根（`test/` 的上一层）。 */
export const root = join(import.meta.dirname, '..');
/** 插件自己的源码根。 */
export const src = join(root, 'src');

/** 注释里的 `ctx.connection.rpc.handle()` 只是说明，不是"用到了这个服务"——先剥掉。 */
export function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** `src/` 下所有 `.ts`/`.tsx`（`lib/` 是产物、不在 `src/` 里）。 */
export function sourceFiles(directory: string): string[] {
  return readdirSync(directory, {withFileTypes: true}).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

export interface Edge {
  /** 说明符原文（`./x.js`、`node:fs`、`@deepseek-ai/dsh-tools`…）。 */
  specifier: string;
  /** 纯类型引用（`import type` / `export type`）：不进产物，可以指向宿主半的东西。 */
  typeOnly: boolean;
  /** `import('…')` / `await import('…')`。 */
  dynamic: boolean;
}

/**
 * 一条 import/export 边。
 *
 * `import type {X} from 'y'` 与 `export type {X} from 'y'` 是纯类型；`import {type X} from 'y'`
 * 算取值（保守判法：混在一个大括号里的写法无法确定，宁可误报也不要漏报）。
 */
export function edges(text: string): Edge[] {
  const found: Edge[] = [];
  for (const match of text.matchAll(/^\s*(import|export)\s+(type\s+)?([\s\S]*?)\s*from\s*['"]([^'"]+)['"]/gm)) {
    found.push({specifier: match[4]!, typeOnly: Boolean(match[2]), dynamic: false});
  }
  for (const match of text.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    found.push({specifier: match[1]!, typeOnly: false, dynamic: true});
  }
  // 副作用 import：`import './x.js';`
  for (const match of text.matchAll(/^\s*import\s+['"]([^'"]+)['"];?\s*$/gm)) {
    found.push({specifier: match[1]!, typeOnly: false, dynamic: false});
  }
  return found;
}

/** 包内相对说明符解析成实际文件（`.js` 说明符指回 `.ts`/`.tsx`；`.mjs` 直接找）。 */
export function resolveInside(from: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const target = resolve(dirname(from), specifier);
  for (const candidate of [target, target.replace(/\.js$/, '.ts'), target.replace(/\.js$/, '.tsx'), `${target}.ts`, `${target}.tsx`, join(target, 'index.ts'), join(target, 'index.tsx')]) {
    if (existsSync(candidate) && !candidate.includes('.d.')) {
      if (candidate.endsWith('.mjs') || /\.tsx?$/.test(candidate)) return candidate;
    }
  }
  return undefined;
}

/**
 * 从 `entry` 出发、沿**仓库内相对 import** 收集到的文件（含 entry 自己）。
 *
 * 只跟相对路径：`@deepseek-ai/*` 那些要么是宿主提供、要么是 devDependency，不在这条"我们自己的
 * 代码"的闭包里。
 *
 * **只跟取值边**（`import type` 不算）：这条闭包问的是"这段代码真的会跑哪些文件"。
 * 类型边在产物里被擦除，跟着它走会把**根本不会被打包**的文件算进来——真实的误报就是把
 * `import type {MeetingMeta} from './store.js'` 当成"客户端半用了 `node:fs`"（`store.ts` 是纯宿主
 * 文件）。要判"类型边能不能指过去"是另一件事，`client-boundary.test.ts` 里单独判。
 */
export function importClosure(entry: string): string[] {
  const seen = new Set<string>();
  const pending = [entry];
  while (pending.length) {
    const file = pending.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    if (!/\.tsx?$/.test(file)) continue; // vendored `.mjs` 不参与（它们没有 import 别的源码）
    for (const {specifier, typeOnly} of edges(stripComments(readFileSync(file, 'utf8')))) {
      if (typeOnly) continue;
      const target = resolveInside(file, specifier);
      if (!target) continue;
      if (!target.startsWith(`${root}${sep}`)) continue;
      pending.push(target);
    }
  }
  return [...seen];
}

/** 声明式（含 `import type`/`export type`）的闭包：判"类型边能指向哪里"。 */
export function declarationClosure(entry: string): string[] {
  const seen = new Set<string>();
  const pending = [entry];
  while (pending.length) {
    const file = pending.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    if (!/\.tsx?$/.test(file)) continue;
    for (const {specifier} of edges(stripComments(readFileSync(file, 'utf8')))) {
      const target = resolveInside(file, specifier);
      if (!target || !target.startsWith(`${root}${sep}`)) continue;
      pending.push(target);
    }
  }
  return [...seen];
}

/** `ctx.<x>` / `ctx?.<x>` / `this.ctx.<x>` 里的 `<x>`。 */
export function serviceReads(text: string): string[] {
  return [...text.matchAll(/(?:\bthis\s*\.\s*)?\bctx\s*\??\s*\.\s*([A-Za-z][A-Za-z0-9_]*)/g)].map((match) => match[1]!);
}

/** 从源码里读 `export const inject = [...]`。 */
export function readInject(source: string): string[] {
  return /export const inject\s*=\s*\[([^\]]*)\]/.exec(source)?.[1]?.split(',').map((entry) => entry.trim().replace(/['"]/g, '')).filter(Boolean) ?? [];
}
