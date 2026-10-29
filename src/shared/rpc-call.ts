/**
 * 客户端半 → 宿主半的那一次 `rpc.call`：**只有这一份实现**。
 *
 * 两个插件的客户端半各写了一遍同样的十来行（取 deadline、翻译错误、记一行日志、拆 `result.ok`），
 * 只有一份带 deadline——于是同一个"传输卡住了"在会议助手那里 30 秒后给出一句话，在 mesh 那里
 * 永远不返回：输入框旁的开关停在 `busy` 的"连接中…"且一直 disabled（`finally` 永远不会执行），
 * 日志同步的 `syncing` 也再不释放，只能刷新页面。
 *
 * 三个后果都在这里一次做完，调用方只给"这条通道是谁"：
 *
 * * **每一条调用都带上限**（`AbortSignal.timeout`）——上限是必须的，不是可选优化；
 * * 失败翻译成能照着做的提示（`describeRpcFailure`）；
 * * 每次调用记一行（成功限流、失败逐条），诊断报告里的 `rpc` 那一类就是它。
 */
import {describeRpcFailure} from './rpc-error.js';
import {logRpc, type DiagLog} from './diag.js';

/** 宿主半的 RPC 结果：`ok:false` 时 `error.message` 是给人看的那句话。 */
export interface RpcResult {
  ok: boolean;
  value?: unknown;
  error?: {message: string};
}

/** 只要 `call` 这一个方法：`ctx.connection.rpc` 满足它，测试里的替身也满足它。 */
export interface RpcTransport {
  call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<RpcResult>;
}

export interface RpcCallOptions {
  transport: RpcTransport;
  /** 逻辑通道，例如 `/agentmesh`。 */
  channel: string;
  /** 这条通道属于哪个插件，用于错误提示，例如 `Agent Mesh`。 */
  label: string;
  /** 宿主半加载时往 stderr 打的那一行前缀。 */
  marker: string;
  diag: DiagLog;
  /** 默认上限（毫秒）。**必填**：没有上限的调用会把界面卡死，不给默认值。 */
  defaultDeadlineMs: number;
  /** 少数需要更久的端点。例外写在这里，而不是把默认值调大。 */
  deadlines?: Record<string, number>;
}


/** 这条端点该用哪个上限。默认值不是"随便挑一个"：调用方必须显式给出。 */
export function rpcDeadlineMs(endpoint: string, options: Pick<RpcCallOptions, 'defaultDeadlineMs' | 'deadlines'>): number {
  return options.deadlines?.[endpoint] ?? options.defaultDeadlineMs;
}

/**
 * 造一个 `call`：调用方拿到的是一个 `(endpoint, payload) => Promise<value>`。
 *
 * `AbortSignal.timeout()` 到点会让 `transport.call` 抛出来（`The operation was aborted due to
 * timeout`），这里把它连同"通道没人接"一起交给 `describeRpcFailure` 翻译——**超时不是
 * "宿主半没上线"**，两者给人指的方向不同。
 */
export function createRpcCall(options: RpcCallOptions): (endpoint: string, payload?: unknown) => Promise<any> {
  const {transport, channel, label, marker, diag, defaultDeadlineMs, deadlines} = options;
  return async (endpoint, payload = {}) => {
    const started = Date.now();
    let result: RpcResult;
    try {
      result = await transport.call(channel, endpoint, payload, AbortSignal.timeout(rpcDeadlineMs(endpoint, {defaultDeadlineMs, deadlines})));
    } catch (error) {
      /**
       * 传输层自己抛错（通道没人接的 HTTP 405、`AbortSignal` 超时……）这一支**也必须留痕**。
       *
       * 以前这里直接抛出去，一条日志都不写——于是 `diag.ts` 立项起因的那次事故（界面上只有一句
       * `transport failure for /agentmesh/panel/state: HTTP 405`、报告里什么都没有）会**原样重演**：
       * 用户看到的那一句来自这里，而它恰恰是唯一没被记下来的一类失败。
       *
       * 两件事按顺序做，顺序不能换：
       *  1. 先取翻译后的 `message`，再记日志——日志里那句和用户看到的那句必须是**同一条**，
       *     否则报告与界面各说各话，对不上号；
       *  2. 抛的还是 `describeRpcFailure` 返回的那个错误对象本身（类型、message、堆栈都不变），
       *     所以这次改动对外只多了一行日志。
       */
      const failure = describeRpcFailure(error, {label, channel, endpoint, marker});
      logRpc(diag, endpoint, {ok: false, ms: Date.now() - started, error: failure.message});
      throw failure;
    }
    if (!result.ok) {
      const message = result.error?.message ?? `${channel}/${endpoint} 失败`;
      logRpc(diag, endpoint, {ok: false, ms: Date.now() - started, error: message});
      throw new Error(message);
    }
    logRpc(diag, endpoint, {ok: true, ms: Date.now() - started});
    return result.value;
  };
}
