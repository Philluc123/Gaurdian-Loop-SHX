// SMS template (docs/module-contracts.md §3.7). Pure: AlertTriggered in, body out.
//
// The quote and reason come straight from the event (snippet / reason) — this
// module never regenerates them, only trims them to fit the length budget.

import type { AlertTriggered, CallId } from "@guardian-loop/shared-types";

/** Contract says "keep under ~300 characters". */
export const MAX_SMS_CHARS = 300;

const ELLIPSIS = "…";

export function liveViewUrl(baseUrl: string, callId: CallId): string {
  return `${baseUrl.replace(/\/+$/, "")}/call/${encodeURIComponent(callId)}`;
}

/**
 * Builds the guardian SMS. The live-view line is omitted when `baseUrl` is
 * empty (no public host configured) rather than sending a dead link.
 * The quote is trimmed first, then the reason, so header and link always survive.
 */
export function buildSmsBody(alert: AlertTriggered, baseUrl: string | undefined): string {
  const header = `⚠️ Guardian Loop: possible scam call (risk ${alert.score}).`;
  const link = baseUrl ? `Live view: ${liveViewUrl(baseUrl, alert.callId)}` : "";
  let quote = pickQuote(alert.snippet);
  let reason = sentence(alert.reason.trim());

  const render = () =>
    [header, quote && `"${quote}"`, reason && `Why: ${reason}`, link].filter(Boolean).join("\n");

  let over = [...render()].length - MAX_SMS_CHARS;
  if (over > 0 && quote) {
    quote = truncate(quote, [...quote].length - over);
    over = [...render()].length - MAX_SMS_CHARS;
  }
  if (over > 0 && reason) {
    reason = truncate(reason, [...reason].length - over);
  }
  return render();
}

/** The most recent caller line is the most telling; fall back to the last turn. */
function pickQuote(snippet: AlertTriggered["snippet"]): string {
  const caller = [...snippet].reverse().find((t) => t.speaker === "caller" && t.text.trim());
  const turn = caller ?? [...snippet].reverse().find((t) => t.text.trim());
  return turn ? turn.text.trim().replace(/\s+/g, " ") : "";
}

function sentence(s: string): string {
  if (!s) return s;
  return /[.!?…]$/.test(s) ? s : `${s}.`;
}

/** Truncate to `max` code points (so emoji/surrogates never split), ending in "…". */
function truncate(s: string, max: number): string {
  const chars = [...s];
  if (chars.length <= max) return s;
  if (max <= 1) return "";
  return chars.slice(0, max - 1).join("").trimEnd() + ELLIPSIS;
}
