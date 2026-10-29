/**
 * 让出右侧栏——mesh 面板和 DSH 自己的右侧内容抢的是同一列，进场前必须先让位。
 *
 * DSH 0.2 的壳把右侧栏拆成了两层，两个 seam 都在（`dsh-client-ui-sidebar-right`）：
 *
 *  * 真正的内容与开合在 `ctx.sidebarRight`（带标签页的右侧栏）：要关掉**活动标签页**；
 *  * `ctx.layout` 只剩一个几何上报面：`closeRightbar()` 通知几何观察者"它关了"，
 *    本身不关任何东西——所以它是兜底，不是首选。
 *
 * 按能力探测而不是按版本号判断：谁能关就调谁。读服务用 `ctx.get` 而不是属性：cordis 对
 * **没有声明 inject** 的服务，属性读取会抛 `cannot get property ... without inject`，
 * `get` 才是注入无关的安全读法（同 plugins/plugin-meeting/src/voice/services.ts 的
 * optionalService）。
 */
import type {Context} from '@deepseek-ai/cordis';

/** 右侧栏控制器里这里用得到的两个方法。 */
export interface SidebarRightSeam {
  active?: () => {id?: unknown} | undefined;
  close?: (id: unknown) => void;
}

/** 布局面上的右侧动作。 */
export interface LayoutPanelSeam {
  closeRightbar?: () => void;
}

function optionalSeam<T>(ctx: Context, name: string): T | undefined {
  try{return (ctx as {get?: (name: string) => unknown}).get?.(name) as T | undefined;}catch{return undefined;}
}

/**
 * 按能力让出右侧栏：先关活动标签页，没有活动标签页时退回几何上报面。
 * 抽成纯函数是为了让这两条路能被单测直接钉住。
 */
export function yieldRightPanelWith(services: {sidebarRight?: SidebarRightSeam; layout?: LayoutPanelSeam}): void {
  const active = services.sidebarRight?.active?.();
  if (active?.id !== undefined && typeof services.sidebarRight?.close === 'function') {
    services.sidebarRight.close(active.id);
    return;
  }
  services.layout?.closeRightbar?.();
}

/** 让出右侧栏；见上面对两个 seam 的说明。 */
export function yieldRightPanel(ctx: Context): void {
  yieldRightPanelWith({sidebarRight: optionalSeam(ctx, 'sidebarRight'), layout: optionalSeam(ctx, 'layout')});
}
