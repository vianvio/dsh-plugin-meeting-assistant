/**
 * 会话消息 `source` 的构造与识别——**只有一套词表**（DSH 0.2 家族的会话格式 v4）。
 *
 * v4 的准入要求"生产者自有 kind"：`{kind:'plugin', plugin}` 被它明确拒收
 * （`dsh-session-format-v3-to-v4` 的 `source()`：*format v4 message requires a
 * producer-owned source kind*），每个生产者用自己的名字当 kind——宿主自己的包就是这么做的：
 * `dsh-tool-jobs` 发 `tool-jobs`、`dsh-session-title-llm` 发 `dsh-session-title-llm`。
 *
 * 这里上一版还有第二套词表（0.1.5 的 `{kind:'plugin', plugin}`）和"先送一套、宿主拒了就换
 * 另一套、然后把探到的那套记住"的探测。0.1.5 家族退役之后**只剩一套**：探测没有第二个候选，
 * 它唯一的效果是把真实错误变成一次多余的重试，所以整套删掉。
 */

/** 一条生产者自有的来源记录。`extras` 原样带上（`form` / `sections` / `summary` …）。 */
export function sourceFor(
  plugin: string,
  extras: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {kind: plugin, ...extras};
}

/**
 * 这条来源是不是 `plugin` 这个生产者发的。
 *
 * 读的一侧（宿主发来的消息）只认这一种写法：宿主自己的生产者（标题、模型切换、技能目录…）
 * 在 v4 里都用生产者自有 kind。判错一个的症状是"这个功能没出现"，不是报错。
 */
export function isProducerSource(source: unknown, plugin: string): boolean {
  if (!source || typeof source !== 'object') return false;
  return (source as {kind?: unknown}).kind === plugin;
}
