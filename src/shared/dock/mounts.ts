/**
 * 共享栏在 DSH 里的两个落点：**形状只有这一份**。
 *
 * 两个插件都会注册它们（谁先加载谁建栏；只装一个插件时它也照样开得出栏），所以"回退宿主的 order
 * 是 999"这条约定以前是**两个包里各写一遍的字面量**：agent-mesh 注册
 * `{id:'agent-mesh-dock-fallback',order:999}`，meeting 注册 `{id:'meeting-dock-fallback',order:999}`。
 * 今天没有可见分叉（栏的宿主数量由 `dock.tsx` 的全局 `liveHosts` 收着，第二个宿主发现栏已由活宿主
 * 占着就直接返回），但槽位里那两条条目的形状是两份可以各自漂移的真相——而 order 或 name 漂移的
 * 后果是"某个 DSH 版本上栏突然不见了"，最难查的一类。
 *
 * 所以：**名字、order、"哪一侧是回退"写在这里**，两个插件只提供自己的 id。
 */
export interface DockMountDecl {
  name: string;
  id: string;
  order: number;
}

/**
 * 栏的两个落点。
 *
 * * `overlay`：`shell.overlay` 槽位——DSH 原生三列布局的一侧，栏首选的落脚点；
 * * `fallback`：`conversation.input.left` 槽位——`shell.overlay` 在别人的 DSH 版本里可能不存在，
 *   所以用**已经在渲染**的输入框槽位兜底一个宿主。两个插件都注册它，形状必须完全一样。
 */
export const DOCK_SEATS = {
  /**
   * 主落点。两个插件原先各写一个 order（70 / 50）——这里统一成 70：两条条目挂的是**同一个**
   * `DockHost`，而栏的所有权由 `dock.tsx` 的全局 `liveHosts` 收着（第二个宿主发现栏已由活宿主
   * 占着就直接返回），所以它们之间的先后从来没有过可见效果。留着两个数只会让人以为它有意义。
   */
  overlay: {name: 'shell.overlay', order: 70},
  /** 回退宿主：同一根栏在另一个槽位里的落脚点，order 压在最后，不跟输入框自己那排按钮抢位置。 */
  fallback: {name: 'conversation.input.left', order: 999},
} as const;

/** 某个插件在某个落点上的挂载声明。`id` 由插件给（同一个槽位里两条条目的 id 必须不同）。 */
export function dockMount(seat: keyof typeof DOCK_SEATS, id: string): DockMountDecl {
  return {name: DOCK_SEATS[seat].name, id, order: DOCK_SEATS[seat].order};
}
