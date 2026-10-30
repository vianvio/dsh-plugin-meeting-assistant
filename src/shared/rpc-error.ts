/** Translate a failed call without inferring whether the host has ever loaded. */
export interface RpcFailureHint {
  label: string;
  channel: string;
  endpoint: string;
  /** Retained for callers that also use the host's diagnostic marker. */
  marker: string;
}

function failureText(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') return error.message;
  return String(error);
}

function failureName(error: unknown): string {
  return error && typeof error === 'object' && 'name' in error ? String(error.name) : '';
}

function httpStatus(error: unknown): number | undefined {
  if (error && typeof error === 'object') {
    const fields = error as {status?: unknown; statusCode?: unknown};
    const status = fields.status ?? fields.statusCode;
    if (typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599) return status;
  }
  const match = /\bHTTP\s*(\d{3})\b/i.exec(failureText(error));
  return match ? Number(match[1]) : undefined;
}

function timedOut(error: unknown): boolean {
  return failureName(error) === 'TimeoutError' || /\btimeout\b|timed out/i.test(failureText(error));
}

function aborted(error: unknown): boolean {
  return failureName(error) === 'AbortError' || /\babort(?:ed)?\b|\bcancel(?:led|ed)\b/i.test(failureText(error));
}

/** Only explicit route/proxy failures may be retried, never an uncertain timeout. */
export function isRetryableRpcFailure(error: unknown): boolean {
  if (timedOut(error) || aborted(error)) return false;
  const status = httpStatus(error);
  return status === 404 || status === 405 || status === 502 || status === 503;
}

export function describeRpcFailure(error: unknown, hint: RpcFailureHint): Error {
  const status = httpStatus(error);
  let message = failureText(error);
  if (timedOut(error)) {
    message = `${hint.label}请求超时，请稍后重试。`;
  } else if (aborted(error)) {
    message = `${hint.label}请求已取消。`;
  } else if (status === 401 || status === 403) {
    message = `${hint.label}连接校验失败（HTTP ${status}），请重新连接。`;
  } else if (isRetryableRpcFailure(error)) {
    message = `${hint.label}服务通道暂时不可用（HTTP ${status}），请稍后重试。`;
  } else if (status !== undefined) {
    message = `${hint.label}请求失败（HTTP ${status}），请稍后重试。`;
  } else if (/transport failure/i.test(message)) {
    message = `${hint.label}连接暂时不可用，请稍后重试。`;
  }
  return new Error(message, {cause: error});
}
