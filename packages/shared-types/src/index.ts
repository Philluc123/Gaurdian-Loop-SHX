// Source of truth: docs/module-contracts.md section 2.
// Everyone imports from here. Nobody redefines these locally.
// If you need a new field or type, add it here AND in the doc, in the same PR.

export type CallId = string; // UUID assigned when the WebRTC session starts
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

// --- Call ingestion (docs/module-contracts.md section 3.1) ---

export interface CallStarted {
  type: "call.started";
  callId: CallId;
  source: "webrtc";
  from?: string; // display label, e.g. "room:demo" — not a phone number
  to?: string;
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

// --- STT adapter (docs/module-contracts.md section 3.2) ---

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

export type SttProvider = "deepgram";

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

// --- Rules classifier (docs/module-contracts.md section 3.4) ---

export interface RuleHit {
  ruleId: string; // e.g. "payment.gift_card"
  signal: Signal;
  weight: number; // points this hit contributes
  match: string; // matched text
  start: number; // character offsets in `text`,
  end: number; //   used for dashboard highlighting
}

export interface RulesHitsEvent {
  type: "rules.hits";
  callId: CallId;
  segmentId: string;
  speaker: Speaker;
  isFinal: boolean; // partial hits = highlight only; final hits = scoring
  hits: RuleHit[];
  ts: number;
}

// --- LLM classifier (docs/module-contracts.md section 3.5) ---

export interface LLMRequest {
  callId: CallId;
  seq: number;
  trigger: "rule" | "victim" | "heartbeat" | "final"; // final: the call just ended
  state: {
    score: number;
    signals: Signal[];
    elapsedSec: number;
    carryContext: string; // e.g. "caller claims to be from Medicare"
  };
  turns: Array<{ speaker: Speaker; text: string }>; // final turns in the rolling window (<=10)
}

export interface LLMResult {
  type: "llm.result";
  callId: CallId;
  seq: number; // echoed back for staleness checks
  signals: Signal[];
  score: number; // Gemini's own 0-100 estimate
  benignContext: boolean; // true if context suggests a legitimate call
  reason: string; // one line, max ~15 words; "llm_error" on failure
  carryContext: string; // updated one-line memory for next call
  latencyMs: number;
  model: string;
  ts: number;
}

// --- Score engine (docs/module-contracts.md section 3.6) ---

export interface ScoreTick {
  type: "tick";
  ts: number;
}

export interface ScoreState {
  score: number;
  floor: number; // sticky minimum: hard rule combos, or two consecutive confident LLM reads
  level: RiskLevel;
  signals: Partial<Record<Signal, { source: "rules" | "llm" | "both"; firstSeenMs: number }>>;
  alertArmed: boolean; // re-arms after score drops well below threshold
  lastReason: string;
  lastLlmScore: number | null; // previous successful LLM estimate, for the LLM floor
}

export interface ScoreUpdated {
  type: "score.updated";
  callId: CallId;
  score: number;
  level: RiskLevel;
  signals: Signal[];
  reason: string; // latest human-readable explanation
  source: "rules" | "llm" | "decay";
  ts: number;
}

export interface AlertTriggered {
  type: "alert.triggered";
  callId: CallId;
  alertId: string;
  score: number;
  threshold: number; // 70 for the demo
  reason: string;
  snippet: Array<{ speaker: Speaker; text: string }>; // last 2-3 turns
  ts: number;
}

// --- Alerts (docs/module-contracts.md section 3.7) ---

export interface AlertSent {
  type: "alert.sent";
  callId: CallId;
  alertId: string;
  channel: "notification";
  status: "sent" | "failed"; // "sent" = provider accepted it, not device delivery
  providerId?: string; // notification provider message ID
  error?: string;
  ts: number;
}

// --- Guardian dashboard WebSocket (docs/module-contracts.md section 3.8) ---

export interface HighlightSpan {
  start: number; // character offsets into the segment's text
  end: number;
  signal: Signal;
}

export interface SegmentHighlight extends HighlightSpan {
  segmentId: string;
}

export interface DashboardSnapshot {
  callId: CallId;
  startedAt: number;
  turns: Turn[];
  score: number;
  level: RiskLevel;
  signals: Signal[];
  highlights: SegmentHighlight[];
  alerts: AlertTriggered[];
}

export type ClientMsg =
  | { type: "subscribe"; callId: CallId | "latest" }
  | { type: "ack_alert"; alertId: string }
  | { type: "join_call"; callId: CallId }; // stretch

export type ServerMsg =
  | { type: "snapshot"; call: DashboardSnapshot }
  | { type: "transcript"; event: TranscriptEvent } // partials and finals
  | { type: "highlights"; segmentId: string; isFinal: boolean; spans: HighlightSpan[] }
  | { type: "score"; event: ScoreUpdated }
  | { type: "alert"; event: AlertTriggered; delivery?: AlertSent["status"] }
  | { type: "call_ended"; callId: CallId; ts: number }
  // The guardian notification itself (§3.7): the alerts module's template output,
  // delivered to every connected dashboard whatever call it follows, so the
  // guardian is reached even on the History page. The dashboard raises it as a
  // browser notification; `alertId` doubles as the notification tag, so a retry
  // or a second open tab replaces it rather than stacking a duplicate.
  | {
      type: "notification";
      callId: CallId;
      alertId: string;
      title: string;
      body: string;
      url?: string;
    };

// --- Call history REST (docs/module-contracts.md sections 3.8, 3.9) ---

// GET /api/calls -> CallSummary[]; one row of the `calls` collection, with `_id`
// exposed as `callId`.
export interface CallSummary {
  callId: CallId;
  source: "webrtc";
  from?: string;
  to?: string;
  guardian: Guardian;
  startedAt: number;
  endedAt?: number; // absent while the call is live
  maxScore: number;
  finalLevel: RiskLevel;
  alertCount: number;
}

// One row of the `events` collection.
export interface StoredEvent {
  callId: CallId;
  ts: number;
  type: string;
  payload: object;
}

// GET /api/calls/:callId -> CallRecord; events ordered by ts ascending.
export interface CallRecord {
  call: CallSummary;
  events: StoredEvent[];
}

// --- The event bus's type map (docs/module-contracts.md section 1) ---
//
// Each key is an event's `type` literal; each value is that event's payload. The
// server's bus is typed against this, so a module can only publish or subscribe to
// events listed here — add a new event to this map in the same change that adds it.
//
// ScoreTick is deliberately absent: it carries no callId and is the orchestrator's
// internal clock for the score engine, not something other modules observe.

export interface GuardianEventMap {
  "call.started": CallStarted;
  "audio.frame": AudioFrame;
  "call.ended": CallEnded;
  transcript: TranscriptEvent;
  "rules.hits": RulesHitsEvent;
  "llm.result": LLMResult;
  "score.updated": ScoreUpdated;
  "alert.triggered": AlertTriggered;
  "alert.sent": AlertSent;
}

export type GuardianEventType = keyof GuardianEventMap;
export type GuardianEvent = GuardianEventMap[GuardianEventType];
