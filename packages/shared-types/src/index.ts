// Source of truth: docs/module-contracts.md section 2.
// Everyone imports from here. Nobody redefines these locally.
// If you need a new field or type, add it here AND in the doc, in the same PR.

export type CallId = string; // a UUID per call
export type Speaker = "caller" | "victim";

export type Signal =
  | "IMPERSONATION"
  | "URGENCY"
  | "SECRECY"
  | "UNTRACEABLE_PAYMENT"
  | "REMOTE_ACCESS"
  | "CREDENTIAL_REQUEST"
  | "THREAT"
  | "VICTIM_COMPLIANCE"
  | "VICTIM_DISCLOSURE"
  | "VICTIM_RESISTANCE";

export type RiskLevel = "low" | "elevated" | "high"; // 0-39, 40-69, 70-100

export interface Guardian {
  name: string;
  phone: string; // E.164, e.g. "+13055551234"
}

export interface Turn {
  // one committed (final) utterance
  segmentId: string;
  speaker: Speaker;
  text: string;
  startMs: number; // relative to call start
  endMs: number;
}

// ---------------------------------------------------------------------------
// Call ingestion (§3.1) - published by apps/server/src/call-ingestion
// ---------------------------------------------------------------------------

export interface CallStarted {
  type: "call.started";
  callId: CallId;
  source: "twilio" | "webrtc";
  from?: string; // caller's number, if known
  to?: string; // victim's number
  guardian: Guardian; // hard-coded config for the demo
  ts: number;
}

export interface AudioFrame {
  type: "audio.frame";
  callId: CallId;
  speaker: Speaker; // from the participant's role, not inferred
  encoding: "mulaw" | "pcm16";
  sampleRate: 8000 | 16000;
  payload: string; // base64 audio, ~20ms per frame
  seq: number; // increasing per speaker
  ts: number;
}

export interface CallEnded {
  type: "call.ended";
  callId: CallId;
  reason: "hangup" | "error" | "manual";
  ts: number;
}

// ---------------------------------------------------------------------------
// STT adapters (§3.2) - published by apps/server/src/stt-adapters
// ---------------------------------------------------------------------------

export interface TranscriptEvent {
  type: "transcript";
  callId: CallId;
  speaker: Speaker;
  segmentId: string; // partials share an ID until the final replaces them
  text: string; // full text of the segment so far, not a delta
  isFinal: boolean; // false = partial, true = committed
  startMs: number;
  endMs: number;
  confidence?: number; // 0-1 if the vendor provides it
  ts: number;
}

export type SttProvider = "elevenlabs" | "deepgram" | "azure";

export interface SttSession {
  sendAudio(frame: AudioFrame): void;
  close(): Promise<void>;
}

export interface SttAdapter {
  name: SttProvider;
  openSession(
    callId: CallId,
    speaker: Speaker,
    onTranscript: (e: TranscriptEvent) => void
  ): SttSession;
}

// ---------------------------------------------------------------------------
// The event bus's type map (§1)
// ---------------------------------------------------------------------------
// Each key is an event's `type` literal; each value is that event's payload.
// As a workstream lands, add its events here so the bus stays fully typed.
//
// MERGE NOTE: when the LLM/rules/score/alert types land, add their events to this
// map in the same change — a module cannot subscribe to an event that isn't here.
// Expected keys: "rules.hits" (§3.4), "llm.result" (§3.5), "score.updated" and
// "alert.triggered" (§3.6), "alert.sent" (§3.7). Shapes are in the contract doc.
// Note §3.7 changed: AlertSent.channel is "browser", not "sms" — Twilio is gone.

export interface GuardianEventMap {
  "call.started": CallStarted;
  "audio.frame": AudioFrame;
  "call.ended": CallEnded;
  transcript: TranscriptEvent;
}

export type GuardianEventType = keyof GuardianEventMap;
export type GuardianEvent = GuardianEventMap[GuardianEventType];
