/**
 * 会议助手插件——宿主半。
 *
 * 这个包原来长在 `dsh-plugin-agent-mesh` 里面。拆出来的理由不是"分层好看"，而是**装的人不一样**：
 * Agent Mesh 是把对话经平台 WSS 接到另一台机器的 Bridge 算力上，而会议助手只是本机的
 * 录音 + 转写 + 发言建议，跟座席一点关系都没有——想用哪个的时候，不该被迫把另一个也装上。
 *
 * 拆开之后两边各有一个"现在跑的是哪一份代码"的答案（宿主半不热更新，唯一能看到的证据就是启动时
 * 那行 stderr 日志），所以这个包有自己的构建标记，格式与 mesh 那份一致，日志里一眼能分辨。
 */
import { fileURLToPath } from 'node:url';
import type { Context } from '@deepseek-ai/cordis';
import { bundleMtime, describeHostBuild } from './shared/host-build.js';
import { installVoice } from './voice/host.js';

export const name = 'meeting-assistant';
/**
 * 这个插件**不**声明 `agents` / `subagents`：inject 是加载门槛，声明它们会让"没有组合 subagent
 * 供给方的部署"整个插件都加载不了，而发言建议只是**优先**用它（见 `voice/coach-model.ts`：每一轮
 * 生成时探测，缺任一个就回落到直调）。
 *
 * `connection` 与 `webServer` **不再声明**：会议界面那条通道由 `installRpcChannel()` 装——首选
 * 插件自己往 webServer 上挂前缀路由（用 DSH 自己的信任检查），失败才退回 `connection.rpc.handle`。
 * 以前声明这两个是为了让 connection 的 owner 绑定能走到 webServer，代价是服务晚到/缺失时 cordis
 * 只会静默等待：插件永远不加载，界面上只剩一句 `HTTP 405`（别人机器上就是这样）。
 *
 * `tools` 也要声明：这个插件注册 `voice_log`（模型读会议记录的唯一入口）。这一条是**拆包时才暴露
 * 出来的**——以前它是跟 mesh 挤在同一个 `inject` 里，蹭到了那边的 `tools`；拆开之后漏了它，别的
 * 机器上就是"会议助手装了但工具没上"，而这里一条测试当场变红（test/host-inject.test.ts）。
 */
// `connection`/`webServer` 必须在这里：DSH 把 webServer 隔离了，只有顶层声明过的 fiber 才看得见它
// （子 context 上读不到）。代价是服务缺失时 cordis 会静默等待，所以下面有加载看门狗把它变成一条日志。
// `llm` 是发言建议直调回落路径（`voice/coach-model.ts` 的 `ctx.llm.stream`）用的：cordis 的服务方法里
// `this.ctx` 会换回**调用方**的 ctx（access tracking），所以被调服务内部读什么，调用方就得声明什么——
// 0.1.5 上 `ctx.modelDirectories.directoryFor()` 的 `remote.session` 就是这么炸的（见 plugin/src/client.tsx）。
export const inject = ['tools', 'connection', 'webServer', 'llm'];
import { diag } from './voice/host-diag.js';
import { attachDiagnostics } from './shared/diag-file.js';
/** 与 mesh 那份同样的用意：一行日志回答"这次重启到底加载了哪一份"。 */
const BUILD_MARKER = `meeting-assistant-host ${new Date().toISOString()}`;
/** 这一半的诊断日志：关键路径都写，出事时能还原"装上了没有、通道注册上没有"。 */
export { diag };
diag.info('load', '宿主半模块已加载', {bundlePath: import.meta.url});
/** 同 mesh：模块加载了但 apply 迟迟没跑 = inject 闸门没满足，这是最难查的状态，必须留一行。 */
let applied = false;
setTimeout(() => { if (!applied) diag.error('load', `模块加载后 20 秒仍未开始 apply：inject 未满足（需要 ${inject.join('+')}）`); }, 20_000).unref?.();
const BUNDLE_PATH = (() => { try { return fileURLToPath(import.meta.url); } catch { return ''; } })();
const LOADED_AT = Date.now();
const LOADED_MTIME = bundleMtime(BUNDLE_PATH);
/** 运行中的宿主半的新鲜度（面板/日志口径统一，mesh 那份在 `/agentmesh` 的 `host/build` 上暴露）。 */
export const hostBuild = () => describeHostBuild({ marker: BUILD_MARKER, bundlePath: BUNDLE_PATH, loadedAt: LOADED_AT, loadedMtime: LOADED_MTIME });

export function apply(ctx: Context) {
  applied = true;
  // 诊断出口：宿主日志服务 + 本地 JSONL（判据见 `plugin-shared/diag-file.ts`）。
  // 会议助手会去连外部 ASR 服务，出事时"它到底说了什么"只能在落盘的那一份里找。
  const diagnosis = attachDiagnostics(diag, ctx);
  diag.info('load', '诊断出口已接上', {hostLogger: diagnosis.host, file: diagnosis.file ?? null});
  console.warn(`[${BUILD_MARKER}]`);
  diag.info('load', 'apply 开始', {inject, node: process.version});
  // 装不上就**只**损失这个插件：捕获并大声记录，绝不让加载阶段抛出去——真事故里一次加载异常就把
  // DSH Desktop 带进了安全模式，而安全模式里连卸载入口都用不了，用户被困住。
  try {
    installVoice(ctx);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    (ctx as { logger?: { error?: (message: string) => void } }).logger?.error?.(`[meeting-assistant] 会议模块加载失败，该插件不可用（其余插件不受影响）：${reason}`);
    diag.error('load', '会议模块加载失败', {error: reason});
  }
}
