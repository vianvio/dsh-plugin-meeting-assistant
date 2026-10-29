// dashscope-sasr 单测：run-task 协议全流程（mock WebSocket，无网络）
//   覆盖：握手/run-task 参数 / task-started / 句子解析（含词级/心跳/非终句过滤）
//         排空限速与拆帧 / finish-task / task-failed / 意外断开 / 帧解析错误
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { DashscopeAsrStream } from "../../src/vendor/voice-kernel/dashscope-sasr.mjs";

class FakeWebSocket {
  static instances = [];
  constructor(url, opts) {
    this.url = url;
    this.opts = opts;
    this.readyState = 0;
    this.sent = [];
    this.listeners = new Map();
    FakeWebSocket.instances.push(this);
  }
  addEventListener(ev, cb) {
    if (!this.listeners.has(ev)) this.listeners.set(ev, []);
    this.listeners.get(ev).push(cb);
  }
  emit(ev, arg) {
    for (const cb of this.listeners.get(ev) ?? []) cb(arg);
  }
  send(data) {
    this.sent.push(data);
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close", {});
  }
  // ---- 测试驱动 ----
  open() {
    this.readyState = 1;
    this.emit("open", {});
  }
  serverSend(obj) {
    this.emit("message", { data: JSON.stringify(obj) });
  }
  get jsonSent() {
    return this.sent.filter((d) => typeof d === "string").map((d) => JSON.parse(d));
  }
  get binarySent() {
    return this.sent.filter((d) => typeof d !== "string");
  }
}

const cleanup = [];
afterEach(() => {
  for (const c of cleanup.splice(0)) {
    try { c.forceDrop(); } catch { /* noop */ }
  }
});

function makeClient(extra = {}) {
  const sentences = [];
  const logs = [];
  let fake;
  const client = new DashscopeAsrStream({
    apiKey: "sk-test",
    wsFactory: (url, headers) => {
      fake = new FakeWebSocket(url, headers);
      return fake;
    },
    onSentence: (s) => sentences.push(s),
    onLog: (m) => logs.push(m),
    ...extra,
  });
  cleanup.push(client);
  return { client, fake: () => fake, sentences, logs };
}

async function startedSession(extra = {}) {
  const ctx = makeClient(extra);
  const p = ctx.client.start();
  ctx.fake().open();
  ctx.fake().serverSend({ header: { event: "task-started", task_id: "t1" } });
  await p;
  return ctx;
}

test("握手：Authorization 头 + run-task 参数（模型/采样率/format/heartbeat）", async () => {
  const ctx = makeClient({ model: "qwen-audio-3.0-asr-plus-streaming" });
  const p = ctx.client.start();
  ctx.fake().open();
  const runTask = ctx.fake().jsonSent.find((m) => m.header?.action === "run-task");
  assert.ok(runTask, "应发送 run-task");
  assert.equal(runTask.header.streaming, "duplex");
  assert.match(runTask.header.task_id, /^[0-9a-f]{32}$/);
  assert.equal(runTask.payload.model, "qwen-audio-3.0-asr-plus-streaming");
  assert.deepEqual(runTask.payload.parameters, { sample_rate: 16000, format: "pcm", heartbeat: true });
  assert.equal(runTask.payload.task, "asr");
  assert.equal(ctx.fake().opts.Authorization, "bearer sk-test");
  ctx.fake().serverSend({ header: { event: "task-started" } });
  await p;
  assert.equal(ctx.client.state, "ready");
  assert.ok(ctx.client.startedAt > 0);
});

test("默认模型为 qwen-audio-3.0-asr-flash-streaming", async () => {
  const ctx = makeClient();
  const p = ctx.client.start();
  ctx.fake().open();
  const runTask = ctx.fake().jsonSent.find((m) => m.header?.action === "run-task");
  assert.equal(runTask.payload.model, "qwen-audio-3.0-asr-flash-streaming");
  ctx.fake().serverSend({ header: { event: "task-started" } });
  await p;
});

test("result-generated：最终句回调（词级映射）", async () => {
  const ctx = await startedSession();
  ctx.fake().serverSend({
    header: { event: "result-generated" },
    payload: { output: { sentence: {
      text: "你好世界", begin_time: 100, end_time: 900, sentence_id: 7, sentence_end: true,
      words: [
        { text: "你好", punctuation: "，", begin_time: 100, end_time: 400 },
        { text: "世界", punctuation: "。", begin_time: 400, end_time: 900 },
      ],
    } } },
  });
  assert.equal(ctx.sentences.length, 1);
  const s = ctx.sentences[0];
  assert.equal(s.text, "你好世界");
  assert.equal(s.beginMs, 100);
  assert.equal(s.endMs, 900);
  assert.equal(s.sentenceId, 7);
  assert.equal(s.words.length, 2);
  assert.equal(s.words[0].text, "你好");
  assert.equal(s.words[1].punctuation, "。");
  assert.equal(s.words[1].endMs, 900);
});

test("过滤：心跳句 / 非终句（sentence_end=false）/ 无 sentence 载荷", async () => {
  const ctx = await startedSession();
  ctx.fake().serverSend({ header: { event: "result-generated" }, payload: { output: { sentence: { text: "心跳", sentence_end: true, heartbeat: true } } } });
  ctx.fake().serverSend({ header: { event: "result-generated" }, payload: { output: { sentence: { text: "中间态", sentence_end: false } } } });
  ctx.fake().serverSend({ header: { event: "result-generated" }, payload: { output: {} } });
  assert.equal(ctx.sentences.length, 0);
});

