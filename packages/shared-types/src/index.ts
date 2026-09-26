// Source of truth: docs/module-contracts.md section 2.
// Everyone imports from here. Nobody redefines these locally.
// If you need a new field or type, add it here AND in the doc, in the same PR.

export type CallId = string; // Twilio CallSid, or a UUID for WebRTC calls
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

// TODO(workstream owners): as each module's events stabilize, add their
// interfaces here too (CallStarted, AudioFrame, TranscriptEvent, RuleHit,
// RulesHitsEvent, LLMRequest/LLMResult, ScoreState/ScoreUpdated/AlertTriggered,
// AlertSent, ClientMsg/ServerMsg) so both apps/server and apps/dashboard import
// the same definitions. Full shapes are in docs/module-contracts.md section 3.
