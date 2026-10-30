import assert from 'node:assert/strict';
import test, {type TestContext} from 'node:test';
import {createRpcCall, type RpcCallOptions, type RpcResult} from '../src/shared/rpc-call.js';
import {describeRpcFailure, isRetryableRpcFailure} from '../src/shared/rpc-error.js';
import type {DiagLog} from '../src/shared/diag.js';

type Seen = {channel: string; endpoint: string; payload: unknown; signal: AbortSignal; at: number};
type Log = {kind: 'warn' | 'success'; message: string; data?: Record<string, unknown>};
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
const routeError = (status = 405) => new Error(`transport failure for /meeting-assistant/audio: HTTP ${status}`);
const retry = {endpoints: ['audio', 'stop', 'status'], delaysMs: [100, 200, 400]};

function fixture(t: TestContext, respond: (request: Seen, attempt: number) => Promise<RpcResult>, options: Partial<RpcCallOptions> = {}) {
  t.mock.timers.enable({apis: ['setTimeout', 'Date'], now: 100_000});
  const seen: Seen[] = [], logs: Log[] = [];
  const diag = {
    warn(_scope: string, message: string, data?: Record<string, unknown>) { logs.push({kind: 'warn', message, data}); },
    infoThrottled(_key: string, _scope: string, message: string, data?: Record<string, unknown>) { logs.push({kind: 'success', message, data}); },
  } as unknown as DiagLog;
  const call = createRpcCall({
    channel: '/meeting-assistant', label: '会议助手', marker: '[meeting-assistant-host test]',
    defaultDeadlineMs: 5_000, ...options, diag,
    transport: {call(channel, endpoint, payload, signal) {
      assert.ok(signal);
      const request = {channel, endpoint, payload, signal, at: Date.now()};
      seen.push(request);
      return respond(request, seen.length);
    }},
  });
  return {call, seen, logs};
}

async function advance(t: TestContext, ms: number) {
  t.mock.timers.tick(ms);
  await turn();
}

test('retries are disabled by default and a final failure keeps its original cause', async t => {
  const original = routeError();
  const f = fixture(t, async () => { throw original; });
  await assert.rejects(f.call('audio', {sequence: 0}), (error: Error) => {
    assert.equal(error.cause, original);
    assert.match(error.message, /通道暂时不可用.*HTTP 405/);
    return true;
  });
  await advance(t, 10_000);
  assert.equal(f.seen.length, 1);
  assert.equal(f.seen[0]!.signal.aborted, false, 'a settled call clears its deadline');
  assert.equal(f.logs.length, 1);
  assert.match(f.logs[0]!.message, /audio 失败/);
});

test('an allowed endpoint recovers after the configured delay with the same payload and signal', async t => {
  const f = fixture(t, async (_request, attempt) => {
    if (attempt === 1) throw routeError();
    return {ok: true, value: {accepted: true}};
  }, {retry});
  const payload = {token: 'mock-token', sequence: 7, pcm: 'AAAA'};
  const pending = f.call('audio', payload);
  await turn();
  await advance(t, 99);
  assert.equal(f.seen.length, 1);
  await advance(t, 1);
  assert.deepEqual(await pending, {accepted: true});
  assert.deepEqual(f.seen.map(request => request.at), [100_000, 100_100]);
  for (const request of f.seen) {
    assert.equal(request.channel, '/meeting-assistant');
    assert.equal(request.endpoint, 'audio');
    assert.equal(request.payload, payload);
    assert.equal(request.signal, f.seen[0]!.signal);
  }
  assert.equal(f.logs.filter(log => log.kind === 'success').length, 1);
  assert.equal(f.logs.filter(log => /失败$/.test(log.message)).length, 0);
  await advance(t, 10_000);
  assert.equal(f.seen.length, 2);
  assert.equal(f.seen[0]!.signal.aborted, false);
});

test('only explicit retryable HTTP status codes qualify, including structured transport errors', async t => {
  const cases = [
    ...[404, 405, 502, 503].map(status => ({name: `HTTP ${status}`, error: routeError(status)})),
    {name: 'structured status', error: Object.assign(new Error('route unavailable'), {status: 503})},
    {name: 'structured statusCode', error: Object.assign(new Error('route unavailable'), {statusCode: 404})},
  ];
  for (const variant of cases) await t.test(variant.name, async t => {
    const f = fixture(t, async (_request, attempt) => {
      if (attempt === 1) throw variant.error;
      return {ok: true, value: 'recovered'};
    }, {retry: {endpoints: ['stop'], delaysMs: [10]}});
    const pending = f.call('stop', {token: 'mock-token'});
    await turn();
    await advance(t, 10);
    assert.equal(await pending, 'recovered');
    assert.equal(f.seen.length, 2);
  });
});

