// resilient-asr-session 单测：断线重连编排（假流注入，无网络）
//   覆盖：缓冲 / 重喂与墙钟锚点 / 重喂窗口查重 / 缓冲上限丢旧 / 退避 / 停止交还缓冲
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { ResilientAsrSession } from "../../src/vendor/voice-kernel/resilient-asr-session.mjs";

class FakeStream {
  static created = [];
  constructor(hooks) {
    this.hooks = hooks;
    this.state = "connecting";
    this.startedAt = null;
    this.audioZeroWall = null;
    this.refeedMs = 0;
    this.sent = [];
    this.stopCalls = 0;
    this.queuedBytes = 0;
    this.sentenceCount = 0;
    FakeStream.created.push(this);
  }
  async start() {
    this.startedAt = Date.now();
    this.state = "ready";
    return;
  }
  sendAudio(b) {
    this.sent.push(Buffer.from(b));
    this.sentenceCount = 0;
  }
  async stop() {
    this.stopCalls++;
    this.state = "finished";
  }
  forceDrop() {
    this.state = "failed";
  }
  emitSentence(s) {
    this.sentenceCount++;
    this.hooks.onSentence(s);
  }
  get sentBytes() {
    return this.sent.reduce((n, b) => n + b.length, 0);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sessions = [];
afterEach(() => {
  for (const s of sessions.splice(0)) {
    try { s.stop(); } catch { /* noop */ }
  }
  FakeStream.created = [];
});

function makeSession(opts = {}) {
  const out = [];
  const states = [];
  const logs = [];
  const session = new ResilientAsrSession({
    createStream: (hooks) => new FakeStream(hooks),
    onSentence: (s) => out.push(s),
    onState: (st) => states.push(st),
    onLog: (m) => logs.push(m),
    pollMs: 20,
    backoffStartMs: 30,
    backoffMaxMs: 200,
    ...opts,
  });
  sessions.push(session);
  return { session, out, states, logs, streams: () => FakeStream.created };
}

test("start：建立流并进入 ready；喂音直发", async () => {
  const { session, out, states, streams } = makeSession();
  await session.start();
  assert.equal(streams().length, 1);
  assert.equal(session.stream.state, "ready");
  assert.deepEqual(states, ["connecting", "ready"]);
  session.feedAudio(Buffer.alloc(3200));
  assert.equal(streams()[0].sentBytes, 3200);
  assert.equal(session.bufferedBytes, 0);
  assert.equal(out.length, 0);
});

test("未就绪喂音：进缓冲，就绪后新音直发（旧缓冲被 tail 重喂覆盖后清空）", async () => {
  const { session, streams } = makeSession();
  session.feedAudio(Buffer.alloc(3200)); // 尚未 start → 缓冲
  assert.equal(session.bufferedBytes, 3200);
  await session.start();
  // tailAudio 有 3200 → 重喂给新流
  assert.equal(streams()[0].sentBytes, 3200);
  assert.equal(streams()[0].refeedMs, 100);
  assert.equal(session.bufferedBytes, 0);
  session.feedAudio(Buffer.alloc(3200));
  assert.equal(streams()[0].sentBytes, 6400);
});

test("断线重连：退避后重建 + 重喂尾部 + 锚点正确", async () => {
  const { session, streams, logs } = makeSession();
  await session.start();
  session.feedAudio(Buffer.alloc(64000)); // 2s
  const s0 = streams()[0];
  assert.equal(s0.sentBytes, 64000);

  s0.state = "failed"; // 模拟断线
  await sleep(200); // poll(20ms) 发现 → backoff 30ms → 重连
  assert.ok(streams().length >= 2, `应重连，实际 ${streams().length}`);
  const s1 = streams()[1];
  assert.equal(session.reconnects, 1);
  // 重喂：tail=2s 全量
  assert.equal(s1.sentBytes, 64000);
  assert.equal(s1.refeedMs, 2000);
  assert.ok(Math.abs(s1.audioZeroWall - (Date.now() - 2000)) < 300, "锚点 ≈ now-2000");
  assert.equal(session.bufferedBytes, 0);
  assert.ok(logs.some((l) => l.includes("re-seed")));
});

test("重喂窗口查重：同文本句被抑制，新句照常", async () => {
  const { session, out } = makeSession();
  await session.start();
  const s0 = session.stream;
  // 先喂 2s 音频（产生 tail）再落句，断线后才有重喂窗口
  session.feedAudio(Buffer.alloc(64000));
  s0.emitSentence({ text: "砸自己的脚", beginMs: 0, endMs: 800, sentenceId: 1 });
  assert.equal(out.length, 1);

  // 断线重连 → 重喂 2s → 服务端对同一音频重复出句
  s0.state = "failed";
  await sleep(200);
  const s1 = session.stream;
  assert.ok(s1 && s1 !== s0);
  assert.ok(s1.refeedMs > 0, "新流应有重喂窗口");
  s1.emitSentence({ text: "砸自己的脚", beginMs: 100, endMs: 900, sentenceId: 2 }); // 窗口内同文 → 抑制
  assert.equal(out.length, 1, "重复句应被抑制");
  s1.emitSentence({ text: "现在写数学作业", beginMs: 3000, endMs: 4000, sentenceId: 3 }); // 窗口外新句 → 放行
  assert.equal(out.length, 2);
  assert.equal(out[1].text, "现在写数学作业");
  // 墙钟 = 锚点 + beginMs
  assert.equal(out[1].wallTs, s1.audioZeroWall + 3000);
});

test("无重喂无查重：未喂音频就断线重连，重复句照常放行（原版语义）", async () => {
  const { session, out } = makeSession();
  await session.start();
  const s0 = session.stream;
  s0.emitSentence({ text: "砸自己的脚", beginMs: 0, endMs: 800, sentenceId: 1 });
  s0.state = "failed";
  await sleep(200);
  const s1 = session.stream;
  assert.equal(s1.refeedMs, 0, "tail 空 → 无重喂");
  s1.emitSentence({ text: "砸自己的脚", beginMs: 100, endMs: 900, sentenceId: 2 });
  assert.equal(out.length, 2, "无重喂窗口 → 不查重");
});

test("墙钟映射：无锚点用 startedAt，有锚点用 audioZeroWall", async () => {
  const { session, out } = makeSession();
  await session.start();
  const s0 = session.stream;
  s0.emitSentence({ text: "第一句", beginMs: 1000, endMs: 1500, sentenceId: 1 });
  assert.equal(out[0].wallTs, s0.startedAt + 1000);
  // 置锚点后（模拟重喂）
  s0.audioZeroWall = 12345;
  s0.refeedMs = 5000;
  s0.emitSentence({ text: "锚点句", beginMs: 200, endMs: 300, sentenceId: 2 });
  assert.equal(out[1].wallTs, 12345 + 200);
});

test("缓冲上限：断流期间超限丢最旧并计数", async () => {
  const { session } = makeSession({ bufferSec: 1, backoffStartMs: 10_000 });
  await session.start();
  const s0 = session.stream;
  s0.state = "failed";
  // 用长 backoff（10s）锁死重连窗口，确保断流期压入是缓冲而非直发
  await sleep(50); // poll 发现断线 → schedule(10s)
  assert.equal(session.stream, null);
  assert.equal(session.bufferedBytes, 0);
  // 直接压 3.5s（上限 1s=32000B）
  session.feedAudio(Buffer.alloc(112000));
  assert.equal(session.bufferedBytes, 32000, "缓冲应封顶 1s");
  assert.ok(session.droppedBytes >= 80000, `应丢弃最旧，实际 ${session.droppedBytes}`);
  // 后续重连恢复（绕过退避 timer 直接建流，验证封顶后仍能继续）
  await session._startStream();
  assert.ok(session.stream, "应重新建流");
  // tail 与 pending 独立封顶（refeedSec=30s > bufferSec=1s）：tail 保 3.5s 全量重喂，
  // pending 丢最旧刺 1s —— 原版语义：重喂优先于缓冲上限，音频尾部完整补偿在途句
  assert.equal(session.stream.sentBytes, 112000, "tail 3.5s 全量重喂");
  assert.equal(session.stream.refeedMs, 3500);
});

test("退避序列：连续失败按 2 倍增长且封顶", async () => {
  const { session, streams } = makeSession({ backoffStartMs: 20, backoffMaxMs: 80 });
  // 首连失败：createStream 抛错
  let failFirst = 2; // 前两次 start 失败
  const s2 = new ResilientAsrSession({
    createStream: (hooks) => {
      const f = new FakeStream(hooks);
      if (failFirst > 0) {
        failFirst--;
        f.start = async () => {
          throw new Error("mock start fail");
        };
      }
      return f;
    },
    onLog: () => {},
    pollMs: 10,
    backoffStartMs: 20,
    backoffMaxMs: 80,
  });
  sessions.push(s2);
  const t0 = Date.now();
  await s2.start(); // 首连失败 → schedule
  assert.equal(s2.stream, null);
  await sleep(250); // 20 → 40 → 80 → 80 …
  assert.ok(streams !== null);
  assert.ok(s2.stream, "最终应建流成功（第三次成功）");
  assert.ok(Date.now() - t0 >= 60, "退避总耗时应 ≥ 20+40");
});

test("停止：收尾流 + 交还缓冲 + 幂等", async () => {
  const { session, streams } = makeSession();
  await session.start();
  const s0 = session.stream;
  s0.state = "failed";
  session.feedAudio(Buffer.alloc(3200)); // 断流期缓冲
  const leftover = await session.stop();
  assert.equal(leftover.length, 3200, "应交还未发送缓冲");
  assert.equal(session.bufferedBytes, 0);
  assert.equal(session.wsState, "stopped");
  // 再 stop 幂等返回空
  const again = await session.stop();
  assert.equal(again.length, 0);
  // 停止后不再重连
  const n = streams().length;
  await sleep(80);
  assert.equal(streams().length, n);
});

test("stop 收尾就绪流：调用 stream.stop()", async () => {
  const { session } = makeSession();
  await session.start();
  const s0 = session.stream;
  await session.stop();
  assert.equal(s0.stopCalls, 1);
  assert.equal(s0.state, "finished");
});

test("forceDropStream：触发重连（模拟断网调试路径）", async () => {
  const { session, streams } = makeSession();
  await session.start();
  const s0 = session.stream;
  session.forceDropStream();
  assert.equal(s0.state, "failed");
  await sleep(200);
  assert.ok(streams().length >= 2);
  assert.equal(session.reconnects, 1);
});

test("createStream 必填：缺省抛 TypeError", () => {
  assert.throws(() => new ResilientAsrSession({}), TypeError);
});

test("stats 汇总：fedBytes/queued/reconnects/wsState", async () => {
  const { session } = makeSession();
  await session.start();
  session.feedAudio(Buffer.alloc(3200));
  const st = session.stats;
  assert.equal(st.fedBytes, 3200);
  assert.equal(st.reconnects, 0);
  assert.equal(st.wsState, "ready");
});
