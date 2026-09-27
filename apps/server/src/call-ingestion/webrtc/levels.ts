// Frame loudness, and the silence used to replace a gated frame.
//
// The mu-law decoder mirrors the encoder in scripts/lib/audio.ts. It's duplicated
// rather than imported because that file is Node tooling (it reads from disk) and
// the server shouldn't depend on scripts/.

import type { AudioFrame } from "@guardian-loop/shared-types";

/** Quietest level we report, standing in for -Infinity on a silent frame. */
export const SILENT_DBFS = -100;

/** mu-law byte -> signed 16-bit sample. 256-entry table, built once. */
const MULAW_DECODE = (() => {
  const table = new Int16Array(256);
  for (let i = 0; i < 256; i += 1) {
    const inverted = ~i & 0xff;
    const sign = inverted & 0x80;
    const exponent = (inverted >> 4) & 0x07;
    const mantissa = inverted & 0x0f;
    let sample = ((mantissa << 3) + 0x84) << exponent;
    sample -= 0x84;
    table[i] = sign !== 0 ? -sample : sample;
  }
  return table;
})();

/**
 * RMS of a frame, in dBFS (0 = full scale, negative = quieter).
 * dB is the right unit here because the gate compares two mics by ratio, and
 * speech levels span orders of magnitude.
 */
export function frameDbfs(payload: Buffer, encoding: AudioFrame["encoding"]): number {
  let sumSquares = 0;
  let count = 0;

  if (encoding === "mulaw") {
    for (let i = 0; i < payload.length; i += 1) {
      const sample = MULAW_DECODE[payload[i]] / 32768;
      sumSquares += sample * sample;
      count += 1;
    }
  } else {
    // pcm16, little-endian. An odd trailing byte can't form a sample.
    for (let i = 0; i + 1 < payload.length; i += 2) {
      const sample = payload.readInt16LE(i) / 32768;
      sumSquares += sample * sample;
      count += 1;
    }
  }

  if (count === 0) return SILENT_DBFS;
  const rms = Math.sqrt(sumSquares / count);
  if (rms <= 0) return SILENT_DBFS;
  return Math.max(SILENT_DBFS, 20 * Math.log10(rms));
}

/** A frame of digital silence in the same format and length. */
export function silenceLike(payload: Buffer, encoding: AudioFrame["encoding"]): Buffer {
  // mu-law encodes zero amplitude as 0xFF; pcm16 as zero bytes.
  return Buffer.alloc(payload.length, encoding === "mulaw" ? 0xff : 0x00);
}