test('retry exhaustion is bounded by the delay list and preserves the last transport error', async t => {
  const errors: Error[] = [];
  const f = fixture(t, async () => {
    const error = routeError(503);
    errors.push(error);
    throw error;
  }, {retry});
  const failed = assert.rejects(f.call('stop', {token: 'mock-token'}), (error: Error) => {
    assert.equal(error.cause, errors.at(-1));
    return true;
  });
  await turn();
  await advance(t, 100);
  await advance(t, 200);
  await advance(t, 400);
  await failed;
  assert.deepEqual(f.seen.map(request => request.at), [100_000, 100_100, 100_300, 100_700]);
  assert.equal(f.logs.filter(log => /失败$/.test(log.message)).length, 1);
  await advance(t, 10_000);
  assert.equal(f.seen.length, 4);
  assert.equal(f.seen[0]!.signal.aborted, false);
});

test('all attempts share the original deadline, even if the next transport ignores its signal', async t => {
  const f = fixture(t, async (_request, attempt) => {
    if (attempt === 1) throw routeError();
    return new Promise<RpcResult>(() => {});
  }, {retry: {endpoints: ['audio'], delaysMs: [400, 400]}, defaultDeadlineMs: 1_000});
  let finished = false;
  const failed = assert.rejects(f.call('audio', {sequence: 0}), (error: Error) => {
    assert.match(error.message, /请求超时/);
    assert.ok(error.cause instanceof DOMException);
    assert.equal(error.cause.name, 'TimeoutError');
    finished = true;
    return true;
  });
  await turn();
  await advance(t, 400);
  assert.equal(f.seen.length, 2);
  assert.equal(f.seen[0]!.signal, f.seen[1]!.signal);
  await advance(t, 599);
  assert.equal(finished, false);
  await advance(t, 1);
  await failed;
  assert.equal(f.seen[0]!.signal.aborted, true);
  assert.equal(Date.now(), 101_000, 'a retry does not renew the deadline');
  await advance(t, 10_000);
  assert.equal(f.seen.length, 2);
});

test('the overall deadline interrupts a retry wait and prevents a later attempt', async t => {
  const f = fixture(t, async () => { throw routeError(); }, {
    retry: {endpoints: ['status'], delaysMs: [1_000]}, defaultDeadlineMs: 250,
  });
  const failed = assert.rejects(f.call('status'), /请求超时/);
  await turn();
  await advance(t, 249);
  assert.equal(f.seen.length, 1);
  assert.equal(f.seen[0]!.signal.aborted, false);
  await advance(t, 1);
  await failed;
  await advance(t, 10_000);
  assert.equal(f.seen.length, 1);
  assert.equal(f.seen[0]!.signal.aborted, true);
});

test('a per-endpoint deadline also bounds the first attempt and consumes late failures', async t => {
  let rejectLate!: (error: unknown) => void;
  const f = fixture(t, () => new Promise<RpcResult>((_resolve, reject) => { rejectLate = reject; }), {
    retry, deadlines: {status: 40},
  });
  const failed = assert.rejects(f.call('status'), /请求超时/);
  await advance(t, 40);
  await failed;
  assert.equal(f.seen[0]!.signal.aborted, true);
  rejectLate(routeError(503));
  await turn();
  await advance(t, 10_000);
  assert.equal(f.seen.length, 1);
});

test('the endpoint whitelist is exact and never implicitly includes mutating operations', async t => {
  for (const endpoint of ['start', 'brief/polish', 'coach/generate', 'audio/extra', 'config']) {
    await t.test(endpoint, async t => {
      const f = fixture(t, async () => { throw routeError(); }, {retry});
      await assert.rejects(f.call(endpoint), /HTTP 405/);
      await advance(t, 10_000);
      assert.equal(f.seen.length, 1);
    });
  }
});

test('an empty endpoint or delay list keeps calls single-attempt', async t => {
  for (const policy of [{endpoints: [], delaysMs: [10]}, {endpoints: ['audio'], delaysMs: []}]) {
    await t.test(JSON.stringify(policy), async t => {
      const f = fixture(t, async () => { throw routeError(); }, {retry: policy});
      await assert.rejects(f.call('audio'), /HTTP 405/);
      await advance(t, 10_000);
      assert.equal(f.seen.length, 1);
    });
  }
});

