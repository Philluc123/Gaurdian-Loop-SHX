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

// --- LLM classifier (docs/module-contracts.md section 3.5) ---

export interface LLMRequest {
  callId: CallId;
  seq: number;
  trigger: "rule" | "victim" | "heartbeat";
  state: {
    score: number;
    signals: Signal[];
    elapsedSec: number;
    carryContext: string; // e.g. "caller claims to be from Medicare"
  };
  turns: Array<{ speaker: Speaker; text: string }>; // last 4-6 final turns
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

// --- Score engine (docs/module-contracts.md section 3.6) ---

export interface ScoreTick {
  type: "tick";
  ts: number;
}

export interface ScoreState {
  score: number;
  floor: number; // minimum set by hard rule combos; LLM can't go below it
  level: RiskLevel;
  signals: Partial<Record<Signal, { source: "rules" | "llm" | "both"; firstSeenMs: number }>>;
  alertArmed: boolean; // re-arms after score drops well below threshold
  lastReason: string;
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

// --- STT adapter output (docs/module-contracts.md section 3.2) ---

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
  | { type: "call_ended"; callId: CallId; ts: number };

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

// TODO(workstream owners): as each module's events stabilize, add their
// interfaces here too (CallStarted, AudioFrame, CallEnded) so both apps/server
// and apps/dashboard import the same definitions. Full shapes are in
// docs/module-contracts.md section 3.
