/**
 * 栏落在网格的哪一行。
 *
 * 抽成纯函数是因为它**踩过一次真坑**：面板被硬编码成 `grid-row:1`，而 DSH 0.1.2 的壳是"一行三列"，
 * 0.1.5 起 `.dshDesktopFrame` 变成了**两行**（实测 `rows:"32px 917px"`：32px 表头 + 内容）。于是
 * `grid-row:1` 把整个面板塞进那条 32px 的表头行，配上我们自己的 `height:100%` 与 `overflow:hidden`，
 * 97 个节点的内容全被裁掉——报告里那句"面板是黑的"，实际是"面板只占了最上面 32px 的一条缝"。
 *
 * 判据不看 DSH 的类名（那东西每个版本都在变），只看**网格自己**：跑一维行轨道，取最高的那一行。
 * `auto`/`1fr` 这类没有 px 值的轨道视为无限高（内容行一定是它），并列时取靠前的。
 */
import { THEME } from '../theme.js';

export function dockRowFor(rows: string): number {
  const tracks = rows.trim().split(/\s+/).filter(Boolean);
  if (tracks.length <= 1) return 1;
  let best = 0;
  let bestHeight = -1;
  tracks.forEach((track, index) => {
    const pixels = /^(\d+(?:\.\d+)?)px$/.exec(track);
    // 表头的 32px 是 px；内容行可能是 1fr/auto/`minmax(...)`——那些一定比固定 px 高。
    const height = pixels ? Number(pixels[1]) : Number.POSITIVE_INFINITY;
    if (height > bestHeight) { bestHeight = height; best = index; }
  });
  return best + 1;
}

/** 颜色统一取自共享的 `THEME`（备选变量名 + `inherit` 兜底，理由见那个文件）。 */
export const DOCK_COLORS = {background: THEME.background, color: THEME.color, border: THEME.border} as const;
