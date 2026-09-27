// WAV parsing and G.711 mu-law conversion, shared by the offline audio tooling.
//
// 8kHz mono mu-law is the telephony format: what a real scam call arrives as, and
// what the fixture audio is rendered to. Browser capture uses pcm16/16000 instead,
// so this is the path for phone-codec fixtures specifically.

import fs from "node:fs";

export const MULAW_SILENCE = 0xff; // mu-law encoding of zero amplitude
export const MULAW_SAMPLE_RATE = 8000;
export const FRAME_MS = 20;
/** 8000 samples/s * 0.02s * 1 byte/sample */
export const MULAW_FRAME_BYTES = (MULAW_SAMPLE_RATE / 1000) * FRAME_MS;

export const WAVE_FORMAT_PCM = 1;
export const WAVE_FORMAT_MULAW = 7;

export interface ParsedWav {
  audioFormat: number;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  data: Buffer;
}

/** Parse a RIFF/WAVE file by walking its chunks (never assume a 44-byte header). */
export function parseWav(filePath: string): ParsedWav {
  const buf = fs.readFileSync(filePath);
  if (buf.length < 12 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error(`${filePath} is not a RIFF/WAVE file`);
  }

  let audioFormat = 0;
  let channels = 1;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let data: Buffer | undefined;

  let offset = 12;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;

    if (id === "fmt ") {
      audioFormat = buf.readUInt16LE(body);
      channels = buf.readUInt16LE(body + 2);
      sampleRate = buf.readUInt32LE(body + 4);
      bitsPerSample = buf.readUInt16LE(body + 14);
    } else if (id === "data") {
      data = buf.subarray(body, Math.min(body + size, buf.length));
    }

    // Chunks are word-aligned, so an odd size is followed by a pad byte.
    offset = body + size + (size % 2);
  }

  if (!data) throw new Error(`${filePath} has no data chunk`);
  return { audioFormat, channels, sampleRate, bitsPerSample, data };
}

/**
 * G.711 mu-law encoder. The exponent lookup is the standard table, generated
 * rather than written out: entry i is floor(log2(i)), clamped at 0.
 */
const EXP_LUT: Uint8Array = (() => {
  const lut = new Uint8Array(256);
  for (let i = 0; i < 256; i += 1) lut[i] = i < 2 ? 0 : Math.floor(Math.log2(i));
  return lut;
})();

const MULAW_BIAS = 0x84;
const MULAW_CLIP = 32635;

export function linearToMulaw(sample: number): number {
  let sign = (sample >> 8) & 0x80;
  let magnitude = sign !== 0 ? -sample : sample;
  if (magnitude > MULAW_CLIP) magnitude = MULAW_CLIP;
  magnitude += MULAW_BIAS;

  const exponent = EXP_LUT[(magnitude >> 7) & 0xff];
  const mantissa = (magnitude >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

/** Downmix interleaved 16-bit PCM to mono Int16. */
function toMonoInt16(data: Buffer, channels: number): Int16Array {
  const total = Math.floor(data.length / 2);
  if (channels <= 1) {
    const mono = new Int16Array(total);
    for (let i = 0; i < total; i += 1) mono[i] = data.readInt16LE(i * 2);
    return mono;
  }
  const frames = Math.floor(total / channels);
  const mono = new Int16Array(frames);
  for (let f = 0; f < frames; f += 1) {
    let sum = 0;
    for (let c = 0; c < channels; c += 1) sum += data.readInt16LE((f * channels + c) * 2);
    mono[f] = Math.round(sum / channels);
  }
  return mono;
}

/** Linear-interpolation resample. Good enough for 8kHz speech fixtures. */
function resample(input: Int16Array, from: number, to: number): Int16Array {
  if (from === to) return input;
  const outLength = Math.max(1, Math.round((input.length * to) / from));
  const out = new Int16Array(outLength);
  const ratio = (input.length - 1) / Math.max(1, outLength - 1);
  for (let i = 0; i < outLength; i += 1) {
    const pos = i * ratio;
    const left = Math.floor(pos);
    const right = Math.min(input.length - 1, left + 1);
    const frac = pos - left;
    out[i] = Math.round(input[left] * (1 - frac) + input[right] * frac);
  }
  return out;
}

/** Convert any supported wav into 8kHz mono mu-law, the telephony format. */
export function toMulaw8k(wav: ParsedWav): Buffer {
  if (wav.audioFormat === WAVE_FORMAT_MULAW) {
    if (wav.sampleRate !== MULAW_SAMPLE_RATE) {
      throw new Error(
        `mu-law input must be ${MULAW_SAMPLE_RATE}Hz, got ${wav.sampleRate}Hz`
      );
    }
    return Buffer.from(wav.data);
  }
  if (wav.audioFormat !== WAVE_FORMAT_PCM || wav.bitsPerSample !== 16) {
    throw new Error(
      `unsupported wav: format ${wav.audioFormat}, ${wav.bitsPerSample}-bit. ` +
        `Use 16-bit PCM or 8kHz mu-law.`
    );
  }

  const mono = toMonoInt16(wav.data, wav.channels);
  const resampled = resample(mono, wav.sampleRate, MULAW_SAMPLE_RATE);
  const out = Buffer.allocUnsafe(resampled.length);
  for (let i = 0; i < resampled.length; i += 1) out[i] = linearToMulaw(resampled[i]);
  return out;
}

/** Wrap mu-law bytes in a WAV header, so fixtures are playable in any player. */
export function encodeMulawWav(mulaw: Buffer): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + mulaw.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(WAVE_FORMAT_MULAW, 20);
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(MULAW_SAMPLE_RATE, 24);
  header.writeUInt32LE(MULAW_SAMPLE_RATE, 28); // byte rate: 1 byte per sample
  header.writeUInt16LE(1, 32); // block align
  header.writeUInt16LE(8, 34); // bits per sample
  header.write("data", 36, "ascii");
  header.writeUInt32LE(mulaw.length, 40);
  return Buffer.concat([header, mulaw]);
}

export function mulawSilence(ms: number): Buffer {
  return Buffer.alloc(Math.max(0, Math.round((MULAW_SAMPLE_RATE / 1000) * ms)), MULAW_SILENCE);
}

export function mulawDurationMs(bytes: number): number {
  return (bytes / MULAW_SAMPLE_RATE) * 1000;
}