test("排空：3200B 帧粒度 + 预算限速 9600B/tick（积压场景）+ 大块拆帧", async () => {
  const ctx = await startedSession();
  const ws = ctx.fake();
  // 模拟发送窗口关闭：sendAudio 只入队不发送（生产中对应 ws 背压/未就绪）
  ws.readyState = 0;
  for (let i = 0; i < 5; i++) ctx.client.sendAudio(Buffer.alloc(3200));
  assert.equal(ctx.client.queuedBytes, 16000);
  assert.equal(ws.binarySent.length, 0);
  // 窗口恢复：单次 _drain 预算 9600B → 只发 3 块
  ws.readyState = 1;
  ctx.client._drain();
  assert.equal(ws.binarySent.length, 3, "单拍限速 3 块");
  assert.equal(ctx.client.queuedBytes, 6400);
  // 大块拆帧：入队 6400B → 拆成 3200 + 排队 3200（本拍预算已用完前的部分发送）
  ctx.client.sendAudio(Buffer.alloc(6400));
  assert.equal(ws.binarySent.length, 6);
  assert.equal(ctx.client.queuedBytes, 3200);
  for (const b of ws.binarySent) {
    assert.ok(b.length <= 3200, `帧不应超 3200B，实际 ${b.length}`);
  }
  assert.ok(ctx.client.sentBytes >= 9600);
});

test("sendAudio：空块忽略；queuedBytes 统计", async () => {
  const ctx = await startedSession();
  ctx.client.sendAudio(Buffer.alloc(0));
  assert.equal(ctx.client.queuedBytes, 0);
  ctx.client._queue.push(Buffer.alloc(3200));
  assert.equal(ctx.client.queuedBytes, 3200);
});

test("stop：排空 → finish-task → task-finished → finished 态", async () => {
  const ctx = await startedSession();
  ctx.client.sendAudio(Buffer.alloc(3200));
  const p = ctx.client.stop({ waitMs: 200 });
  const finish = ctx.fake().jsonSent.find((m) => m.header?.action === "finish-task");
  assert.ok(finish, "应发送 finish-task");
  assert.equal(finish.header.task_id, ctx.client._taskIdLocal);
  ctx.fake().serverSend({ header: { event: "task-finished" } });
  await p;
  assert.equal(ctx.client.state, "finished");
});

test("stop：task-finished 一直不来 → waitMs 超时后 stopped 态", async () => {
  const ctx = await startedSession();
  await ctx.client.stop({ waitMs: 80 });
  assert.equal(ctx.client.state, "stopped");
});

test("task-failed（启动后）：state=failed 且挂起的 stop 可收尾", async () => {
  const ctx = await startedSession();
  ctx.fake().serverSend({ header: { event: "task-failed", error_code: "E1", error_message: "boom" } });
  assert.equal(ctx.client.state, "failed");
  assert.ok(ctx.logs.some((l) => l.includes("task-failed")));
  await ctx.client.stop({ waitMs: 80 }); // 不应卡死
});

test("task-failed（启动前）：start() 拒绝", async () => {
  const ctx = makeClient();
  const p = ctx.client.start();
  ctx.fake().open();
  ctx.fake().serverSend({ header: { event: "task-failed", error_code: "AUTH", error_message: "bad key" } });
  await assert.rejects(p, /task-failed/);
  assert.equal(ctx.client.state, "failed");
});

test("握手前连接关闭：start() 拒绝", async () => {
  const ctx = makeClient();
  const p = ctx.client.start();
  ctx.fake().open();
  ctx.fake().close();
  await assert.rejects(p, /task-started 前关闭/);
  assert.equal(ctx.client.state, "failed");
});

test("就绪中意外断开：state=failed + 日志", async () => {
  const ctx = await startedSession();
  ctx.fake().close();
  assert.equal(ctx.client.state, "failed");
  assert.ok(ctx.logs.some((l) => l.includes("unexpectedly")));
});

test("非 JSON 帧：解析错误计数与日志，连接继续", async () => {
  const ctx = await startedSession();
  ctx.fake().emit("message", { data: "不是JSON" });
  ctx.fake().emit("message", { data: Buffer.from("也不是JSON") });
  assert.equal(ctx.client._frameErrors, 2);
  assert.ok(ctx.logs.some((l) => l.includes("frame parse error")));
  // 连接仍可用：正常句仍回调
  ctx.fake().serverSend({ header: { event: "result-generated" }, payload: { output: { sentence: { text: "还在", begin_time: 0, end_time: 100, sentence_end: true } } } });
  assert.equal(ctx.sentences.length, 1);
});

test("forceDrop：清队列、关连接、failed 态", async () => {
  const ctx = await startedSession();
  ctx.client.sendAudio(Buffer.alloc(32000));
  ctx.client.forceDrop();
  assert.equal(ctx.client.state, "failed");
  assert.equal(ctx.client.queuedBytes, 0);
});

test("stop 幂等：finished 后再 stop 直接返回", async () => {
  const ctx = await startedSession();
  ctx.client.stop({ waitMs: 80 });
  await ctx.client.stop({ waitMs: 80 }); // 不应抛错
});
