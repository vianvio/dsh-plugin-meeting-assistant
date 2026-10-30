/** Shared client RPC calls: one deadline, opt-in route recovery, and one final result. */
import {describeRpcFailure, isRetryableRpcFailure} from './rpc-error.js';
import {logRpc, type DiagLog} from './diag.js';

export interface RpcResult {
  ok: boolean;
  value?: unknown;
  error?: {message: string};
}

export interface RpcTransport {
  call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<RpcResult>;
}

export interface RpcRetryOptions {
  /** Exact endpoint names whose requests the caller knows are safe to repeat. */
  endpoints: readonly string[];
  /** One wait before each additional attempt; an empty list disables retries. */
  delaysMs: readonly number[];
}

export interface RpcCallOptions {
  transport: RpcTransport;
  channel: string;
  label: string;
  marker: string;
  diag: DiagLog;
  /** Total time for the request, including every attempt and retry wait. */
  defaultDeadlineMs: number;
  deadlines?: Record<string, number>;
  /** Disabled by default. Only thrown HTTP 404/405/502/503 failures qualify. */
  retry?: RpcRetryOptions;
}

export function rpcDeadlineMs(endpoint: string, options: Pick<RpcCallOptions, 'defaultDeadlineMs' | 'deadlines'>): number {
  return options.deadlines?.[endpoint] ?? options.defaultDeadlineMs;
}

/** Enforce the deadline even when a transport does not observe its signal. */
function withAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let onAbort!: () => void;
  const cancellation = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, {once: true});
    if (signal.aborted) onAbort();
  });
  return Promise.race([operation, cancellation]).finally(() => signal.removeEventListener('abort', onAbort));
}

async function retryWait(delayMs: number, signal: AbortSignal): Promise<void> {
  let timer!: ReturnType<typeof setTimeout>;
  try {
    await withAbort(new Promise<void>(resolve => { timer = setTimeout(resolve, delayMs); }), signal);
  } finally {
    clearTimeout(timer);
  }
}

export function createRpcCall(options: RpcCallOptions): (endpoint: string, payload?: unknown) => Promise<any> {
  const {transport, channel, label, marker, diag, retry} = options;
  const retryEndpoints = new Set(retry?.endpoints);
  const retryDelays = [...(retry?.delaysMs ?? [])];
  if (retryDelays.some(delay => !Number.isSafeInteger(delay) || delay < 0 || delay > 2_147_483_647)) {
    throw new RangeError('RPC retry delays must be nonnegative timer-safe integers');
  }
  return async (endpoint, payload = {}) => {
    const started = Date.now();
    const controller = new AbortController();
    const {signal} = controller;
    const timer = setTimeout(() => controller.abort(new DOMException('RPC request timed out', 'TimeoutError')), rpcDeadlineMs(endpoint, options));
    const delays = retryEndpoints.has(endpoint) ? retryDelays : [];
    let result: RpcResult;
    try {
      for (let attempt = 0; ; attempt++) {
        signal.throwIfAborted();
        try {
          result = await withAbort(transport.call(channel, endpoint, payload, signal), signal);
          break;
        } catch (error) {
          if (signal.aborted) throw signal.reason;
          const delayMs = delays[attempt];
          if (delayMs === undefined || !isRetryableRpcFailure(error)) throw error;
          diag.warn('rpc', `${endpoint} 暂时不可用，等待重试`, {retry: attempt + 1, delayMs, error: error instanceof Error ? error.message : String(error)});
          await retryWait(delayMs, signal);
        }
      }
    } catch (error) {
      const failure = describeRpcFailure(error, {label, channel, endpoint, marker});
      logRpc(diag, endpoint, {ok: false, ms: Date.now() - started, error: failure.message});
      throw failure;
    } finally {
      clearTimeout(timer);
    }
    // Application failures are responses, not route failures, even if their text mentions HTTP.
    if (!result.ok) {
      const message = result.error?.message ?? `${channel}/${endpoint} 失败`;
      logRpc(diag, endpoint, {ok: false, ms: Date.now() - started, error: message});
      throw new Error(message);
    }
    logRpc(diag, endpoint, {ok: true, ms: Date.now() - started});
    return result.value;
  };
}
