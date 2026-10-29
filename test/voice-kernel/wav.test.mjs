// wav 单测：标准头字段
import { test } from "node:test";
import assert from "node:assert/strict";
import { wavHeader, WAV_HEADER_SIZE, WAV_MAX_DATA, BYTES_PER_SEC } from "../../src/vendor/voice-kernel/wav.mjs";

test("默认参数：16kHz/mono/16bit 标准头 44 字节", () => {
  const h = wavHeader(32000); // 1s 音频
  assert.equal(h.length, WAV_HEADER_SIZE);
  assert.equal(h.toString("ascii", 0, 4), "RIFF");
  assert.equal(h.readUInt32LE(4), 36 + 32000);
  assert.equal(h.toString("ascii", 8, 12), "WAVE");
  assert.equal(h.toString("ascii", 12, 16), "fmt ");
  assert.equal(h.readUInt32LE(16), 16); // fmt chunk 长度
  assert.equal(h.readUInt16LE(20), 1); // PCM
  assert.equal(h.readUInt16LE(22), 1); // mono
  assert.equal(h.readUInt32LE(24), 16000); // 采样率
  assert.equal(h.readUInt32LE(28), BYTES_PER_SEC); // 32000 字节/秒
  assert.equal(h.readUInt16LE(32), 2); // block align
  assert.equal(h.readUInt16LE(34), 16); // 位深
  assert.equal(h.toString("ascii", 36, 40), "data");
  assert.equal(h.readUInt32LE(40), 32000);
});

test("参数化：48kHz/stereo/24bit", () => {
  const h = wavHeader(1000, { sampleRate: 48000, channels: 2, bitsPerSample: 24 });
  assert.equal(h.readUInt32LE(24), 48000);
  assert.equal(h.readUInt16LE(22), 2);
  assert.equal(h.readUInt16LE(34), 24);
  assert.equal(h.readUInt16LE(32), 6); // 2ch × 24bit / 8
  assert.equal(h.readUInt32LE(28), 48000 * 6);
});

test("常量：头长 44，数据上限为 32bit 域-44", () => {
  assert.equal(WAV_HEADER_SIZE, 44);
  assert.equal(WAV_MAX_DATA, 0xffffffff - 44);
});

test("零长度与大数据：头本身仍合法", () => {
  const h0 = wavHeader(0);
  assert.equal(h0.readUInt32LE(4), 36);
  const hBig = wavHeader(WAV_MAX_DATA);
  assert.equal(hBig.readUInt32LE(4), 36 + WAV_MAX_DATA);
});
