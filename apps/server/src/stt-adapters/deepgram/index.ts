// Deepgram streaming adapter (docs/module-contracts.md §3.2).
//
// One WebSocket per speaker. Audio is forwarded byte-for-byte in whatever format
// the AudioFrame carries — Deepgram accepts both linear16 and mu-law directly, so
// there is no transcoding step and nothing to go wrong in one.
//
// This file owns only the connection: query params, buffering, keepalive,
// reconnection and flush-on-close. Turning Deepgram's messages into
// TranscriptEvents is ./segments.ts, which is unit-tested on its own.

import { WebSocket } from "ws";
import type {
  AudioFrame,
  CallId,
  Speaker,
  SttAdapter,
  SttSession,
  TranscriptEvent,
} from "@guardian-loop/shared-types";
import { SegmentAssembler, type DeepgramMessage } from "./segments";

export interface DeepgramConfig {
  apiKey: string;
  model: string;
  /** Silence (ms) before Deepgram finalizes a segment. 300 suits conversation. */
  endpointingMs?: number;
  /**
   * Gap (ms) between words before UtteranceEnd fires. Deepgram sends interim
   * results about once a second, so values under 1000 buy nothing.
   */
  utteranceEndMs?: number;
  language?: string;
}

const DEEPGRAM_URL = "wss://api.deepgram.com/v1/listen";

/** Deepgram closes an idle socket after ~10s; stay well inside that. */
const KEEPALIVE_INTERVAL_MS = 5_000;

/** Bound the reconnect buffer so a long outage can't grow memory without limit. */
const MAX_BUFFERED_FRAMES = 500; // ~10s of 20ms frames

const RECONNECT_BASE_MS = 250;
const RECONNECT_MAX_MS = 4_000;

/** How long to wait for Deepgram's closing results before giving up. */
const CLOSE_GRACE_MS = 2_000;

export function buildQuery(
  cfg: DeepgramConfig,
  encoding: AudioFrame["encoding"],
  sampleRate: number
): string {
  return new URLSearchParams({
    model: cfg.model,
    // mu-law (phone fixtures) and linear16 (browser capture) both pass straight through.
    encoding: encoding === "mulaw" ? "mulaw" : "linear16",
    sample_rate: String(sampleRate),
    channels: "1",
    // Required for UtteranceEnd, and what produces our partial events.
    interim_results: "true",
    endpointing: String(cfg.endpointingMs ?? 300),
    utterance_end_ms: String(cfg.utteranceEndMs ?? 1000),
    vad_events: "true",
    smart_format: "true",
    punctuate: "true",
    language: cfg.language ?? "en",
  }).toString();
}

/** Bytes per sample, used to convert audio sent into a millisecond offset. */
function bytesPerSample(encoding: AudioFrame["encoding"]): number {
  return encoding === "mulaw" ? 1 : 2;
}

class DeepgramSession implements SttSession {
  private ws: WebSocket | undefined;
  private readonly pending: Buffer[] = [];
  private readonly assembler: SegmentAssembler;

  private keepalive: NodeJS.Timeout | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private reconnectAttempts = 0;
  private closing = false;
  private onClosed: (() => void) | undefined;

  /** Total audio (ms) handed to Deepgram across every connection this session had. */
  private audioMsSent = 0;

  private encoding: AudioFrame["encoding"] = "mulaw";
  private sampleRate = 8000;

  constructor(
    private readonly cfg: DeepgramConfig,
    private readonly callId: CallId,
    private readonly speaker: Speaker,
    onTranscript: (e: TranscriptEvent) => void
  ) {
    this.assembler = new SegmentAssembler({ callId, speaker, emit: onTranscript });
  }

  sendAudio(frame: AudioFrame): void {
    if (this.closing) return;

    const audio = Buffer.from(frame.payload, "base64");
    if (audio.length === 0) return;

    // The first frame tells us the format, so the socket opens lazily rather
    // than guessing the encoding at construction time.
    if (!this.ws) {
      this.encoding = frame.encoding;
      this.sampleRate = frame.sampleRate;
      this.connect();
    }

    this.audioMsSent += audio.length / bytesPerSample(this.encoding) / (this.sampleRate / 1000);

    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(audio);
      return;
    }

    // Connecting or reconnecting: hold the audio rather than lose words.
    this.pending.push(audio);
    if (this.pending.length > MAX_BUFFERED_FRAMES) this.pending.shift();
  }

  private connect(): void {
    const url = `${DEEPGRAM_URL}?${buildQuery(this.cfg, this.encoding, this.sampleRate)}`;
    this.assembler.setConnectionOffsetMs(this.audioMsSent);

    const ws = new WebSocket(url, { headers: { Authorization: `Token ${this.cfg.apiKey}` } });
    this.ws = ws;

    ws.on("open", () => {
      this.reconnectAttempts = 0;
      for (const chunk of this.pending) ws.send(chunk);
      this.pending.length = 0;

      this.keepalive = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "KeepAlive" }));
        }
      }, KEEPALIVE_INTERVAL_MS);
    });

    ws.on("message", (data) => this.handleMessage(data as Buffer));

    ws.on("close", (code, reason) => {
      this.clearKeepalive();
      if (this.closing) {
        this.assembler.flush(); // commit anything Deepgram finalized on the way out
        this.onClosed?.();
        return;
      }
      console.warn(
        `[deepgram:${this.speaker}] socket closed (${code}${
          reason?.length ? ` ${reason.toString()}` : ""
        }) — reconnecting`
      );
      this.scheduleReconnect();
    });

    ws.on("error", (err) => {
      // 'close' always follows, which is where the reconnect gets scheduled.
      console.error(`[deepgram:${this.speaker}] socket error:`, err.message);
    });
  }

  private scheduleReconnect(): void {
    if (this.closing || this.reconnectTimer) return;
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** this.reconnectAttempts);
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (!this.closing) this.connect();
    }, delay);
  }

  private clearKeepalive(): void {
    if (this.keepalive) clearInterval(this.keepalive);
    this.keepalive = undefined;
  }

  private handleMessage(data: Buffer): void {
    let msg: DeepgramMessage;
    try {
      msg = JSON.parse(data.toString("utf8"));
    } catch {
      return;
    }
    if (msg.type === "Error" || "error" in msg) {
      console.error(`[deepgram:${this.speaker}] api error:`, data.toString("utf8"));
      return;
    }
    this.assembler.handleMessage(msg);
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.clearKeepalive();

    const ws = this.ws;
    if (!ws || ws.readyState === WebSocket.CLOSED) {
      this.assembler.flush();
      return;
    }

    // CloseStream asks Deepgram to transcribe what's buffered and then finish,
    // so the last words before a hangup still arrive as finals.
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        ws.terminate();
        this.assembler.flush();
        finish();
      }, CLOSE_GRACE_MS);
      this.onClosed = finish;

      try {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "CloseStream" }));
        } else {
          ws.close();
        }
      } catch {
        this.assembler.flush();
        finish();
      }
    });
  }
}

export function createDeepgramAdapter(cfg: DeepgramConfig): SttAdapter {
  if (!cfg.apiKey) {
    console.warn("[deepgram] no API key configured — sessions will fail to connect");
  }
  return {
    name: "deepgram",
    openSession(callId, speaker, onTranscript) {
      return new DeepgramSession(cfg, callId, speaker, onTranscript);
    },
  };
}

export { SegmentAssembler } from "./segments";
