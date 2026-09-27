// Streams wav files into the running server's call socket, speaking the same
// protocol the browser page does. Tests the whole ingestion -> STT chain with no
// second person, no second microphone, and no tunnel.
//
//   npm run fake-call -- --caller fixtures/audio/gift-card-medicare-scam-caller.wav \
//                        --victim fixtures/audio/gift-card-medicare-scam-victim.wav
//
// It skips only the browser half: getUserMedia, the AudioWorklet, and the
// peer-to-peer connection. Everything from the WebSocket inward is the real path,
// including the attribution gate — which is why it takes two files, so you can see
// the gate make decisions on overlapping audio.

import fs from "node:fs";
import { WebSocket } from "ws";
import type { Speaker } from "@guardian-loop/shared-types";
import {
  encodeAudioFrame,
  FRAME_MS,
} from "../apps/server/src/call-ingestion/webrtc/protocol";
import { parseWav, toMulaw8k, type ParsedWav } from "./lib/audio";

interface Args {
  caller?: string;
  victim?: string;
  url: string;
  room: string;
  secret: string;
  encoding: "pcm16" | "mulaw";
  sampleRate: number;
  speed: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    url: "ws://localhost:3000/webrtc/ws",
    room: `fake-${Date.now()}`,
    secret: process.env.WEBRTC_ROOM_SECRET ?? "",
    encoding: "pcm16",
    sampleRate: 16000,
    speed: 1,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i + 1];
    switch (argv[i]) {
      case "--caller": args.caller = value; i += 1; break;
      case "--victim": args.victim = value; i += 1; break;
      case "--url": args.url = value; i += 1; break;
      case "--room": args.room = value; i += 1; break;
      case "--secret": args.secret = value; i += 1; break;
      case "--encoding": args.encoding = value === "mulaw" ? "mulaw" : "pcm16"; i += 1; break;
      case "--sample-rate": args.sampleRate = Number(value) || 16000; i += 1; break;
      case "--speed": args.speed = Number(value) || 1; i += 1; break;
      default: break;
    }
  }

  if (!args.caller && !args.victim) {
    console.error(
      "usage: npm run fake-call -- --caller <wav> [--victim <wav>] [--room name] [--secret s]\n" +
        "                          [--encoding pcm16|mulaw] [--sample-rate 16000] [--speed 1]"
    );
    process.exit(1);
  }
  if (args.encoding === "mulaw") args.sampleRate = 8000;
  return args;
}

/** Bytes per frame for the chosen format: 20ms of mono audio. */
function frameBytes(encoding: Args["encoding"], sampleRate: number): number {
  const samples = (sampleRate / 1000) * FRAME_MS;
  return encoding === "mulaw" ? samples : samples * 2;
}

/** Downmix to mono Int16 at the target rate, by linear interpolation. */
function toMonoInt16(wav: ParsedWav, targetRate: number): Int16Array {
  const total = Math.floor(wav.data.length / 2);
  const channels = Math.max(1, wav.channels);
  const frames = Math.floor(total / channels);
  const mono = new Int16Array(frames);
  for (let f = 0; f < frames; f += 1) {
    let sum = 0;
    for (let c = 0; c < channels; c += 1) sum += wav.data.readInt16LE((f * channels + c) * 2);
    mono[f] = Math.round(sum / channels);
  }
  if (wav.sampleRate === targetRate) return mono;

  const outLength = Math.max(1, Math.round((mono.length * targetRate) / wav.sampleRate));
  const out = new Int16Array(outLength);
  const ratio = (mono.length - 1) / Math.max(1, outLength - 1);
  for (let i = 0; i < outLength; i += 1) {
    const pos = i * ratio;
    const left = Math.floor(pos);
    const right = Math.min(mono.length - 1, left + 1);
    const frac = pos - left;
    out[i] = Math.round(mono[left] * (1 - frac) + mono[right] * frac);
  }
  return out;
}

/** Convert a wav into exactly the bytes the browser would have sent. */
function loadAudio(file: string, args: Args): Buffer {
  const wav = parseWav(file);

  if (args.encoding === "mulaw") {
    // The fixtures are already 8kHz mu-law, so this is usually a passthrough.
    return toMulaw8k(wav);
  }

  // The fixture wavs are mu-law; decode to linear before resampling up.
  if (wav.audioFormat === 7) {
    const mulaw = toMulaw8k(wav);
    const linear = new Int16Array(mulaw.length);
    for (let i = 0; i < mulaw.length; i += 1) linear[i] = mulawToLinear(mulaw[i]);
    const resampled = resampleInt16(linear, 8000, args.sampleRate);
    return int16ToBuffer(resampled);
  }
  return int16ToBuffer(toMonoInt16(wav, args.sampleRate));
}

