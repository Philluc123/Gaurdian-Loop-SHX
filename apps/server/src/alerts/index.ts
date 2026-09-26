// alerts (docs/module-contracts.md §3.7).
//
// Stateless async function: the only side effect is sending one SMS. The
// orchestrator calls `sendAlert` on alert.triggered with the call's Guardian and
// publishes the returned `alert.sent`. `sendAlert` never throws and always
// settles — any config error, provider error, or timeout becomes
// `status: "failed"` with an `error` message, so the pipeline never blocks.
//
// "sent" means the provider accepted the message (we have its SID), not that the
// handset received it — carrier delivery callbacks are out of scope for now.

import type { AlertSent, AlertTriggered, Guardian } from "@guardian-loop/shared-types";
import { buildSmsBody } from "./template";

export { buildSmsBody, liveViewUrl, MAX_SMS_CHARS } from "./template";

export const DEFAULT_TIMEOUT_MS = 5000; // per attempt
export const DEFAULT_RETRIES = 1; // extra attempts, transient errors only

export interface SmsMessage {
  to: string;
  from: string;
  body: string;
}

/**
 * The one provider call this module makes; injectable so tests need no account.
 * Resolve with the provider's message ID. Reject with an error carrying an HTTP
 * `status` (as Twilio's RestException does) so transient failures can be retried.
 */
export type SendSmsFn = (msg: SmsMessage) => Promise<{ sid: string }>;

export interface AlerterOptions {
  send?: SendSmsFn;
  from?: string;
  baseUrl?: string;
  timeoutMs?: number;
  retries?: number;
  now?: () => number;
}

const E164 = /^\+[1-9]\d{6,14}$/;

export function createAlerter(opts: AlerterOptions = {}): (alert: AlertTriggered, guardian: Guardian) => Promise<AlertSent> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retries = opts.retries ?? DEFAULT_RETRIES;
  const now = opts.now ?? Date.now;
  const send = opts.send ?? defaultSend;

  return async function sendAlert(alert: AlertTriggered, guardian: Guardian): Promise<AlertSent> {
    const result = (fields: Pick<AlertSent, "status" | "providerId" | "error">): AlertSent => ({
      type: "alert.sent",
      callId: alert.callId,
      alertId: alert.alertId,
      channel: "sms",
      ...fields,
      ts: now(),
    });
    const fail = (err: unknown): AlertSent => {
      const error = describe(err);
      console.warn(`[alerts] call=${alert.callId} alert=${alert.alertId} failed:`, error);
      return result({ status: "failed", error });
    };

    // Env is read per call (not at import) so dotenv can load after this module.
    // `||`, not `??`: an empty KEY= line in .env yields "" and should fall through.
    const from = opts.from || process.env.GUARDIAN_ALERT_FROM_NUMBER || process.env.TWILIO_PHONE_NUMBER;
    const baseUrl = opts.baseUrl || process.env.PUBLIC_BASE_URL;
    if (!from) return fail(new Error("GUARDIAN_ALERT_FROM_NUMBER is not set"));
    if (!E164.test(guardian.phone)) return fail(new Error(`guardian phone is not E.164: "${guardian.phone}"`));
    if (!baseUrl) console.warn(`[alerts] PUBLIC_BASE_URL is not set; sending alert without a live-view link`);

    const msg: SmsMessage = { to: guardian.phone, from, body: buildSmsBody(alert, baseUrl) };

    for (let attempt = 0; ; attempt++) {
      try {
        const { sid } = await withTimeout(send(msg), timeoutMs);
        return result({ status: "sent", providerId: sid });
      } catch (err) {
        if (attempt >= retries || !isTransient(err)) return fail(err);
        console.warn(`[alerts] call=${alert.callId} alert=${alert.alertId} attempt ${attempt + 1} failed, retrying:`, describe(err));
      }
    }
  };
}

// TODO(workstream E): replace with the Twilio client (TWILIO_ACCOUNT_SID /
// TWILIO_AUTH_TOKEN) once the Twilio integration branch lands. Until then every
// alert resolves as "failed" with this message instead of throwing.
const defaultSend: SendSmsFn = async () => {
  throw new Error("SMS provider not configured (Twilio sender not wired yet)");
};

class TimeoutError extends Error {}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(`timeout after ${ms}ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/** Timeouts, network errors, 429 and 5xx are worth one more try; 4xx are not. */
function isTransient(err: unknown): boolean {
  if (err instanceof TimeoutError) return true;
  const e = err as { status?: unknown; code?: unknown } | null;
  if (typeof e?.status === "number") return e.status === 429 || e.status >= 500;
  return typeof e?.code === "string" && /^(ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|EPIPE|UND_ERR_)/.test(e.code);
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Default alerter reading GUARDIAN_ALERT_FROM_NUMBER / PUBLIC_BASE_URL from the environment. */
export const sendAlert = createAlerter();
