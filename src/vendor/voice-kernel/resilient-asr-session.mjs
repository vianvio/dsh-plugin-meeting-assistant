// resilient-asr-session.mjs — 原子能力⑥：断线重连流式转写会话（组合 SASR 客户端的韧性编排层）
//
// 从 recorder-asr.mjs 守护进程的线上验证逻辑抽离，语义一致：
//   - 断线（stream.state ∈ failed/finished/stopped）→ 指数退避重建（1s→30s，可注入起点）
//   - 断线期间音频进内存缓冲（上限 bufferSec=300s，超出丢最旧并计数；pcm 落盘由上层负责，不受影响）
//   - 重连成功 → 重喂最近 refeedSec=30s 音频（补偿在途句子；新流时间轴归零，
//     audioZeroWall 锚点 = now - 重喂时长，句子墙钟映射保持正确）
//   - 重喂窗口内句子按 bigram 相似度去重（isDuplicateSentence）
//   - 停止 → 优雅收尾流，返回未发送的缓冲音频（上层可落盘兜底）
//
// 依赖注入：createStream({onSentence, onLog}) → 兼容 DashscopeAsrStream 接口的对象
//   （state / startedAt / audioZeroWall / refeedMs / sendAudio / stop / forceDrop / queuedBytes），
//   单测用假流，无网络依赖。

import { isDuplicateSentence } from "./text-similarity.mjs";

const RECENT_MAX = 30;

export class ResilientAsrSession {
  /**
   * @param {{
   *   createStream: (hooks:{onSentence:(s:object)=>void, onLog:(s:string)=>void}) => object,
   *   onSentence?: (s:{text:string,beginMs:number,endMs:number,sentenceId:number,wallTs:number,words?:object[]})=>void,
   *   onLog?: (s:string)=>void,
   *   onState?: (st:"connecting"|"ready"|"failed"|"reconnecting"|"stopped")=>void,
   *   refeedSec?: number, bufferSec?: number,
   *   pollMs?: number, backoffStartMs?: number, backoffMaxMs?: number
   * }} opts
   */
  constructor(opts) {
    if (typeof opts.createStream !== "function") throw new TypeError("createStream is required");
    this.createStream = opts.createStream;
    this.onSentence = opts.onSentence ?? (() => {});
    this.onLog = opts.onLog ?? (() => {});
    this.onState = opts.onState ?? (() => {});
    this.refeedBytes = (opts.refeedSec ?? 30) * 32000;
    this.maxBufferBytes = (opts.bufferSec ?? 300) * 32000;
    this.pollMs = opts.pollMs ?? 1000;
    this.backoffStartMs = opts.backoffStartMs ?? 1000;
    this.backoffMaxMs = opts.backoffMaxMs ?? 30_000;

    /** 当前流（createStream 产物）；null = 连接中/待重连 */
    this.stream = null;
    /** 断线期间缓冲的音频（上限 maxBufferBytes；停止时交还上层） */
    this.pendingAudio = Buffer.alloc(0);
    /** 最近音频尾（重连时重喂） */
    this.tailAudio = Buffer.alloc(0);
    this.droppedBytes = 0;
    this.fedBytes = 0;
    this.reconnects = 0;
    /** 最近已落句 [{text, wallTs}]（重喂窗口查重用） */
    this.recentSentences = [];

    this._backoffMs = this.backoffStartMs;
    this._shuttingDown = false;
    this._starting = false;
    this._reconnectTimer = null;
    this._pollTimer = null;
  }

  // ------------------------------------------------------------ 对外状态
  get bufferedBytes() {
    return this.pendingAudio.length;
  }
  get queuedBytes() {
    return this.stream?.queuedBytes ?? 0;
  }
  get wsState() {
    if (this._shuttingDown) return "stopped";
    if (this.stream) return this.stream.state;
    return this._reconnectTimer ? "reconnecting" : this._starting ? "connecting" : "idle";
  }
  get stats() {
    return {
      fedBytes: this.fedBytes,
      bufferedBytes: this.pendingAudio.length,
      queuedBytes: this.queuedBytes,
      reconnects: this.reconnects,
      droppedBytes: this.droppedBytes,
      wsState: this.wsState,
    };
  }

  _setState(st) {
    this.onState(st);
  }

  // ------------------------------------------------------------ 音频入口
  /** 喂入音频块（任意大小）：流就绪直发，否则缓冲（超上限丢最旧）。 */
  feedAudio(chunk) {
    if (this._shuttingDown || !chunk || chunk.length === 0) return;
    this.fedBytes += chunk.length;
    this.tailAudio = Buffer.concat([this.tailAudio, chunk]);
    if (this.tailAudio.length > this.refeedBytes) {
      this.tailAudio = this.tailAudio.subarray(this.tailAudio.length - this.refeedBytes);
    }
    if (this.stream && this.stream.state === "ready") {
      this.stream.sendAudio(chunk);
    } else {
      this.pendingAudio = Buffer.concat([this.pendingAudio, chunk]);
      if (this.pendingAudio.length > this.maxBufferBytes) {
        const cut = this.pendingAudio.length - this.maxBufferBytes;
        this.pendingAudio = this.pendingAudio.subarray(cut);
        this.droppedBytes += cut;
        this.onLog(
          `audio buffer overflow: dropped ${(cut / 32000).toFixed(1)}s (total ${(this.droppedBytes / 32000).toFixed(1)}s)`,
        );
      }
    }
  }

