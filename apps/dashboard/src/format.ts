// Display strings only — how to *say* a signal or level, never how to compute one.

import type { RiskLevel, Signal, Speaker } from "@guardian-loop/shared-types";

export const SIGNAL_LABEL: Record<Signal, string> = {
  IMPERSONATION: "Impersonation",
  URGENCY: "Urgency",
  SECRECY: "Secrecy",
  UNTRACEABLE_PAYMENT: "Untraceable payment",
  REMOTE_ACCESS: "Remote access",
  CREDENTIAL_REQUEST: "Credential request",
  THREAT: "Threat",
  VICTIM_COMPLIANCE: "Victim complying",
  VICTIM_DISCLOSURE: "Victim disclosing",
  VICTIM_RESISTANCE: "Victim pushing back",
};

/** Highlight tone: caller tactics, the victim going along with them, or pushing back. */
export function signalTone(signal: Signal): "danger" | "caution" | "safe" {
  if (signal === "VICTIM_RESISTANCE") return "safe";
  if (signal === "VICTIM_COMPLIANCE" || signal === "VICTIM_DISCLOSURE") return "caution";
  return "danger";
}

export const LEVEL_LABEL: Record<RiskLevel, string> = {
  low: "Low risk",
  elevated: "Elevated risk",
  high: "High risk",
};

export const LEVEL_ICON: Record<RiskLevel, string> = { low: "✓", elevated: "!", high: "⚠" };

export const SPEAKER_LABEL: Record<Speaker, string> = { caller: "Caller", victim: "Protected person" };

/** mm:ss since call start. */
export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function timeOfDay(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
}

export function dateTime(ts: number): string {
  return new Date(ts).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
