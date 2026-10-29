# `src/shared/` —— 从 Agent Mesh 仓拷进来的共享层

这里是**源码副本**，不是依赖。插件要能单独 checkout、单独 `npm install`、单独构建，所以这些文件
必须躺在自己的仓库里；代价是同一份代码在上游还有一份，两处会各自演化。

## 来处

| 项 | 值 |
| --- | --- |
| 上游仓库 | `slf/agent-mesh`（本机 `~/Documents/projects/slf/agent-mesh`） |
| 上游路径 | `desktop/plugins/plugin-shared/` |
| 拆分时上游提交 | `c3801e39fbe28d7787d8d1fa59e64a85de74708f`（2026-10-27T18:43:42+08:00） |
| 拆分时间 | 2026-10-29 |

## 拷了哪些、各自干什么

| 文件 | 干什么 | 谁在用 |
| --- | --- | --- |
| `diag.ts` | 进程内的环形诊断日志（分来源、按键去重、敏感值脱敏） | 两半都用 |
| `diag-file.ts` | 诊断日志的落盘出口（`MESH_DIAG_DIR`，默认 `~/.agent-mesh/logs/`）与宿主 logger 接入 | 宿主半 |
| `host-build.ts` | 构建标记与"现在跑的是哪一份产物" | `src/index.ts` |
| `host-scope.ts` | 在声明了 `connection`+`webServer` 的作用域里做事 | 宿主半 |
| `host-source.ts` | 宿主自己的 message source 词表（判断一条消息是不是我们发的快照） | 上下文注入 + 测试 |
| `rpc-call.ts` | 客户端一侧的 RPC 调用：超时、错误翻译、日志一行 | 客户端半 |
| `rpc-channel.ts` | 宿主一侧的通道注册：优先宿主 `connection.rpc.handle`，被隔离就自己挂 `webServer` 路由 | 宿主半 |
| `rpc-error.ts` | RPC 失败的上游错误翻译（只被 `rpc-call.ts` 用） | 客户端半 |
| `right-panel.ts` | 面板进场前让出右侧栏 | 客户端半 |
| `session-id.ts` | `SessionId` 的类型身份与运行时夹具（不依赖宿主的声明） | 宿主半 |
| `theme.ts` | 颜色只取自 DSH 主题变量或 `inherit`（理由见文件头） | 客户端半 |
| `dock/dock-store.ts` | 栏的名单：挂在全局对象上，多个插件看到同一个实例 | 客户端半 |
| `dock/dock.tsx` | 栏本身（`DockHost`） | 客户端半 |
| `dock/dock-layout.ts` | 栏落在网格哪一行 + 配色 | `dock.tsx` + 测试 |
| `dock/mounts.ts` | 两个落点的形状（`shell.overlay` / `conversation.input.left`） | 客户端半 + 测试 |

**没拷的**（上游有、这里用不到）：`panel-boundary.tsx`（Agent Mesh 的面板边界）。

## 怎么同步

1. 在上游改完、跑完上游测试；
2. 把改动**手工搬**到这里（不是软链、不是 `file:` 依赖——那会把两个仓库重新绑死）；
3. 跑本仓的 `npm run check`。

守卫：

* `test/package-boundary.test.ts` —— 源码里不许出现指向上游的相对 import；
* `test/host-inject.test.ts` —— 这些文件里真正用到的 `ctx.<服务>`，必须在这一半的 `inject` 里；
* `test/dock.test.ts`、`test/client-boundary.test.ts` —— 栏的形状与客户端半的边界。
