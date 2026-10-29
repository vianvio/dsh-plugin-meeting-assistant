/**
 * 画在 DSH 地盘上的东西，颜色只能来自两个地方之一：**DSH 的主题变量**，或者**继承**。
 *
 * 两条规矩都是踩出来的：
 *
 *  1. **变量名会随版本改，所以写进来之前必须对着真实的 DSH 包核一遍。** 下面这三个名字在
 *     0.1.5 家族（`0.1.2-rc.1`、`0.1.3-alpha.2`、`0.1.5-rc.2`）与 0.2.0-rc.2 各自的
 *     `dsh-client-ui-theme` 里都是**声明过**的（`--dsw-…:`）。
 *     以前每个名字还配了一个"另一个版本的叫法"——`--dsw-alias-bg-primary`、
 *     `--dsw-alias-text-primary`、`--dsw-alias-border-secondary`。实测那三个名字在
 *     0.1.2-rc.1 / 0.1.3-alpha.2 / 0.1.5-rc.2 / 0.2.0-rc.2 里**一次都没有声明过**：
 *     备选链上有一半是死的，读起来却像"两个版本都兼容"，而且原注释把版本说反了
 *     （并不是 0.1.5 把 `text-primary` 改名成了 `label-primary`——`label-primary` 从头就是这个名）。
 *     死的那一半已删除；`desktop/test/theme-vars-exist.test.ts` 拿这条规矩盯着这个文件，
 *     将来 DSH 改名时它会红，而不是静默退化成 `inherit`。
 *  2. **兜底绝不用系统色**。`Canvas`/`CanvasText` 跟着 macOS 外观走，而 DSH 的主题是独立的：浅色外观 +
 *     暗色主题就是"黑字画在黑底上"（面板"什么都看不见"的第二个独立成因）；反过来深色外观 + 浅色主题
 *     就是"白底浅字"。兜底用 `inherit`——画在谁的地盘上，就继承谁的颜色。
 *
 * 这条规矩对两个插件一样有效，所以放在共享目录，而不是各自的 UI 文件里。
 */
export const THEME = {
  background: 'var(--dsw-alias-bg-base,inherit)',
  color: 'var(--dsw-alias-label-primary,inherit)',
  borderColor: 'var(--dsw-alias-border-l3,#8883)',
  border: '1px solid var(--dsw-alias-border-l3,#8883)',
} as const;
