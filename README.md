# DSH 会议助手插件（dsh-plugin-meeting-assistant）

本机录音 + 实时转写 + 会前准备 + 会中发言建议。**独立插件仓库**：不依赖 Agent Mesh、平台连接、
Bridge，也不依赖任何别的 DSH 插件。

它原来是 `dsh-plugin-agent-mesh` 的一部分（0.2.0～0.6.0 之间的版本里都有）。第一次拆分（2026-10-29）
把它搬到 `slf/agent-mesh/desktop/plugins/plugin-meeting`，但它仍靠那个仓库的构建脚本、共享源码层
和测试夹具活着；这一次（本仓库）拆到底：构建、共享源码、`voice-kernel`、测试全部跟着走，仓库里
只剩它自己的东西。

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
| `src/client.tsx` → `lib/client.js`（会议开关、转写面板、语音设置） | 渲染进程 | `npm run dev` 重建 → DSH 的客户端插件 HMR 接收器接住 | **不用** |
| `src/index.ts`、`src/voice/*`（录音服务、ASR 连接、发言建议、`voice_log` 工具、RPC 通道） | DSH 宿主进程 | 宿主半是 ESM 一次导入的模块，DSH Desktop 又有意禁用了内部 loader 的缓存清理，没有任何重载路径 | **要** |

宿主半每次加载会打一行 `[meeting-assistant-host <ISO 时间>]`（走 stderr）。"现在跑的是哪一份代码"
有一个能直接看到的答案，不用猜：宿主把宿主子进程的 stdout 直接 pipe、没有落盘出口，所以那一行停在
启动它的终端里（插件自己另有一路诊断文件：`~/.agent-mesh/voice/` 下的 JSONL，见 `src/shared/diag-file.ts`）。

## 三个入口

| 入口 | 槽位 | 干什么 |
| --- | --- | --- |
| 输入框旁的开关（麦克风 + 「转写」） | `conversation.input.left` | 开始/结束录音，打开转写面板 |
| 侧栏那一根栏里的「会议」标签页 | `shell.overlay` → `DockHost` | 会前准备 / 实时转写 / 发言建议 |
| 设置里的「会议语音」 | `settings.section` | 百炼 API Key、WebSocket 地址、模型 |

侧栏那一根栏是**插件之间共用**的：名单挂在全局对象上（`src/shared/dock/dock-store.ts`），谁先
加载谁建，栏本身只有一个宿主。所以装了别的、也用这根栏的插件时，两边是同一根栏里的两个标签页；
**只装本插件时它照样开得出栏**——`DockHost` 不依赖任何别的插件。

## 数据放在哪

- 录音、转写、会前准备：`MESH_VOICE_HOME`，默认 `~/.agent-mesh/voice`。
- 语音识别凭据：同上目录下的配置文件，保存时落盘权限收紧（`0600`），接口回显时不含密钥。

目录名保留 `agent-mesh` 是**有意**的：改名会让已经录过的会议在升级后"消失"。共享的只有这一个
路径常量。

## 宿主半声明的服务

`export const inject = ['tools', 'connection', 'webServer', 'llm']`——`inject` 是加载门槛，少一个就在
加载阶段抛异常、整个 profile 起不来。

- `connection` + `webServer`：会议界面走一条 RPC 通道（`/meeting-assistant`），首选插件自己往
  `webServer` 挂前缀路由（用 DSH 自己的信任检查），失败才退回 `ctx.connection.rpc.handle`。DSH 把
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
| `test/meeting-coach.test.ts` | 会前准备与建议落盘：`.docx`/`.xlsx` 抽取、私有写入、建议解析 |
| `test/meeting-host-isolation.test.ts` | 只 import 宿主半**不许**执行插件入口的副作用（模块级日志与 20 秒看门狗） |
| `test/host-inject.test.ts` | 两半的 `inject` 与它们真正用到的服务对得上（漏一个就是整台机器起不来） |
| `test/plugin-routes.test.ts` | 注册自己的 `/meeting-assistant` 通道、不认调用方给的路径 |
| `test/client-entry.test.ts` | 客户端半的**源码**入口真的加载一次，并认领它广告的槽位 |
| `test/client-bundle.test.ts` | 客户端**产物**按 DSH 加载器跑一次，且只用 `inject` 里声明的服务 |
| `test/host-bundle.test.ts` | 宿主**产物**的导出（`name`/`inject`/`apply`/`hostBuild`）与注入的版本号 |
| `test/package-boundary.test.ts` | 源码里不许有仓库外的相对 import；manifest 里不许有 `file:` 依赖；产物里不许有别的插件的痕迹 |
| `test/import-graph.test.ts`、`test/client-boundary.test.ts`、`test/dock.test.ts` | 无环、客户端半不取 Node 内建、栏的落点与配色 |
| `test/voice-kernel/*.test.mjs` | vendored 内核：run-task 协议、断线重连、重喂查重、WAV 头 |

真实 ASR 的一轮生成需要凭据，不在 `npm test` 里（那台机器上没有百炼 Key）：

```bash
# 用 macOS 的 say + ffmpeg 合成一段语音，边录边读，把结果写进 .local/
node --import tsx scripts/voice-live.ts
```

会议功能的完整设计说明（转写链路、发言建议的两条后端、上下文注入的两条路径）见
[docs/VOICE.md](docs/VOICE.md)。

## 安装

插件的产物是两半 JS 加一条 cordis patch。装进某个 DSH profile：

```bash
npm pack                       # 得到 dsh-plugin-meeting-assistant-<version>.tgz
dsh plugin --profile <profile> add ./dsh-plugin-meeting-assistant-<version>.tgz
```

`dsh plugin add` 会写进 profile 的 dependencies 并自动挂到 `dsh.profile.bundles`，不需要别的安装器。
宿主半（`inject` 里的那四个服务）由 DSH 本体提供；识别后端要自己在设置里填百炼 API Key。
