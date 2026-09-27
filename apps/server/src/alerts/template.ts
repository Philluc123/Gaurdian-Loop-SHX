// Notification template (docs/module-contracts.md §3.7). Pure: AlertTriggered in,
// notification content out.
//
// The quote and reason come straight from the event (snippet / reason) — this
// module never regenerates them, only trims them to fit the length budget.

import type { AlertTriggered, CallId } from "@guardian-loop/shared-types";

/** Roughly what a lock-screen notification shows before truncating. */
export const MAX_NOTIFICATION_BODY_CHARS = 180;

const ELLIPSIS = "…";

export interface NotificationContent {
  title: string;
  body: string;
  url?: string; // opened when the guardian taps the notification
}

export function liveViewUrl(baseUrl: string, callId: CallId): string {
  return `${baseUrl.replace(/\/+$/, "")}/call/${encodeURIComponent(callId)}`;
}

/**
 * Builds the guardian notification. `url` is omitted when `baseUrl` is empty
 * (no public host configured) rather than linking somewhere dead.
 * The quote is trimmed first, then the reason, so the body stays within budget.
 */
export function buildNotification(alert: AlertTriggered, baseUrl: string | undefined): NotificationContent {
  const title = `⚠️ Possible scam call (risk ${alert.score})`;
  let quote = pickQuote(alert.snippet);
  let reason = sentence(alert.reason.trim());

  const render = () => [quote && `"${quote}"`, reason && `Why: ${reason}`].filter(Boolean).join("\n");

  let over = [...render()].length - MAX_NOTIFICATION_BODY_CHARS;
  if (over > 0 && quote) {
    quote = truncate(quote, [...quote].length - over);
    over = [...render()].length - MAX_NOTIFICATION_BODY_CHARS;
  }
  if (over > 0 && reason) {
    reason = truncate(reason, [...reason].length - over);
  }
  return { title, body: render(), ...(baseUrl ? { url: liveViewUrl(baseUrl, alert.callId) } : {}) };
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
