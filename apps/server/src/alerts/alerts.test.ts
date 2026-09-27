// Unit tests for alerts (docs/module-contracts.md §3.7).
//
// The notification provider is replaced by an injected `send` fake, so these run
// without a provider account. They cover the template (content, length budget), the
// AlertSent contract, never-throw behaviour, config validation, and retries.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { AlertTriggered, Guardian } from "@guardian-loop/shared-types";
import { buildNotification, createAlerter, MAX_NOTIFICATION_BODY_CHARS, type SendNotificationFn } from "./index";

function makeAlert(overrides: Partial<AlertTriggered> = {}): AlertTriggered {
  return {
    type: "alert.triggered",
    callId: "CA123",
    alertId: "alert-1",
    score: 82,
    threshold: 70,
    reason: "payment in gift cards + secrecy request",
    snippet: [
      { speaker: "victim", text: "Okay, what do I do?" },
      { speaker: "caller", text: "Buy the gift cards and don't tell your daughter." },
      { speaker: "victim", text: "Alright." },
    ],
    ts: 1_000,
    ...overrides,
  };
}

const guardian: Guardian = { name: "Ana", phone: "+13055551234" };
const base = { baseUrl: "https://gl.example.com", now: () => 42 };
const ok = (id = "N1"): SendNotificationFn => async () => ({ id });
const httpError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });

describe("buildNotification", () => {
  it("renders the contract template", () => {
    expect(buildNotification(makeAlert(), "https://gl.example.com/")).toEqual({
      title: "⚠️ Possible scam call (risk 82)",
      body: [`"Buy the gift cards and don't tell your daughter."`, "Why: payment in gift cards + secrecy request."].join("\n"),
      url: "https://gl.example.com/call/CA123",
    });
  });

  it("quotes the latest caller turn, falling back to the last turn", () => {
    const victimOnly = makeAlert({ snippet: [{ speaker: "victim", text: "I'll buy them now." }] });
    expect(buildNotification(victimOnly, "https://x").body).toContain(`"I'll buy them now."`);
  });

  it("omits an empty quote line and the url when no base URL is set", () => {
    const n = buildNotification(makeAlert({ snippet: [] }), undefined);
    expect(n).toEqual({ title: "⚠️ Possible scam call (risk 82)", body: "Why: payment in gift cards + secrecy request." });
  });

  it("does not double the trailing period on the reason", () => {
    expect(buildNotification(makeAlert({ reason: "Secrecy request." }), "https://x").body).toMatch(/Why: Secrecy request\.$/);
  });

  it("trims the quote, then the reason, to stay within the length budget", () => {
    const long = makeAlert({
      snippet: [{ speaker: "caller", text: "gift cards ".repeat(60) }],
      reason: "urgency ".repeat(60),
    });
    const { body } = buildNotification(long, "https://gl.example.com");
    expect([...body].length).toBeLessThanOrEqual(MAX_NOTIFICATION_BODY_CHARS);
    expect(body).toContain("Why: urgency");
    expect(body).toContain("…");
  });

  it("url-encodes the callId in the live-view link", () => {
    expect(buildNotification(makeAlert({ callId: "a/b c" }), "https://x").url).toBe("https://x/call/a%2Fb%20c");
  });
});

describe("sendAlert", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("notifies the guardian and returns alert.sent with the provider ID", async () => {
    const send = vi.fn<SendNotificationFn>(ok("N999"));
    const res = await createAlerter({ ...base, send })(makeAlert(), guardian);

    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][0]).toEqual({ guardian, ...buildNotification(makeAlert(), base.baseUrl) });
    expect(res).toEqual({
      type: "alert.sent",
      callId: "CA123",
      alertId: "alert-1",
      channel: "notification",
      status: "sent",
      providerId: "N999",
      ts: 42,
    });
  });

  it("resolves failed (never throws) when the provider rejects", async () => {
    const res = await createAlerter({ ...base, send: async () => { throw httpError(400); } })(makeAlert(), guardian);
    expect(res).toMatchObject({ status: "failed", error: "HTTP 400", alertId: "alert-1" });
    expect(res.providerId).toBeUndefined();
  });

  it("reads the base URL from env", async () => {
    vi.stubEnv("PUBLIC_BASE_URL", "https://env.example.com");
    const send = vi.fn<SendNotificationFn>(ok());
    await createAlerter({ send })(makeAlert(), guardian);
    expect(send.mock.calls[0][0].url).toBe("https://env.example.com/call/CA123");
  });

  it("retries once on a transient error, then succeeds", async () => {
    const send = vi.fn<SendNotificationFn>().mockRejectedValueOnce(httpError(503)).mockResolvedValueOnce({ id: "N2" });
    const res = await createAlerter({ ...base, send })(makeAlert(), guardian);
    expect(send).toHaveBeenCalledTimes(2);
    expect(res).toMatchObject({ status: "sent", providerId: "N2" });
  });

  it("gives up after the retry budget on repeated transient errors", async () => {
    const send = vi.fn<SendNotificationFn>(async () => { throw httpError(429); });
    const res = await createAlerter({ ...base, send })(makeAlert(), guardian);
    expect(send).toHaveBeenCalledTimes(2);
    expect(res).toMatchObject({ status: "failed", error: "HTTP 429" });
  });

  it("does not retry client errors", async () => {
    const send = vi.fn<SendNotificationFn>(async () => { throw httpError(400); });
    await createAlerter({ ...base, send })(makeAlert(), guardian);
    expect(send).toHaveBeenCalledOnce();
  });

  it("retries network errors", async () => {
    const netErr = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    const send = vi.fn<SendNotificationFn>().mockRejectedValueOnce(netErr).mockResolvedValueOnce({ id: "N3" });
    const res = await createAlerter({ ...base, send })(makeAlert(), guardian);
    expect(res.status).toBe("sent");
  });

  it("times out a hung provider call and resolves failed", async () => {
    vi.useFakeTimers();
    const send: SendNotificationFn = () => new Promise(() => {});
    const pending = createAlerter({ ...base, send, timeoutMs: 1000 })(makeAlert(), guardian);
    await vi.advanceTimersByTimeAsync(2000);
    await expect(pending).resolves.toMatchObject({ status: "failed", error: "timeout after 1000ms" });
  });

  it("fails cleanly with the default (not yet wired) provider", async () => {
    const res = await createAlerter(base)(makeAlert(), guardian);
    expect(res).toMatchObject({ status: "failed", error: expect.stringMatching(/not configured/) });
  });
});
