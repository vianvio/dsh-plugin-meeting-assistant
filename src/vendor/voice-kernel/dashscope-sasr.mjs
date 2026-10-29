// dashscope-sasr.mjs — 原子能力①：百炼流式语音识别客户端（SASR，run-task 协议）
//
// 协议（线上实测 2026-09-02）：
//   WS wss://{host}/api-ws/v1/inference，Authorization: bearer <key>
//   run-task (header.action, streaming:"duplex") → task-started → 二进制 PCM 100ms 帧
//   result-generated（sentence.sentence_end=true 为最终句，含 begin_time/end_time/words）
//   heartbeat:true —— 长静默不断链（实测 23s 无事件会被 CLIENT_ERROR 掐断）
//   → finish-task → task-finished
// 默认模型 qwen-audio-3.0-asr-flash-streaming：术语识别强（FFmpeg/PCM流/WebSocket 实测全对），
// 计费按音频时长（0.00033 元/s），无上下文重计费、无会话轮次概念。
//
// 断线语义：task-failed / ws close → state="failed"，由上层（ResilientAsrSession）重建连接继续
// （新 task 时间轴重置，上层用墙钟锚点映射）。
//
// 可注入点：wsFactory（单测 mock WebSocket 用）、model、wsBase。

const DEFAULT_WS_BASE =
  process.env.VR_SASR_WS_BASE ??
  "wss://llm-lnk338qatt81sj7u.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference";
const DEFAULT_MODEL = "qwen-audio-3.0-asr-flash-streaming";

export class DashscopeAsrStream {
  /**
   * @param {{
   *   apiKey: string,
   *   wsBase?: string,
   *   model?: string,
   *   wsFactory?: (url: string, headers: Record<string,string>) => object,
   *   onSentence?: (s:{text:string,beginMs:number,endMs:number,sentenceId:number,words?:Array<{text:string,punctuation:string,beginMs:number,endMs:number}>})=>void,
   *   onLog?: (s:string)=>void
   * }} opts
   */
  constructor(opts) {
    this.apiKey = opts.apiKey;
    this.wsBase = opts.wsBase || DEFAULT_WS_BASE;
    this.model = opts.model || DEFAULT_MODEL;
    this.wsFactory =
      opts.wsFactory ?? ((url, headers) => new WebSocket(url, { headers }));
    this.onSentence = opts.onSentence ?? (() => {});
    this.onLog = opts.onLog ?? (() => {});
    /** connecting | ready | stopping | finished | failed */
    this.state = "connecting";
    /** task-started 到达的墙钟时刻 */
    this.startedAt = null;
    /** 音频 0 点墙钟锚点（重喂旧音频时 = now - 重喂时长，由上层设置） */
    this.audioZeroWall = null;
    /** 重喂音频毫秒数（由上层设置；>0 时上层启用重喂窗口查重） */
    this.refeedMs = 0;
    this.ws = null;
    this.taskId = null;
    this.sentBytes = 0;
    this.sentenceCount = 0;
    this._queue = [];
    this._finishSent = false;
    this._drainTimer = null;
    this._taskIdLocal = crypto.randomUUID().replace(/-/g, "").slice(0, 32);
  }

