# 开发与维护

用户安装和使用步骤见 [README](../README.md)。本页说明源码组织、服务边界与验证方法。

## 仓库长什么样

| 目录 | 是什么 | 能不能改 |
| --- | --- | --- |
| `src/index.ts`、`src/voice/**` | 插件自己：宿主半入口、录音服务、ASR 连接、发言建议、`voice_log` 工具、RPC 通道、客户端界面 | 是，这是本仓的主体 |
| `src/shared/**` | 拆包时从 `agent-mesh/desktop/plugins/plugin-shared/` **拷进来的一份**（诊断、RPC 调用/通道、宿主作用域、dock、主题、宿主词表） | 谨慎：上游还有一份在 Agent Mesh 仓里，见下 |
| `src/vendor/voice-kernel/**` | 从 `agent-mesh/packages/voice-kernel` 拷进来的 ASR 协议与重连内核（`.mjs` + `.d.mts`） | 谨慎：同上，副本 |
| `test/**` | 单元测试（含 `test/voice-kernel/` 里那份内核单测） | 是 |
| `lib/**` | 构建产物（`npm run build` 生成，不进版本库） | 否 |

### 关于 `src/shared` 与 `src/vendor` 这两份副本

它们**不是依赖**，是源码复制：插件要能单独 checkout、单独 `npm install`、单独构建，所以不能对着
另一个仓库的相对路径 import。代价是同一份代码在两处演化——所以：

* 这两个目录**不跟着上游自动更新**。上游（Agent Mesh 仓）改了共享层，这里不会知道。
* 真要同步时，把上游的改动**手工搬过来**，然后跑 `npm test`：`test/package-boundary.test.ts` 会
  盯住"源码里不许出现仓库外的相对 import"，`test/host-inject.test.ts` 会盯住 inject 与共享层里
  真正用到的服务对得上。
* 副本的来处写在 `src/shared/README.md`、`src/vendor/voice-kernel/README.md`（含拆分时的上游提交）。

## 两半，与"改完怎么生效"

| 产物 | 跑在哪 | 改完怎么生效 | 要重启 DSH 吗 |
| --- | --- | --- | --- |
| `src/client.tsx` → `lib/client.js`（会议入口、会中面板、语音设置） | 渲染进程 | `npm run dev` 重建 → DSH 的客户端插件 HMR 接收器接住 | **不用** |
| `src/index.ts`、`src/voice/*`（录音服务、ASR 连接、发言建议、`voice_log` 工具、RPC 通道） | DSH 宿主进程 | 宿主半可能随 DSH 配置协调或 HMR 重新加载；发版升级后完整重启可确保前后端版本一致 | **要** |

宿主半每次加载会打一行 `[meeting-assistant-host <ISO 时间>]`（走 stderr）。"现在跑的是哪一份代码"
有一个能直接看到的答案，不用猜：宿主把宿主子进程的 stdout 直接 pipe、没有落盘出口，所以那一行停在
启动它的终端里（插件自己另有一路诊断文件：`~/.agent-mesh/logs/` 下的 JSONL，见 `src/shared/diag-file.ts`）。

## 统一入口与面板

| 入口 | 槽位 | 干什么 |
| --- | --- | --- |
| 输入框旁的「会议助手」 | `conversation.input.left` | 单一入口，打开面板；录音中显示红点与时长，打开和收起均不改变录音 |
| 侧栏中的会议面板 | `shell.overlay` → `DockHost` | 快速开始、值得追问、回应参考、可展开的转写和会议背景；更多菜单提供设置、历史和导出 |
| 设置里的「会议语音」 | `settings.section` | 百炼 API Key、WebSocket 地址、模型 |

侧栏那一根栏是**插件之间共用**的：名单挂在全局对象上（`src/shared/dock/dock-store.ts`），谁先
加载谁建，栏本身只有一个宿主。所以装了别的、也用这根栏的插件时，两边是同一根栏里的两个标签页；
**只装本插件时它照样开得出栏**——`DockHost` 不依赖任何别的插件。

开始录音前直接显示“会邀”和“会议目标”，均可留空；角色与立场在“更多背景”中填写。当前会话项目自动作为资料范围，无需选择文件。目标填写后可点击“AI 润色”获取候选，选择并点击“采用”才更新原文，打开面板、编辑文字和开始录音均不触发润色。

会中顶部只保留录音状态、时长与结束操作，下方通过“追问 / 回应 / 转写”切换内容；会议背景、自动分析和历史记录收在菜单。等待麦克风授权可以取消；取消后迟到的授权会释放音频流，不会自动恢复录音。新建议到达只提示，点击后才切换正在阅读的卡片。

## 数据放在哪

- 录音、转写、会前准备：`MESH_VOICE_HOME`，默认 `~/.agent-mesh/voice`。
- 语音识别凭据：同上目录下的配置文件，保存时落盘权限收紧（`0600`），接口回显时不含密钥。

目录名保留 `agent-mesh` 是**有意**的：改名会让已经录过的会议在升级后"消失"。共享的只有这一个
路径常量。

## 宿主半声明的服务

`export const inject = ['tools', 'connection', 'webServer', 'llm']`——`inject` 声明宿主依赖；缺少必要服务会阻止插件正常加载。

