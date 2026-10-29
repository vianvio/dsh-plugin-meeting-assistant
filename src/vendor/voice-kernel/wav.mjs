// wav.mjs — 原子能力③：PCM → WAV 封装（16k/mono/16bit 标准头）

const SAMPLE_RATE = 16000;
const BYTES_PER_SEC = SAMPLE_RATE * 2; // 16bit mono

export const WAV_HEADER_SIZE = 44;
export const WAV_MAX_DATA = 0xffffffff - WAV_HEADER_SIZE; // 32-bit 长度域上限（约 27 小时）

/**
 * 生成 WAV 头（44 字节，标准 PCM/momo/16bit 可参数化）。
 * @param {number} dataSize PCM 字节数
 * @param {{sampleRate?: number, channels?: number, bitsPerSample?: number}} [opts]
 * @returns {Buffer}
 */
export function wavHeader(dataSize, { sampleRate = SAMPLE_RATE, channels = 1, bitsPerSample = 16 } = {}) {
  const blockAlign = (channels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const header = Buffer.alloc(WAV_HEADER_SIZE);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);
  return header;
}

export { SAMPLE_RATE, BYTES_PER_SEC };