function int16ToBuffer(samples: Int16Array): Buffer {
  const buf = Buffer.allocUnsafe(samples.length * 2);
  for (let i = 0; i < samples.length; i += 1) buf.writeInt16LE(samples[i], i * 2);
  return buf;
}

function resampleInt16(input: Int16Array, from: number, to: number): Int16Array {
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

/** Inverse of linearToMulaw, for turning the mu-law fixtures back into pcm16. */
function mulawToLinear(byte: number): number {
  const inverted = ~byte & 0xff;
  const sign = inverted & 0x80;
  const exponent = (inverted >> 4) & 0x07;
  const mantissa = inverted & 0x0f;
  let sample = ((mantissa << 3) + 0x84) << exponent;
  sample -= 0x84;
  return sign !== 0 ? -sample : sample;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** One participant: its own socket, exactly like one browser. */
class FakeParticipant {
  private ws: WebSocket | undefined;
  private seq = 0;

  constructor(
    private readonly role: Speaker,
    private readonly audio: Buffer,
    private readonly args: Args
  ) {}

  get frameCount(): number {
    return Math.ceil(this.audio.length / frameBytes(this.args.encoding, this.args.sampleRate));
  }

  async connect(): Promise<void> {
    const ws = new WebSocket(this.args.url);
    this.ws = ws;
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });

    ws.on("message", (data: Buffer, isBinary: boolean) => {
      if (isBinary) return;
      const msg = JSON.parse(data.toString("utf8"));
      if (msg.type === "error") {
        console.error(`[fake-webrtc:${this.role}] server error: ${msg.message} (${msg.code})`);
        if (msg.code === "bad_secret") {
          console.error("  pass --secret <WEBRTC_ROOM_SECRET from .env>");
        }
        process.exit(1);
      }
      if (msg.type === "joined") {
        console.log(`[fake-webrtc:${this.role}] joined call ${msg.callId}`);
      }
      if (msg.type === "gate") {
        console.log(`[fake-webrtc:${this.role}] gate -> ${msg.suppressed ? "SUPPRESSED" : "live"}`);
      }
    });

    ws.send(
      JSON.stringify({
        type: "join",
        room: this.args.room,
        role: this.role,
        secret: this.args.secret,
      })
    );
  }

  /** Send the frame covering this slot, if this participant still has audio. */
  sendFrame(index: number, elapsedMs: number): void {
    const size = frameBytes(this.args.encoding, this.args.sampleRate);
    const offset = index * size;
    if (offset >= this.audio.length) return;
    if (this.ws?.readyState !== WebSocket.OPEN) return;

    const chunk = this.audio.subarray(offset, offset + size);
    this.seq += 1;
    this.ws.send(encodeAudioFrame(elapsedMs, this.seq, chunk), { binary: true });
  }

  bye(): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "bye" }));
    }
  }

  close(): void {
    this.ws?.close();
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const participants: FakeParticipant[] = [];

  for (const [role, file] of [
    ["caller", args.caller],
    ["victim", args.victim],
  ] as Array<[Speaker, string | undefined]>) {
    if (!file) continue;
    if (!fs.existsSync(file)) {
      console.error(`[fake-webrtc] no such file: ${file}`);
      process.exit(1);
    }
    const audio = loadAudio(file, args);
    const seconds = audio.length / frameBytes(args.encoding, args.sampleRate) / (1000 / FRAME_MS);
    console.log(
      `[fake-webrtc] ${role}: ${file} -> ${seconds.toFixed(1)}s of ` +
        `${args.encoding} @ ${args.sampleRate}Hz`
    );
    participants.push(new FakeParticipant(role, audio, args));
  }

  for (const p of participants) await p.connect();
  console.log(`[fake-webrtc] room "${args.room}" — streaming`);

  const totalFrames = Math.max(...participants.map((p) => p.frameCount));
  const interval = FRAME_MS / args.speed;
  const startedAt = Date.now();

  for (let frame = 0; frame < totalFrames; frame += 1) {
    const elapsedMs = frame * FRAME_MS;
    for (const p of participants) p.sendFrame(frame, elapsedMs);

    // Pace against the wall clock. Deepgram's endpointing is time-based, so
    // streaming faster than 1x moves where segments break.
    const wait = startedAt + (frame + 1) * interval - Date.now();
    if (wait > 0) await sleep(wait);

    if (frame > 0 && frame % 250 === 0) {
      console.log(`[fake-webrtc] ${(elapsedMs / 1000).toFixed(0)}s streamed`);
    }
  }

  for (const p of participants) p.bye();
  console.log("[fake-webrtc] sent bye; waiting for final transcripts");
  await sleep(2_500);
  for (const p of participants) p.close();
  console.log("[fake-webrtc] done");
}

main().catch((err) => {
  console.error("[fake-webrtc] failed:", err);
  process.exit(1);
});
