// Tunables for the score engine. Everything numeric about "how risky is this
// call" lives here, so tuning against fixtures is an edit to this file only.

import type { Signal } from "@guardian-loop/shared-types";

/** Score at which `alert.triggered` fires (contract: 70 for the demo). */
export const ALERT_THRESHOLD = 70;

/** Once fired, the alert re-arms only after the score drops below this. */
export const REARM_BELOW = 50;

/** Points removed per `tick` (~1/s). Decay never goes below `floor`. */
export const DECAY_PER_TICK = 1;

/** A signal already backed by rules adds this fraction of its weight on repeat. */
export const REPEAT_FACTOR = 0.5;

/** How far each LLM result moves the score toward the LLM's own estimate. */
export const LLM_PULL = 0.5;
/**
 * LLM floor. Decay erases most of an LLM result before the next heartbeat, so a
 * scam that trips no rules could never reach the threshold on LLM pulls alone.
 * Two consecutive reads at or above this estimate (neither marked benign) set a
 * floor at the lower of the two — the same sticky minimum a hard rule combo sets.
 * Requiring two reads means one manipulated or mistaken read can't alert alone.
 */
export const LLM_FLOOR_MIN_ESTIMATE = 80;

/** Pull used instead when the LLM says the context is benign but scores higher. */
export const LLM_PULL_BENIGN_UP = 0.25;

/** Reason string the LLM classifier returns on error/timeout (contract §3.5). */
export const LLM_ERROR_REASON = "llm_error";

/** Signals that lower the score when a final rule hit reports them. */
export const PROTECTIVE_SIGNALS: ReadonlySet<Signal> = new Set<Signal>(["VICTIM_RESISTANCE"]);

export interface Combo {
  id: string;
  signals: Signal[];
  /** One-off points added the first time rule hits complete the combo. */
  bonus: number;
  /** Sticky minimum for the rest of the call (0 = soft combo, no floor). */
  floor: number;
}

// Only rule-backed signals (source "rules" or "both") complete a combo. The LLM's
// view of combos is already baked into its own score estimate.
export const COMBOS: Combo[] = [
  // Instant alert: a caller directly asking for sensitive information (Social Security,
  // bank, card, PIN, password, one-time code, Medicare number) is the scam itself, so it
  // alerts the family on that sentence rather than waiting for a second signal. A floor
  // of 85 clears ALERT_THRESHOLD, and it holds for the rest of the call.
  { id: "sensitive_info_request", signals: ["CREDENTIAL_REQUEST"], bonus: 50, floor: 85 },
  // Hard combos: each is a textbook scam pattern, so the floor alone crosses the threshold.
  { id: "secrecy+payment", signals: ["SECRECY", "UNTRACEABLE_PAYMENT"], bonus: 25, floor: 75 },
  { id: "impersonation+payment", signals: ["IMPERSONATION", "UNTRACEABLE_PAYMENT"], bonus: 20, floor: 75 },
  { id: "threat+payment", signals: ["THREAT", "UNTRACEABLE_PAYMENT"], bonus: 25, floor: 80 },
  { id: "impersonation+remote_access", signals: ["IMPERSONATION", "REMOTE_ACCESS"], bonus: 20, floor: 75 },
  { id: "impersonation+credential", signals: ["IMPERSONATION", "CREDENTIAL_REQUEST"], bonus: 20, floor: 75 },
  { id: "payment+compliance", signals: ["UNTRACEABLE_PAYMENT", "VICTIM_COMPLIANCE"], bonus: 25, floor: 85 },
  { id: "credential+disclosure", signals: ["CREDENTIAL_REQUEST", "VICTIM_DISCLOSURE"], bonus: 25, floor: 85 },
  // Soft combos: suspicious pressure tactics, worth a bump but not an alert on their own.
  { id: "urgency+threat", signals: ["URGENCY", "THREAT"], bonus: 10, floor: 0 },
  { id: "impersonation+urgency", signals: ["IMPERSONATION", "URGENCY"], bonus: 8, floor: 0 },
];

/** Human-readable labels used to build `reason` strings. */
export const SIGNAL_LABELS: Record<Signal, string> = {
  IMPERSONATION: "impersonation",
  URGENCY: "pressure to act now",
  SECRECY: "secrecy request",
  UNTRACEABLE_PAYMENT: "untraceable payment request",
  REMOTE_ACCESS: "remote access request",
  CREDENTIAL_REQUEST: "request for sensitive information",
  THREAT: "threats",
  VICTIM_COMPLIANCE: "protected person going along",
  VICTIM_DISCLOSURE: "protected person sharing personal info",
  VICTIM_RESISTANCE: "protected person pushing back",
};
