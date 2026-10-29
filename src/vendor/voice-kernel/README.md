# Voice kernel（`src/vendor/voice-kernel/`）

2026-09-10 从用户提供的 `realtime-voice-recorder/lib` 引入流式 ASR、重连去重及 WAV 封装，原项目保持不变。
DSH 插件在构建时打包此能力层；不依赖 Pi 或 ffmpeg。麦克风由桌面的 Web Audio 采集，ASR 的鉴权 WebSocket
由桌面 Host 提供。

保留原有单测，并补充嵌入桌面需要的停止竞态、末句时间戳、长断线缓冲回放测试。

## 这份副本的来处

2026-10-29 拆成独立插件仓库时，从上游拷进来：

| 项 | 值 |
| --- | --- |
| 上游仓库 | `slf/agent-mesh`（本机 `~/Documents/projects/slf/agent-mesh`） |
| 上游路径 | `packages/voice-kernel/` |
| 拆分时上游提交 | `c3801e39fbe28d7787d8d1fa59e64a85de74708f` |
| 单测去向 | 上游 `test/unit/*.test.mjs` → 本仓 `test/voice-kernel/`（说明符指回 `src/vendor/voice-kernel/*.mjs`） |

它是**源码副本**，不是包：这一层没有 `package.json`（`test/package-boundary.test.ts` 盯着这一条），
所以不会被误当成依赖挂进 manifest。上游改了这里不会自动更新——同步时手工搬，然后跑
`npm run test:voice-kernel`。

```bash
npm run test:voice-kernel
```