test('authorization, timeouts, aborts and unspecified transport failures are never retried', async t => {
  const cases = [
    ...[401, 403, 408, 429, 500, 504].map(status => ({name: `HTTP ${status}`, error: routeError(status)})),
    {name: 'unclassified transport', error: new Error('transport failure: disconnected')},
    {name: 'ordinary failure', error: new Error('specific failure')},
    {name: 'timeout name overrides HTTP', error: Object.assign(routeError(), {name: 'TimeoutError'})},
    {name: 'timeout message overrides HTTP', error: new Error('transport failure: HTTP 405 request timed out')},
    {name: 'timeout prefix', error: new Error('transport failure: timeout')},
    {name: 'abort name overrides HTTP', error: Object.assign(routeError(), {name: 'AbortError'})},
    {name: 'abort message overrides HTTP', error: new Error('transport failure: HTTP 405 operation was aborted')},
    {name: 'cancel message overrides HTTP', error: new Error('HTTP 405 request cancelled')},
    {name: 'structured forbidden overrides text', error: Object.assign(routeError(), {status: 403})},
  ];
  for (const variant of cases) await t.test(variant.name, async t => {
    const f = fixture(t, async () => { throw variant.error; }, {retry});
    await assert.rejects(f.call('audio'), (error: Error) => {
      assert.equal(error.cause, variant.error);
      return true;
    });
    await advance(t, 10_000);
    assert.equal(f.seen.length, 1);
    assert.equal(f.logs.filter(log => /等待重试/.test(log.message)).length, 0);
  });
});

test('an application error is not retried even when its message contains a retryable HTTP code', async t => {
  const message = 'HTTP 405: 未知的会议操作';
  const f = fixture(t, async () => ({ok: false, error: {message}}), {retry});
  await assert.rejects(f.call('stop'), (error: Error) => {
    assert.equal(error.message, message);
    return true;
  });
  await advance(t, 10_000);
  assert.equal(f.seen.length, 1);
  assert.equal(f.logs.length, 1);
});

test('retry accounting and deadline signals are independent for each logical request', async t => {
  const counts = new Map<unknown, number>();
  const f = fixture(t, async request => {
    const count = (counts.get(request.payload) ?? 0) + 1;
    counts.set(request.payload, count);
    if (count === 1) throw routeError();
    return {ok: true, value: request.payload};
  }, {retry: {endpoints: ['audio'], delaysMs: [10]}});
  for (const sequence of [0, 1]) {
    const payload = {sequence};
    const pending = f.call('audio', payload);
    await turn();
    await advance(t, 10);
    assert.equal(await pending, payload);
  }
  assert.equal(f.seen.length, 4);
  assert.equal(f.seen[0]!.signal, f.seen[1]!.signal);
  assert.equal(f.seen[2]!.signal, f.seen[3]!.signal);
  assert.notEqual(f.seen[0]!.signal, f.seen[2]!.signal);
});

test('error hints are short, preserve causes, and do not assert host or connection state', () => {
  const hint = {label: '会议助手', channel: '/meeting-assistant', endpoint: 'stop', marker: '[host test]'};
  const cases: Array<{error: unknown; message: RegExp}> = [
    ...[404, 405, 502, 503].map(status => ({error: routeError(status), message: /通道暂时不可用/})),
    {error: routeError(401), message: /连接校验失败/},
    {error: routeError(403), message: /连接校验失败/},
    {error: new DOMException('The operation was aborted due to timeout', 'TimeoutError'), message: /请求超时/},
    {error: new Error('transport failure: timeout'), message: /请求超时/},
    {error: new DOMException('The operation was aborted', 'AbortError'), message: /请求已取消/},
    {error: new Error('transport failure: disconnected'), message: /连接暂时不可用/},
    {error: new Error('specific local failure'), message: /^specific local failure$/},
    {error: 'HTTP 405', message: /通道暂时不可用/},
  ];
  for (const variant of cases) {
    const described = describeRpcFailure(variant.error, hint);
    assert.match(described.message, variant.message);
    assert.equal(described.cause, variant.error);
    assert.ok(described.message.length < 80);
    assert.doesNotMatch(described.message, /没有上线|已经上线|通道是通的|日志|Application Support|只在渲染端/);
  }
  assert.equal(isRetryableRpcFailure(new Error('transport failure')), false);
  assert.equal(isRetryableRpcFailure(new Error('HTTP 1405')), false);
});

test('invalid retry delays are rejected before any transport request', () => {
  for (const delay of [-1, 0.5, NaN, Infinity, 2_147_483_648]) {
    assert.throws(() => createRpcCall({
      channel: '/meeting-assistant', label: '会议助手', marker: 'test', diag: {} as DiagLog,
      defaultDeadlineMs: 1_000, retry: {endpoints: ['audio'], delaysMs: [delay]},
      transport: {async call() { assert.fail('invalid retry configuration must not call the transport'); }},
    }), RangeError);
  }
});
