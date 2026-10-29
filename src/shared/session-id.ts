/**
 * 会话 id 的"品牌化"转换——**判据只有一份，而且不再为它 import 宿主包**。
 *
 * DSH 的 `SessionId(id)` 在类型层是"带上品牌的 string"，运行期则两代都是恒等：
 * `function SessionId(id){ return brandString(id) }`，而 `brandString` 返回同一个字符串
 * （0.1.5-rc.2 与 0.2.0-rc.2 实测逐字相同）。它却是这两个插件唯一一条"为了一个恒等转换去
 * import 宿主包"的边——去掉之后**运行期要宿主提供的包少一个**
 * （`plugin-agent-mesh/src/mesh/host-runtime.ts` 的那份清单跟着收窄）。
 *
 * 这条假设不能只写在注释里：`desktop/test/session-id-identity.test.ts` 对着两份真实宿主包
 * （装着的那份 0.1.5-rc.2 + 0.2.0-rc.2 的缓存）断言它仍然是恒等；哪天宿主给它加了校验或规范化，
 * 那条用例会红，而这里是唯一要改的地方。
 */

/**
 * 宿主 `SessionId` 的**结构替身**：运行期它就是 string，类型层只用来把"两种 id"分开。
 *
 * 用它替掉 `import type {SessionId} from '@deepseek-ai/dsh-session'`：那条 type-only import
 * 在"宿主没带声明"的安装上会变成 TS7016（见 `.pro-tester` 里那条阻塞发现）。
 */
export type SessionIdLike=string&{readonly __dshSessionId?:never};

/**
 * 把字符串当会话 id 用。
 *
 * 返回类型写成 `never` 是刻意的：调用点都是把它交给宿主的 `sessions.get(...)` / `agents.get(...)`，
 * 而 `never` 可以赋给任何参数类型——于是不必为了"品牌类型"再 import 一次宿主包。
 */
export function SessionId(id:string):never{
  return id as never;
}
