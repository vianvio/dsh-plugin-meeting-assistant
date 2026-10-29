/**
 * "现在跑的是哪一份宿主代码" —— 一个能直接看到的答案。
 *
 * 客户端的两个半是不同的东西，这一点决定了改完怎么生效：
 *
 *  * **客户端半**跑在渲染进程里，DSH 有 HMR 接收器，改完刷新页面就是新的；
 *  * **宿主半**是被宿主进程 `import` 一次的普通模块，没有任何重载路径。改完之后
 *    唯一能做的是重启 DSH——所以"要不要重启"这个问题必须能从界面上直接读出来，
 *    而不是靠回忆自己上次是几点启动的。
 *
 * 判定方式刻意选得最不容易骗人：记下**加载那一刻**产物文件的 mtime，之后每次被问
 * 都把磁盘上的 mtime 再读一遍。磁盘比内存新，就说明 `npm run dev` 在我启动之后
 * 又构建过——那一次构建的内容现在不在进程里。
 */
import { statSync, type Stats } from 'node:fs';

export interface HostBuild {
  /**
   * 宿主半加载那一刻的 ISO 时间戳（`agent-mesh-host <ISO>`）。
   *
   * 它的用处是**把两处对起来**：启动时打进 stderr 的那一行日志，和面板"诊断"里显示的
   * 这一行，是同一个字符串——出问题时不用猜"界面上这个是哪个进程"。
   */
  marker: string;
  /** 宿主半被加载的时刻。 */
  loadedAt: number;
  /** 已经跑了多久。 */
  uptimeMs: number;
  /** 正在运行的这个产物文件的路径。 */
  bundlePath: string;
  /** 加载时的 mtime；读不到就是 `null`。 */
  loadedMtime: number | null;
  /** 此刻磁盘上的 mtime；读不到就是 `null`。 */
  diskMtime: number | null;
  /** 磁盘上已有比内存里这一份更新的构建：改动要等重启才生效。 */
  stale: boolean;
}

/**
 * mtime of one file, or `null` when it is not a readable file.
 *
 * 打包成单文件之后，产物可能来自 `node_modules` 里的软链，也可能来自一个已被换掉的
 * 路径——读不到不是错误，只是"问不出答案"，所以这里返回 `null` 而不是抛。
 */
export function bundleMtime(path: string): number | null {
  try {
    return (statSync(path) as Stats).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Freshness of the running host half.
 *
 * `read` 是为了让测试能给出确定的 mtime，而不必真的去建文件、也不必碰系统时钟。
 */
export function describeHostBuild(
    input: { marker: string; bundlePath: string; loadedAt: number; loadedMtime: number | null },
    read: (path: string) => number | null = bundleMtime): HostBuild {
  const diskMtime = input.bundlePath ? read(input.bundlePath) : null;
  // 1 秒的宽容：构建器写完文件和它在文件系统里落定之间可能有一点点偏差，
  // 而"重启之后仍然显示过期"会让人学会忽略这个提示——那比不显示更糟。
  const stale = diskMtime !== null && input.loadedMtime !== null && diskMtime > input.loadedMtime + 1000;
  return {
    marker: input.marker,
    loadedAt: input.loadedAt,
    uptimeMs: Date.now() - input.loadedAt,
    bundlePath: input.bundlePath,
    loadedMtime: input.loadedMtime,
    diskMtime,
    stale,
  };
}
