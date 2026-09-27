// alerts (docs/module-contracts.md §3.7).
//
// Stateless async function: the only side effect is sending one notification. The
// orchestrator calls `sendAlert` on alert.triggered with the call's Guardian and
// publishes the returned `alert.sent`. `sendAlert` never throws and always
// settles — any config error, provider error, or timeout becomes
// `status: "failed"` with an `error` message, so the pipeline never blocks.
//
// "sent" means the provider accepted the notification (we have its ID), not that
// the guardian's device displayed it — delivery receipts are out of scope for now.

import type { AlertSent, AlertTriggered, Guardian } from "@guardian-loop/shared-types";
import { buildNotification, type NotificationContent } from "./template";

export { buildNotification, liveViewUrl, MAX_NOTIFICATION_BODY_CHARS, type NotificationContent } from "./template";

export const DEFAULT_TIMEOUT_MS = 5000; // per attempt
export const DEFAULT_RETRIES = 1; // extra attempts, transient errors only

export interface NotificationMessage extends NotificationContent {
  guardian: Guardian; // the provider resolves the guardian's device(s)
}

/**
 * The one provider call this module makes; injectable so tests need no account.
 * Resolve with the provider's message ID. Reject with an error carrying an HTTP
 * `status` (e.g. 429, 503) so transient failures can be retried.
 */
export type SendNotificationFn = (msg: NotificationMessage) => Promise<{ id: string }>;

export interface AlerterOptions {
  send?: SendNotificationFn;
  baseUrl?: string;
  timeoutMs?: number;
  retries?: number;
  now?: () => number;
}

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
      channel: "notification",
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
    const baseUrl = opts.baseUrl || process.env.PUBLIC_BASE_URL;
    if (!baseUrl) console.warn(`[alerts] PUBLIC_BASE_URL is not set; sending alert without a live-view link`);

    const msg: NotificationMessage = { guardian, ...buildNotification(alert, baseUrl) };

    for (let attempt = 0; ; attempt++) {
      try {
        const { id } = await withTimeout(send(msg), timeoutMs);
        return result({ status: "sent", providerId: id });
      } catch (err) {
        if (attempt >= retries || !isTransient(err)) return fail(err);
        console.warn(`[alerts] call=${alert.callId} alert=${alert.alertId} attempt ${attempt + 1} failed, retrying:`, describe(err));
      }
    }
  };
}

// TODO(workstream E): replace with a real notification provider client once one
// is chosen. Until then every alert resolves as "failed" with this message
// instead of throwing.
const defaultSend: SendNotificationFn = async () => {
  throw new Error("notification provider not configured");
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

/** Default alerter reading PUBLIC_BASE_URL from the environment. */
export const sendAlert = createAlerter();
