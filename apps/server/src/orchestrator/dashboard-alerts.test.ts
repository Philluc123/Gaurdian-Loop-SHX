import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AlertTriggered, Guardian } from "@guardian-loop/shared-types";
import { buildNotification } from "../alerts";
import { createDashboardAlerter } from "./dashboard-alerts";
import type { DashboardFeed, DashboardNotification } from "./dashboard-feed";

const guardian: Guardian = { name: "Maria", phone: "+13055551234" };

const alert: AlertTriggered = {
  type: "alert.triggered",
  callId: "call-1",
  alertId: "call-1:alert:1",
  score: 82,
  threshold: 70,
  reason: "secrecy request + untraceable payment request",
  snippet: [{ speaker: "caller", text: "Buy the gift cards and don't tell your daughter." }],
  ts: 1000,
};

/** A feed that records notifications and reports a chosen number of recipients. */
function fakeFeed(recipients: number) {
  const sent: DashboardNotification[] = [];
  const feed = {
    notify: vi.fn((n: DashboardNotification) => {
      sent.push(n);
      return recipients;
    }),
  } as unknown as DashboardFeed;
  return { feed, sent };
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("dashboard alerter", () => {
  it("delivers the alerts module's own notification content, and reports sent", async () => {
    const { feed, sent } = fakeFeed(1);
    const result = await createDashboardAlerter(() => feed, { baseUrl: "https://gl.example.com" })(alert, guardian);

    expect(result).toMatchObject({
      type: "alert.sent",
      callId: "call-1",
      alertId: "call-1:alert:1",
      channel: "notification",
      status: "sent",
      providerId: "dashboard:call-1:alert:1",
    });

    // Title, body and link come from the template, not a second copy of it.
    const expected = buildNotification(alert, "https://gl.example.com");
    expect(sent).toEqual([
      { type: "notification", callId: "call-1", alertId: "call-1:alert:1", ...expected },
    ]);
  });

  it("reports failed when no guardian dashboard is connected — nobody was reached", async () => {
    const { feed } = fakeFeed(0);
    const result = await createDashboardAlerter(() => feed)(alert, guardian);
    expect(result).toMatchObject({ status: "failed", error: "no guardian dashboard connected" });
  });

  it("does not retry an empty room", async () => {
    const { feed } = fakeFeed(0);
    await createDashboardAlerter(() => feed, { retries: 3 })(alert, guardian);
    expect(feed.notify).toHaveBeenCalledTimes(1);
  });

  it("fails cleanly if the feed isn't up yet", async () => {
    const result = await createDashboardAlerter(() => undefined)(alert, guardian);
    expect(result).toMatchObject({ status: "failed", error: "no guardian dashboard connected" });
  });

  it("never rejects, even when the feed throws", async () => {
    const feed = { notify: () => { throw new Error("socket exploded"); } } as unknown as DashboardFeed;
    await expect(createDashboardAlerter(() => feed)(alert, guardian)).resolves.toMatchObject({
      status: "failed",
      error: "socket exploded",
    });
  });
});
