// Env loading and validation for the whole service. Reads `.env` from the repo
// root (not from apps/server), so one file serves every workspace.
//
// Keep this the only place that touches process.env — modules take their config
// as arguments, which is what keeps them testable without a .env present.

import path from "node:path";
import dotenv from "dotenv";
import type { AudioFrame, Guardian, SttProvider } from "@guardian-loop/shared-types";

dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

/**
 * Editors and hand-written .env files often leave a trailing comment on the
 * same line (`STT_PROVIDER=deepgram # deepgram | azure`). dotenv keeps that as
 * part of the value, which silently breaks string comparisons, so strip it.
 * Only strips when whitespace precedes the `#`, so values that legitimately
 * contain one (an API key, a URL fragment) survive.
 */
function clean(raw: string | undefined): string {
  if (raw === undefined) return "";
  return raw
    .replace(/\s+#.*$/, "")
    .trim()
    .replace(/^["'](.*)["']$/, "$1");
}

function str(name: string, fallback = ""): string {
  const value = clean(process.env[name]);
  return value === "" ? fallback : value;
}

function bool(name: string, fallback: boolean): boolean {
  const value = clean(process.env[name]).toLowerCase();
  if (value === "") return fallback;
  return value === "1" || value === "true" || value === "yes";
}

function int(name: string, fallback: number): number {
  const value = Number.parseInt(clean(process.env[name]), 10);
  return Number.isFinite(value) ? value : fallback;
}

/** Paths the browser clients connect to. */
export const CALL_PAGE_PATH = "/call";
/**
 * One socket per participant carries both signalling and audio. Two endpoints
 * would mean reconciling two lifecycles per person for no benefit.
 */
export const WEBRTC_WS_PATH = "/webrtc/ws";

export interface ServerConfig {
  port: number;
  /**
   * Public https:// origin the browsers load from, no trailing slash.
   * getUserMedia needs a secure context, so phones and second laptops must reach
   * this over https (a tunnel) — plain http on a LAN IP has the mic blocked.
   */
  publicBaseUrl: string;
  dashboardWsPath: string;
}

export interface WebRtcConfig {
  /** Shared secret required to join a room, since the tunnel URL is public. */
  roomSecret: string;
  /**
   * Wire format the browsers capture and send. pcm16/16000 is the default and
   * the better-sounding choice; mulaw/8000 mimics a phone codec, which is worth
   * checking occasionally since real scam calls arrive that way.
   */
  encoding: AudioFrame["encoding"];
  sampleRate: AudioFrame["sampleRate"];
  /** ICE servers offered to the browsers. Same-room peers resolve on the LAN. */
  stunUrls: string[];
  /**
   * Speaker-attribution gate: with two open mics in one room, each mic hears
   * both people. Modelled on a gating automixer — the dominant track stays live
   * and the other is silenced while it's clearly quieter.
   */
  gate: {
    enabled: boolean;
    /** How much louder (dB) one track must be to silence the other. */
    dominanceDb: number;
    /** Keep a track live this long after it stops dominating, so words survive. */
    hangoverMs: number;
    /** Never gate when both tracks are below this RMS (dBFS) — nobody's talking. */
    floorDbfs: number;
  };
}

export interface SttConfig {
  provider: SttProvider;
  deepgram: { apiKey: string; model: string };
}

function provider(name: string, fallback: SttProvider): SttProvider {
  const value = str(name).toLowerCase();
  if (value === "deepgram" || value === "elevenlabs" || value === "azure") return value;
  if (value !== "") {
    console.warn(`[config] ${name}="${value}" is not a known STT provider; using "${fallback}"`);
  }
  return fallback;
}

export function loadServerConfig(): ServerConfig {
  return {
    port: int("PORT", 3000),
    publicBaseUrl: str("PUBLIC_BASE_URL").replace(/\/+$/, ""),
    dashboardWsPath: str("DASHBOARD_WS_PATH", "/ws/dashboard"),
  };
}

export function loadWebRtcConfig(): WebRtcConfig {
  const encoding: AudioFrame["encoding"] = str("WEBRTC_ENCODING", "pcm16") === "mulaw" ? "mulaw" : "pcm16";
  // mu-law only makes sense at the telephony rate; pcm16 defaults to 16kHz.
  const sampleRate: AudioFrame["sampleRate"] =
    encoding === "mulaw" ? 8000 : int("WEBRTC_SAMPLE_RATE", 16000) === 8000 ? 8000 : 16000;

  return {
    roomSecret: str("WEBRTC_ROOM_SECRET"),
    encoding,
    sampleRate,
    stunUrls: str("WEBRTC_STUN_URLS", "stun:stun.l.google.com:19302")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    gate: {
      enabled: bool("WEBRTC_GATE", true),
      dominanceDb: int("WEBRTC_GATE_DOMINANCE_DB", 9),
      hangoverMs: int("WEBRTC_GATE_HANGOVER_MS", 300),
      floorDbfs: int("WEBRTC_GATE_FLOOR_DBFS", -50),
    },
  };
}

export function loadGuardian(): Guardian {
  return {
    name: str("GUARDIAN_NAME", "Guardian"),
    phone: str("GUARDIAN_PHONE"),
  };
}

export function loadSttConfig(): SttConfig {
  return {
    provider: provider("STT_PROVIDER", "deepgram"),
    deepgram: {
      apiKey: str("DEEPGRAM_API_KEY"),
      model: str("DEEPGRAM_MODEL", "nova-3"),
    },
  };
}

/**
 * Warn loudly about config that would only fail later, mid-call, when it's much
 * harder to debug. Never throws — a missing Deepgram key should still let you
 * boot and exercise the call path.
 */
export function warnAboutGaps(server: ServerConfig, stt: SttConfig, webrtc: WebRtcConfig): void {
  if (!server.publicBaseUrl.startsWith("https://")) {
    console.warn(
      "[config] PUBLIC_BASE_URL is not an https:// origin. Browsers other than localhost " +
        "need a secure context for getUserMedia — start a tunnel and set it."
    );
  }
  if (stt.provider === "deepgram" && !stt.deepgram.apiKey) {
    console.warn("[config] DEEPGRAM_API_KEY is empty — transcription will not start.");
  }
  if (!webrtc.roomSecret) {
    console.warn(
      "[config] WEBRTC_ROOM_SECRET is empty — anyone who finds the tunnel URL can join a call."
    );
  }
}
