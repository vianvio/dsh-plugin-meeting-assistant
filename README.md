<div align="center">

# DSH 会议助手 🎙️

**在 DSH 里录下讨论，结合项目资料准备追问和回答。**

[安装](#安装) · [使用](#使用) · [项目资料与-ai](#项目资料与-ai) · [数据与边界](#数据与边界) · [开发](#开发)

[![npm](https://img.shields.io/npm/v/dsh-plugin-meeting-assistant?label=npm)](https://www.npmjs.com/package/dsh-plugin-meeting-assistant) · [![license](https://img.shields.io/badge/license-MIT-success)](LICENSE) · ![DSH](https://img.shields.io/badge/DSH-plugin-4B6BFB)

</div>

会议助手直接装进 DeepSeek Harness：聊天输入框旁的一个入口，完成会前准备、麦克风录音、实时转写和会中辅助。录音、文字与会议背景保存在本机，历史记录可以回看和导出。

它可以独立安装。录音与转写由本插件提供，会中建议结合当前项目、你的会议目标和最近讨论生成。

| 会前 | 会中 | 会后 |
| --- | --- | --- |
| 填写会邀和目标，按需润色 | 追问 / 回应 / 转写三个视图 | 回看录音、转写和分析记录 |
| 当前项目自动作为资料范围 | 收起面板、切换聊天仍继续录音 | 导出完整文字记录 |

## 安装

### 从 npm 装到 DSH

```bash
dsh plugin --profile desktop add dsh-plugin-meeting-assistant --registry=https://registry.npmjs.org/
```

`--profile` 填你实际使用的配置：桌面端通常是 `desktop`，Web 端是 `web`。这条命令从 npm 安装插件，并自动把它加入 profile 的 `dsh.profile.bundles`。

npm 包已带编译好的客户端和宿主代码，安装时无需克隆仓库或自己构建。**安装后完整退出并重新打开 DSH**，聊天输入框旁会出现「会议助手」，设置中会出现「会议语音」。

要求 DSH 提供 0.2.1 系列插件 API，具体 peer 范围见 [package.json](package.json)。本地验证环境为 macOS 上的 DSH Desktop 0.2.1-rc.5。

<details>
<summary>终端找不到 dsh 命令？</summary>

macOS 上，DeepSeek Harness 安装在 `/Applications` 时，可以直接使用应用内置命令：

```bash
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" plugin --profile desktop add dsh-plugin-meeting-assistant --registry=https://registry.npmjs.org/
```

</details>

### 升级

```bash
dsh plugin --profile desktop update dsh-plugin-meeting-assistant --registry=https://registry.npmjs.org/
```

升级后同样完整重启 DSH。前后端版本不一致时，会议面板会提示重新打开应用。

如果此前通过本地 `.tgz` 或 `link:` 安装，执行下面这条命令切换到 npm 版本：

```bash
dsh plugin --profile desktop add dsh-plugin-meeting-assistant@latest --registry=https://registry.npmjs.org/
```

### 卸载

```bash
dsh plugin --profile desktop remove dsh-plugin-meeting-assistant
```

## 使用

### 1. 配置转写服务

打开「设置 → 会议语音」，填写百炼 API Key，以及对应服务的流式 WebSocket 地址和模型名。地址与模型收在「服务地址与模型」中，也可以导入已有的 `.env` 或 JSON 配置。

插件使用 DashScope `run-task` 流式识别协议，请使用支持该协议的服务参数。转写服务按音频时长计费。

AI 建议和目标润色使用 DSH 的模型服务，配置方式见下方[项目资料与 AI](#项目资料与-ai)。

### 2. 准备会议

点击输入框旁的「会议助手」。会邀和会议目标直接展示，均可留空；角色与立场放在「更多背景」中。

当前会话所在项目自动作为资料范围，无需选择文件。填写目标后，可以点击「AI 润色」获取 2–3 个候选，选择并点击「采用」才替换原文。打开面板、打字和开始录音都不会自动润色。

### 3. 开始录音

点击「开始录音」时才申请麦克风权限。等待授权可以取消，之后迟到的授权也不会自动恢复已取消的录音。

录音中，面板顶部显示时长、音量与结束操作；主区域通过三个视图切换：

- **追问**：结合讨论和项目资料，查看可提出的问题及依据。
- **回应**：展开可能被问到的问题，查看简短或展开的回答参考。
- **转写**：查看逐句原文，按需加载更早的内容。

新建议到达时，点击「有新建议，点击查看」才切换版本，正在阅读的卡片会保留。自动分析可在右上角菜单调整，也可以手动更新或取消分析。取消只结束本次分析，录音继续。

### 4. 结束与回看

收起面板或切换聊天时，录音继续；点击「结束」才停止。每场会议属于发起录音的会话，全应用同时只录一场。

结束后停留在本场记录。右上角菜单提供历史记录、文字导出、会议背景和语音设置。也可以在原聊天里问“刚才讨论的结论是什么”，让 Agent 通过 `voice_log` 读取本会话的记录。

## 项目资料与 AI

项目目录是会议的默认资料范围。生成建议或润色目标时，插件才按会邀、目标和当前讨论检索相关内容，包括代码、文档、隐藏的 `.notes` 和 Word 文档；目录索引和内容片段有读取预算，依赖、构建目录和二进制内容会按规则跳过。

这表示整个项目可作为检索范围，不能等同于模型已经读完每个文件。每次生成会重新读取当前相关内容。旧会议中的文件快照仍可读取。

| 功能 | 模型路径 |
| --- | --- |
| 会中建议 | 当前主 Agent 在线且支持子 Agent 时，继承当前会话模型生成 |
| 会中建议的直调回落 | DSH 的 `deepseek-official / deepseek-flash` |
| 目标润色 | 用户点击后调用 DSH 的 `deepseek-official / deepseek-flash` |

需要在 DSH 配置相应的 DeepSeek 模型服务。建议只展示在面板中，由用户选择是否采用，不会自动代用户发言。

录音运行时支持短暂宿主重载后的接续。音频和停止请求遇到短暂路由不可用时会有限重试；取消分析会立即释放任务状态，迟到结果不会覆盖新的分析。

## 数据与边界

- **本机保存**：录音、转写、会前背景和分析记录默认位于 `~/.agent-mesh/voice`，可用 `MESH_VOICE_HOME` 更改。目录名沿用拆分前的位置，升级可以继续读取原有记录。
- **服务调用**：麦克风音频发送至配置的百炼转写服务；背景、相关项目片段和转写会交给对应的 DSH 模型服务。
- **凭据**：语音配置保存在本机，接口不回显密钥，配置文件权限为 `0600`。
- **音源**：当前直接采集麦克风，不直接采集系统声音；线上会议使用耳机时，需要自行确认麦克风能采到所需声音。
- **浏览器**：Web 端需要 HTTPS 或 localhost 等安全上下文，并允许访问麦克风。
- **中断恢复**：应用退出或刷新后停止采集，已落盘的音频与转写会保留；中断期间不会补录。部分音频未完成转写时，面板会提示。
- **诊断**：插件诊断日志默认在 `~/.agent-mesh/logs`。详细协议、上下文路径与恢复行为见 [设计说明](docs/VOICE.md)。

## 开发

使用 Node.js 24 和本仓库锁定的依赖：

```bash
git clone https://github.com/vianvio/dsh-plugin-meeting-assistant.git
cd dsh-plugin-meeting-assistant
npm ci
npm run check
```

本地开发安装：

```bash
dsh plugin --profile desktop add "link:$PWD"
npm run dev
```

客户端修改可由 DSH 的 HMR 接收；宿主代码修改或发版升级后，完整重启可以确认加载到同一版本。

```bash
npm run build       # 生成 lib/index.js 和 lib/client.js
npm test            # 先构建，再跑 Node 测试与 ASR 内核测试
npm run typecheck   # TypeScript 检查
npm run test:ui     # 可选：真实组件 + 模拟音频/RPC 的浏览器回归
```

`test:ui` 需要本机安装并连接 `browser-harness`；不请求真实麦克风或模型。源码目录、服务依赖与共享内核说明见 [开发与维护](docs/DEVELOPMENT.md)。

## 许可与来源

[MIT](LICENSE)。会议助手从 Agent Mesh 拆分为独立插件；共享层和语音内核的来源分别记录在 [src/shared/README.md](src/shared/README.md) 与 [src/vendor/voice-kernel/README.md](src/vendor/voice-kernel/README.md)。
