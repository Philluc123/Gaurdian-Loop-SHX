// Env loading and validation for the whole service. Reads `.env` from the repo
// root (not from apps/server), so one file serves every workspace.
//
// Keep this the only place that touches process.env — modules take their config
// as arguments, which is what keeps them testable without a .env present.

import path from "node:path";
import dotenv from "dotenv";
import type { AudioFrame, Guardian } from "@guardian-loop/shared-types";

const envFile = dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

// dotenv never overwrites a variable that's already set, so a stale key in the
// shell or the Windows user environment silently beats the one in .env. Say so
// (names only, never values).
const shadowed = Object.entries(envFile.parsed ?? {})
  .filter(([name, value]) => value !== "" && process.env[name] !== value)
  .map(([name]) => name);
if (shadowed.length > 0) {
  console.warn(
    `[config] ${shadowed.join(", ")} in .env ${shadowed.length === 1 ? "is" : "are"} overridden by ` +
      "a variable already set in the environment (shell or Windows user env). The .env value is ignored."
  );
}

/**
 * Editors and hand-written .env files often leave a trailing comment on the
 * same line (`DEEPGRAM_MODEL=nova-3 # or nova-2`). dotenv keeps that as
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
/**
 * The WebRTC call page. Not /call: the guardian dashboard owns /call/<callId> (§3.8),
 * and the alert notification links there (§3.7).
 */
export const CALL_PAGE_PATH = "/join";
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
  deepgram: { apiKey: string; model: string };
}

export interface LlmConfig {
  gemini: { apiKey: string; model: string };
  /**
   * Heartbeat: with new speech but no LLM call for this long, call it anyway. This
   * is what catches a caller who never says a rule keyword — without rule hits,
   * the heartbeat is the only thing that sends the conversation to the LLM.
   */
  heartbeatSec: number;
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
    deepgram: {
      apiKey: str("DEEPGRAM_API_KEY"),
      model: str("DEEPGRAM_MODEL", "nova-3"),
    },
  };
}

export function loadLlmConfig(): LlmConfig {
  return {
    gemini: {
      apiKey: str("GEMINI_API_KEY"),
      model: str("GEMINI_MODEL", "gemini-3.5-flash-lite"),
    },
    // 15s while testing; the contract's value is 30s. Set LLM_HEARTBEAT_SEC to override.
    heartbeatSec: int("LLM_HEARTBEAT_SEC", 15),
  };
}

/**
 * Warn loudly about config that would only fail later, mid-call, when it's much
 * harder to debug. Never throws — a missing Deepgram key should still let you
 * boot and exercise the call path.
 */
export function warnAboutGaps(
  server: ServerConfig,
  stt: SttConfig,
  webrtc: WebRtcConfig,
  llm: LlmConfig
): void {
  if (!server.publicBaseUrl.startsWith("https://")) {
    console.warn(
      "[config] PUBLIC_BASE_URL is not an https:// origin. Browsers other than localhost " +
        "need a secure context for getUserMedia — start a tunnel and set it."
    );
  }
  if (!stt.deepgram.apiKey) {
    console.warn("[config] DEEPGRAM_API_KEY is empty — transcription will not start.");
  }
  if (!llm.gemini.apiKey) {
    console.warn(
      "[config] GEMINI_API_KEY is empty — the LLM classifier is off; scoring runs on rules alone."
    );
  }
  if (!webrtc.roomSecret) {
    console.warn(
      "[config] WEBRTC_ROOM_SECRET is empty — anyone who finds the tunnel URL can join a call."
    );
  }
}
