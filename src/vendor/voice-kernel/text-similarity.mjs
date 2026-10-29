// text-similarity.mjs — 原子能力⑤：文本相似度与重喂窗口查重（纯函数，中日韩文本有效）
//
// 用途：流式 ASR 断线重连后重喂最近音频，服务端会对同一段音频重复出句；
// 重喂窗口内按 bigram Jaccard 相似度去重（阈值 0.55，线上实测值）。

/**
 * bigram 字符集（剥离空白与标点）。
 * @param {string} s
 * @returns {Set<string>}
 */
export function bigrams(s) {
  const t = String(s ?? "").replace(/[\s，。？！、,.?!：；;:"]/g, "");
  const set = new Set();
  for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2));
  return set;
}

/**
 * bigram Jaccard 相似度：1 = 相同，0 = 无交集。
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function jaccard(a, b) {
  const A = bigrams(a);
  const B = bigrams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

/**
 * 重喂窗口查重判定（与 daemon 线上版语义一致）。
 * 仅当当前流重喂过音频（refeedMs>0）且句子完整落在重喂窗口内（endMs+500 <= refeedMs）时才查；
 * 命中条件 = 历史句 wallTs 落在 [zero-3000, zero+refeedMs) 且 jaccard >= 0.55。
 * @param {Array<{text:string, wallTs:number}>} recent 已落句（最近 N 条）
 * @param {string} text 待判句子文本
 * @param {{refeedMs?: number, zeroWall?: number|null, endMs?: number, windowPadMs?: number, threshold?: number}} [opts]
 * @returns {boolean}
 */
export function isDuplicateSentence(recent, text, { refeedMs = 0, zeroWall = null, endMs = 0, windowPadMs = 3000, threshold = 0.55 } = {}) {
  if (!(refeedMs > 0)) return false;
  if (endMs + 500 > refeedMs) return false;
  const zero = zeroWall ?? Date.now();
  return recent.some(
    (e) => e.wallTs >= zero - windowPadMs && e.wallTs < zero + refeedMs && jaccard(e.text, text) >= threshold,
  );
}