  // ------------------------------------------------------------ 句子出口（含查重 + 墙钟映射）
  _onSentence(s, source = this.stream) {
    if (!s.text) return;
    const stream = source;
    const zero = stream?.audioZeroWall ?? stream?.startedAt ?? Date.now();
    const wallTs = zero + s.beginMs;
    if (
      isDuplicateSentence(this.recentSentences, s.text, {
        refeedMs: stream?.refeedMs ?? 0,
        zeroWall: stream?.audioZeroWall,
        endMs: s.endMs,
      })
    ) {
      this.onLog(`dup sentence skipped (re-feed window): ${(s.text ?? "").slice(0, 30)}`);
      return;
    }
    this.recentSentences.push({ text: s.text, wallTs });
    if (this.recentSentences.length > RECENT_MAX) this.recentSentences.shift();
    this.onSentence({ ...s, wallTs });
  }

  // ------------------------------------------------------------ 流生命周期
  /** 建立首条流（失败不抛：进入重连循环）。幂等。 */
  async start() {
    this._startPolling();
    await this._startStream();
  }

  async _startStream() {
    if (this._shuttingDown || this._starting || this.stream) return;
    this._starting = true;
    this._setState("connecting");
    try {
      const s = this.createStream({
        onSentence: (x) => this._onSentence(x, s),
        onLog: (m) => this.onLog(m),
      });
      this._connectingStream = s;
      this._inflight = s.start();
      await this._inflight;
      this._connectingStream = null;
      if (this._shuttingDown) { s.forceDrop(); return; }
      this.stream = s;
      this._backoffMs = this.backoffStartMs;
      // 重喂尾部（补偿在途句子；新流时间轴归零 → 墙钟锚点前移）
      const replay = this.pendingAudio.length > this.tailAudio.length ? this.pendingAudio : this.tailAudio;
      if (replay.length > 0) {
        const refeedMs = Math.round(replay.length / 32);
        s.audioZeroWall = Date.now() - refeedMs;
        s.refeedMs = refeedMs;
        s.sendAudio(replay);
        this.onLog(
          `flushing tail audio ${(refeedMs / 1000).toFixed(1)}s${this.reconnects > 0 ? " (re-seed for in-flight sentences)" : ""}`,
        );
        this.pendingAudio = Buffer.alloc(0);
      }
      this._setState("ready");
    } catch (err) {
      this._connectingStream?.forceDrop();
      this._connectingStream = null;
      if (this._shuttingDown) return;
      this.onLog(`stream start failed: ${err.message}`);
      this._setState("failed");
      this._scheduleReconnect();
    } finally {
      this._starting = false;
    }
  }

  _scheduleReconnect() {
    if (this._shuttingDown || this._reconnectTimer) return;
    const delay = this._backoffMs;
    this._backoffMs = Math.min(this._backoffMs * 2, this.backoffMaxMs);
    this.onLog(`reconnect in ${delay}ms`);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      void this._startStream();
    }, delay);
  }

  _startPolling() {
    if (this._pollTimer) return;
    this._pollTimer = setInterval(() => {
      if (this._shuttingDown) return;
      const st = this.stream;
      if (st && (st.state === "failed" || st.state === "finished" || st.state === "stopped")) {
        st.forceDrop();
        this.stream = null;
        this.reconnects++;
        this.onLog(`stream lost (state=${st.state}), reconnect #${this.reconnects}`);
        this._setState("reconnecting");
        this._scheduleReconnect();
      } else if (!this.stream && !this._reconnectTimer && !this._starting) {
        void this._startStream();
      }
    }, this.pollMs);
  }

  /**
   * 优雅停止：停巡检与重连、收尾流；返回未发送的缓冲音频（上层兜底落盘）。
   * 幂等（重复调用返回空缓冲）。
   * @returns {Promise<Buffer>}
   */
  async stop() {
    if (this._shuttingDown) return this.takePending();
    this._shuttingDown = true;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
    this._connectingStream?.forceDrop();
    await this._inflight?.catch(() => {});
    if (this.stream) {
      const s = this.stream;
      try {
        await s.stop();
        this.onLog(`stream stopped: state=${s.state} sentences=${s.sentenceCount ?? "?"}`);
      } catch (err) {
        this.onLog(`stream stop error: ${err.message}`);
      }
    }
    this.stream = null;
    this._setState("stopped");
    return this.takePending();
  }

  /** 取走（并清空）未发送缓冲音频。 */
  takePending() {
    const b = this.pendingAudio;
    this.pendingAudio = Buffer.alloc(0);
    return b;
  }

  /** 强制丢弃当前流（调试/模拟断网；巡检将触发重连）。 */
  forceDropStream() {
    if (this.stream) {
      this.onLog("force-dropping stream (debug, simulate network failure)");
      this.stream.forceDrop();
    }
  }
}
