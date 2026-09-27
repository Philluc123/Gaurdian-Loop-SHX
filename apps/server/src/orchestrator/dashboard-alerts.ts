// Guardian notification via the dashboard (M3): the alerts module's notification
// provider, pointed at the guardian's open dashboards.
//
// The alerts module (§3.7) owns the notification's content — its template picks the
// quote and trims it to fit a lock screen — plus the retries, the timeout, and the
// `alert.sent` it returns. It delegates the actual send to a pluggable provider, and
// no push provider has been chosen. This supplies one: the notification goes out over
// the dashboard's existing WebSocket, and the dashboard raises it as a browser
// notification.
//
// Delivery is reported honestly. With no dashboard connected the send fails, so
// `alert.sent` says `failed` — nobody was reached — rather than claiming success.

import type { AlertSent, AlertTriggered, Guardian } from "@guardian-loop/shared-types";
import { createAlerter, type AlerterOptions } from "../alerts";
import type { DashboardFeed } from "./dashboard-feed";

export type SendAlertFn = (alert: AlertTriggered, guardian: Guardian) => Promise<AlertSent>;

/**
 * @param getFeed  resolved at send time, because the feed is created after the
 *                 orchestrator that calls this (it needs the orchestrator for snapshots)
 */
export function createDashboardAlerter(
  getFeed: () => DashboardFeed | undefined,
  opts: Omit<AlerterOptions, "send"> = {}
): SendAlertFn {
  return (alert, guardian) =>
    // One alerter per alert, so the provider knows which call and alert it's
    // delivering. The alerts module's message carries only the notification's
    // content, and this keeps that module untouched.
    createAlerter({
      ...opts,
      async send(msg) {
        const feed = getFeed();
        const delivered = feed
          ? feed.notify({
              type: "notification",
              callId: alert.callId,
              alertId: alert.alertId,
              title: msg.title,
              body: msg.body,
              url: msg.url,
            })
          : 0;
        if (delivered === 0) {
          // No `status` on this error, so the alerts module treats it as permanent
          // and fails at once instead of retrying an empty room.
          throw new Error("no guardian dashboard connected");
        }
        return { id: `dashboard:${alert.alertId}` };
      },
    })(alert, guardian);
}