  _sendJson(o) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(o));
  }

  /** 连接 + run-task。resolve 于 task-started。 */
  async start() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const ws = this.wsFactory(this.wsBase, { Authorization: `bearer ${this.apiKey}` });
      this.ws = ws;
      const openFail = setTimeout(() => {
        if (!settled) {
          settled = true;
          this.state = "failed";
          reject(new Error("SASR 握手超时（15s）"));
          try { ws.close(); } catch { /* noop */ }
        }
      }, 15_000);

      ws.addEventListener("open", () => {
        this._sendJson({
          header: { action: "run-task", task_id: this._taskIdLocal, streaming: "duplex" },
          payload: {
            task_group: "audio",
            task: "asr",
            function: "recognition",
            model: this.model,
            parameters: { sample_rate: 16000, format: "pcm", heartbeat: true },
            input: {},
          },
        });
      });

      ws.addEventListener("message", (ev) => {
        let o;
        try {
          o = JSON.parse(typeof ev.data === "string" ? ev.data : Buffer.from(ev.data).toString());
        } catch {
          // 帧完整性由 WS 协议保证；解析失败属异常信号，必须可见（截断诊断点）
          this._frameErrors = (this._frameErrors ?? 0) + 1;
          this.onLog(`sasr frame parse error #${this._frameErrors} (len=${ev.data?.length ?? "?"})`);
          return;
        }
        const event = o?.header?.event;
        if (event === "task-started") {
          this.startedAt = Date.now();
          this.state = "ready";
          this._startDrain();
          if (!settled) {
            settled = true;
            clearTimeout(openFail);
            resolve();
          }
        } else if (event === "result-generated") {
          const s = o.payload?.output?.sentence;
          if (!s || s.heartbeat || !s.sentence_end) return;
          this.sentenceCount++;
          this.onSentence({
            text: String(s.text ?? ""),
            beginMs: Number(s.begin_time ?? 0),
            endMs: Number(s.end_time ?? s.begin_time ?? 0),
            sentenceId: Number(s.sentence_id ?? this.sentenceCount),
            /** 词级透传（校验/后续用途；上层可忽略） */
            words: Array.isArray(s.words)
              ? s.words.map((w) => ({
                  text: String(w.text ?? ""),
                  punctuation: String(w.punctuation ?? ""),
                  beginMs: Number(w.begin_time ?? 0),
                  endMs: Number(w.end_time ?? 0),
                }))
              : undefined,
          });
        } else if (event === "task-finished") {
          this.state = "finished";
          this._stopDrain();
          this._finishedResolve?.();
          try { ws.close(); } catch { /* noop */ }
        } else if (event === "task-failed") {
          const msg = `SASR task-failed: ${o.header?.error_code ?? ""} ${o.header?.error_message ?? ""}`;
          this.onLog(msg);
          this.state = "failed";
          if (!settled) {
            settled = true;
            clearTimeout(openFail);
            reject(new Error(msg));
          } else {
            this._finishedResolve?.();
          }
        }
      });

      ws.addEventListener("close", () => {
        this._stopDrain();
        if (this.state === "ready" || this.state === "stopping") {
          this.state = "failed"; // 意外断开
          this.onLog("sasr ws closed unexpectedly");
          this._finishedResolve?.();
        }
        if (!settled) {
          settled = true;
          clearTimeout(openFail);
          this.state = "failed";
          reject(new Error("SASR 连接在 task-started 前关闭"));
        }
      });
      ws.addEventListener("error", (e) => {
        this.onLog(`sasr ws error: ${e?.message ?? e}`);
      });
    });
  }

  _startDrain() {
    if (this._drainTimer) return;
    this._drainTimer = setInterval(() => this._drain(), 100);
  }

  _stopDrain() {
    if (this._drainTimer) {
      clearInterval(this._drainTimer);
      this._drainTimer = null;
    }
  }

  _drain() {
    if (!this.ws || this.ws.readyState !== 1) return;
    // 100ms(3200B) 粒度；积压时限速 3x 实时（9600B/tick）——过快灌入会使 VAD 断句变粗
    let budget = 9600;
    while (this._queue.length > 0 && this.ws.readyState === 1 && budget > 0) {
      const chunk = this._queue[0];
      if (chunk.length <= 3200) {
        this._queue.shift();
        this.ws.send(chunk);
        this.sentBytes += chunk.length;
        budget -= chunk.length;
      } else {
        this._queue[0] = chunk.subarray(3200);
        this.ws.send(chunk.subarray(0, 3200));
        this.sentBytes += 3200;
        budget -= 3200;
      }
    }
  }

  sendAudio(buf) {
    if (!buf || buf.length === 0) return;
    this._queue.push(buf);
    this._drain();
  }

  get queuedBytes() {
    return this._queue.reduce((n, b) => n + b.length, 0);
  }

  /** 收尾：排空 → finish-task → 等 task-finished（SASR 无重连续传，上层重建）。 */
  async stop({ waitMs = 12_000 } = {}) {
    if (this.state === "finished" || this.state === "stopped") return;
    const drainDeadline = Date.now() + 5000;
    while (this.queuedBytes > 0 && Date.now() < drainDeadline && this.ws?.readyState === 1) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!this._finishSent && this.ws?.readyState === 1) {
      this._finishSent = true;
      this.state = "stopping";
      this._sendJson({
        header: { action: "finish-task", task_id: this._taskIdLocal, streaming: "duplex" },
        payload: { input: {} },
      });
    }
    this._finishPromise ??= new Promise((resolve) => {
      this._finishedResolve = resolve;
    });
    let finishTimer;
    await Promise.race([this._finishPromise, new Promise((r) => { finishTimer = setTimeout(r, waitMs); })]);
    clearTimeout(finishTimer);
    this._stopDrain();
    if (this.state !== "finished") this.state = "stopped";
    try { this.ws?.close(); } catch { /* noop */ }
  }

  forceDrop() {
    this._stopDrain();
    this._queue.length = 0;
    try { if (this.ws?.terminate) this.ws.terminate(); else this.ws?.close(); } catch { /* noop */ }
    this.state = "failed";
  }
}
