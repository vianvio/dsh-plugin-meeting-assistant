// text-similarity 单测：bigram / jaccard / 重喂窗口查重
import { test } from "node:test";
import assert from "node:assert/strict";
import { bigrams, jaccard, isDuplicateSentence } from "../../src/vendor/voice-kernel/text-similarity.mjs";

test("bigrams：二元字符集，剥离空白与标点", () => {
  assert.deepEqual([...bigrams("你好")], ["你好"]);
  assert.deepEqual([...bigrams("你好。")], ["你好"]); // 标点剥离
  assert.deepEqual([...bigrams("你好，世界")], ["你好", "好世", "世界"]); // 标点仅剥离不新隔断
  assert.equal(bigrams("").size, 0);
  assert.equal(bigrams("。").size, 0);
  assert.equal(bigrams(null).size, 0);
  // 英文也按字符 bigram（设计如此：面向中日韩，英文是近似的）
  assert.equal(bigrams("ab").size, 1);
});

test("jaccard：相同=1，无交集=0，部分 0~1", () => {
  assert.equal(jaccard("砸自己的脚", "砸自己的脚"), 1);
  assert.equal(jaccard("砸自己的脚。", "砸自己的脚！"), 1); // 标点差异不影响
  assert.equal(jaccard("砸自己的脚", "完全不同的内容啊"), 0);
  const mid = jaccard("今天天气很好适合出去", "今天天气不错可以出门");
  assert.ok(mid > 0 && mid < 1, `应部分相似，实际 ${mid}`);
  assert.equal(jaccard("", "任何"), 0); // 空 bigram 安全
});

test("isDuplicateSentence：命中条件", () => {
  const recent = [{ text: "砸自己的脚", wallTs: 1000 }];
  const base = { refeedMs: 5000, zeroWall: 0, endMs: 500 };
  // 500+500 <= 5000 ✓，wallTs 1000 ∈ [0-3000, 0+5000) ✓，jaccard=1 ✓
  assert.equal(isDuplicateSentence(recent, "砸自己的脚", base), true);
  // 文本不同 → 阈值不达
  assert.equal(isDuplicateSentence(recent, "今天写数学作业", base), false);
  // 窗口外（wallTs 不在 [zero-3000, zero+refeedMs)）
  assert.equal(
    isDuplicateSentence([{ text: "砸自己的脚", wallTs: 8000 }], "砸自己的脚", base),
    false,
  );
  // 未重喂（refeedMs=0）永不查重
  assert.equal(isDuplicateSentence(recent, "砸自己的脚", { ...base, refeedMs: 0 }), false);
  // 句子超出重喂窗口（endMs+500 > refeedMs）不查重——在途新句
  assert.equal(
    isDuplicateSentence(recent, "砸自己的脚", { ...base, endMs: 5000 }),
    false,
  );
});

test("isDuplicateSentence：阈值边界（0.55）", () => {
  // 构造相似度恰在阈值附近的句对
  // "ABCDEF" 与 "ABCDEG"：bigram {AB,BC,CD,DE} 交4 / 并5 = 0.8 ≥ 0.55 → dup
  const recent = [{ text: "ABCDEF", wallTs: 1000 }];
  assert.equal(isDuplicateSentence(recent, "ABCDEG", { refeedMs: 5000, zeroWall: 0, endMs: 0 }), true);
  // "ABCDEF" vs "XYZQRS"：0 交集 → 非 dup
  assert.equal(isDuplicateSentence(recent, "XYZQRS", { refeedMs: 5000, zeroWall: 0, endMs: 0 }), false);
});

test("isDuplicateSentence：zeroWall 缺省用 Date.now()", () => {
  const now = Date.now();
  const recent = [{ text: "砸自己的脚", wallTs: now }]; // 刚落的句
  // refeedMs 覆盖 now、endMs 落窗口内 → 命中
  assert.equal(isDuplicateSentence(recent, "砸自己的脚", { refeedMs: 5000, endMs: 100 }), true);
});