- `connection` + `webServer`：会议界面走一条 RPC 通道（`/meeting-assistant`），优先使用 `ctx.connection.rpc.handle`，
  受服务作用域隔离时退回插件前缀路由；信任检查沿用 DSH。DSH 把
  `webServer` 隔离了，只有**顶层 inject 声明过**的 fiber 看得见它，所以这条必须写在这里。
- `tools`：注册 `voice_log`（模型读会议记录的唯一入口）。
- `llm`：发言建议的直调回落路径（`src/voice/coach-model.ts` 的 `ctx.llm.stream`）用；cordis 的服务
  方法里 `this.ctx` 会换回**调用方**的 ctx，被调服务内部读什么，调用方就得声明什么。
- **故意不声明** `agents` / `subagents`：发言建议优先 fork 一个子 agent，但部署里没有 subagent 供给
  时应该回落到单次直调，而不是整个插件加载不了。运行时探测，见 `src/voice/coach-model.ts`。

`test/host-inject.test.ts` 按宿主半的 import 闭包扫一遍 `ctx.<服务>`，与这份 `inject` 对不上就红。

## 测试

```bash
npm install        # 装 devDependencies（DSH 那几个包钉在 0.2.1-rc.4：peer 范围是给"装插件的那台机器"看的，
                   #   dev 里钉死同一代，npm 自动补 peer 时才不会与 devDeps 互相打架）
npm run build      # 打 lib/index.js + lib/client.js
npm test           # pretest 会先 build；跑 test/*.test.ts 与 test/voice-kernel/*.mjs
npm run typecheck  # tsc --noEmit
npm run check      # 上面两个一起
```

| 文件 | 覆盖 |
| --- | --- |
| `test/voice.test.ts` | 重采样/PCM、配置隐私与 TLS 强制、录音生命周期、RPC 重试去重、会话隔离、`voice_log` 只读工具 |
| `test/voice-context.test.ts` | 转写上下文注入：快照边界、role/source/form、节流、收尾必推、无 live agent 静默跳过 |
| `test/voice-advice-backend.test.ts` | 发言建议的两条后端：schema 强制子集、agent 路径的父级与 schema、停止原因映射、run 必 dispose、回落直调 |
| `test/meeting-capture.test.ts` | 麦克风启动阶段、取消与迟到授权、服务收尾顺序、设备错误与幂等停止（模拟音频，不申请真实权限） |
| `test/meeting-coach.test.ts` | 会前准备与建议落盘、自动生成与取消、建议解析 |
| `test/project-context.test.ts` | 项目资料懒加载、代码与隐藏目录、相关片段预算、越界链接、最新内容与旧资料兼容 |
| `test/goal-polish.test.ts` | 显式目标润色、候选格式与错误处理、超时、按录音项目取资料且不自动写回 |
| `test/meeting-host-isolation.test.ts` | 只 import 宿主半**不许**执行插件入口的副作用（模块级日志与 20 秒看门狗） |
| `test/host-inject.test.ts` | 两半的 `inject` 与它们真正用到的服务对得上（漏一个就是整台机器起不来） |
| `test/plugin-routes.test.ts` | 注册自己的 `/meeting-assistant` 通道、不认调用方给的路径 |
| `test/client-entry.test.ts` | 客户端半的**源码**入口真的加载一次，并认领它广告的槽位 |
| `test/client-bundle.test.ts` | 客户端**产物**按 DSH 加载器跑一次，且只用 `inject` 里声明的服务 |
| `test/host-bundle.test.ts` | 宿主**产物**的导出（`name`/`inject`/`apply`/`hostBuild`）与注入的版本号 |
| `test/package-boundary.test.ts` | 源码里不许有仓库外的相对 import；manifest 里不许有 `file:` 依赖；产物里不许有别的插件的痕迹 |
| `test/compat-session-v4.test.ts` | 真的注入消息必须能被会话格式 v4 的编码器接受（`kind:'plugin'` 那套写法仍被拒收） |
| `test/import-graph.test.ts`、`test/client-boundary.test.ts`、`test/dock.test.ts` | 无环、客户端半不取 Node 内建、栏的落点与配色 |
| `test/voice-kernel/*.test.mjs` | vendored 内核：run-task 协议、断线重连、重喂查重、WAV 头 |

界面流程可独立回归（需本机已安装 `browser-harness` 并连接调试浏览器）：

```bash
npm run test:ui
```

该命令只在本机回环地址启动临时页面，直接加载真实会议组件，模拟音频设备和服务。它检查会邀与目标的引导、显式润色与候选采纳、旧结果失效、会中三个视图、统一入口、收起/切换会话继续录音、新建议显式切换、权限取消/迟到授权与配置恢复，不请求真实麦克风或模型。普通 `npm test` 无需浏览器。

真实 ASR 的一轮生成需要凭据，不在 `npm test` 里（那台机器上没有百炼 Key）：

```bash
# 用 macOS 的 say + ffmpeg 合成一段语音，边录边读，把结果写进 .local/
node --import tsx scripts/voice-live.ts
```

会议功能的完整设计说明（转写链路、发言建议的两条后端、上下文注入的两条路径）见
[docs/VOICE.md](docs/VOICE.md)。
