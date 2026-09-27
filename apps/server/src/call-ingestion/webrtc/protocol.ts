// The wire protocol between the browser call page and this module.
//
// One WebSocket per participant carries both roles of traffic:
//   - TEXT frames   = JSON control messages (join, SDP, ICE, bye)
//   - BINARY frames = captured microphone audio
//
// Multiplexing them means one connection to manage per participant, so a socket
// closing is unambiguously "that person left" — no reconciling two lifecycles.

import type { AudioFrame, CallId, Speaker } from "@guardian-loop/shared-types";

/** Audio frame duration. 20ms matches what telephony and Deepgram both expect. */
export const FRAME_MS = 20;

/**
 * Binary audio frame layout (big-endian):
 *   [0..3] uint32  elapsedMs since this participant started capturing
 *   [4..5] uint16  seq, wrapping; the server keeps its own monotonic counter
 *   [6..]  payload pcm16 (little-endian samples) or mu-law
 *
 * elapsedMs is the client's own capture clock, which is what lets the
 * attribution gate line the two tracks up — arrival order can't be trusted,
 * because the two sockets jitter independently.
 */
export const AUDIO_HEADER_BYTES = 6;

export interface CaptureFormat {
  encoding: AudioFrame["encoding"];
  sampleRate: AudioFrame["sampleRate"];
  frameMs: number;
}

export type WebRtcClientMessage =
  | { type: "join"; room: string; role: Speaker; secret?: string }
  | { type: "offer"; sdp: string }
  | { type: "answer"; sdp: string }
  | { type: "ice"; candidate: unknown }
  | { type: "bye" };

export type WebRtcServerMessage =
  | {
      type: "joined";
      callId: CallId;
      role: Speaker;
      peerPresent: boolean;
      iceServers: Array<{ urls: string }>;
      capture: CaptureFormat;
    }
  | { type: "peer-joined"; role: Speaker }
  | { type: "peer-left"; role: Speaker }
  | { type: "offer"; sdp: string }
  | { type: "answer"; sdp: string }
  | { type: "ice"; candidate: unknown }
  /** Whether this participant's audio is currently being gated, for live tuning. */
  | { type: "gate"; suppressed: boolean }
  | { type: "error"; code: WebRtcErrorCode; message: string };

export type WebRtcErrorCode =
  | "bad_message"
  | "bad_secret"
  | "bad_role"
  | "room_full"
  | "not_joined";

export interface DecodedAudioFrame {
  elapsedMs: number;
  seq: number;
  payload: Buffer;
}

/** Returns null for anything too short to be a frame, rather than throwing. */
export function decodeAudioFrame(data: Buffer): DecodedAudioFrame | null {
  if (data.length <= AUDIO_HEADER_BYTES) return null;
  return {
    elapsedMs: data.readUInt32BE(0),
    seq: data.readUInt16BE(4),
    payload: data.subarray(AUDIO_HEADER_BYTES),
  };
}

/** Used by scripts/fake-webrtc.ts to speak the same protocol as the browser. */
export function encodeAudioFrame(elapsedMs: number, seq: number, payload: Buffer): Buffer {
  const header = Buffer.allocUnsafe(AUDIO_HEADER_BYTES);
  header.writeUInt32BE(elapsedMs >>> 0, 0);
  header.writeUInt16BE(seq & 0xffff, 4);
  return Buffer.concat([header, payload]);
}

export function parseClientMessage(raw: string): WebRtcClientMessage | null {
  try {
    const msg = JSON.parse(raw) as WebRtcClientMessage;
    return msg && typeof msg.type === "string" ? msg : null;
  } catch {
    return null;
  }
}

export function isSpeaker(value: unknown): value is Speaker {
  return value === "caller" || value === "victim";
}

export function otherRole(role: Speaker): Speaker {
  return role === "caller" ? "victim" : "caller";
}
