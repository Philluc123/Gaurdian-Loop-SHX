// Unit tests for alerts (docs/module-contracts.md §3.7).
//
// The SMS provider is replaced by an injected `send` fake, so these run without
// a Twilio account. They cover the template (content, length budget), the
// AlertSent contract, never-throw behaviour, config validation, and retries.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { AlertTriggered, Guardian } from "@guardian-loop/shared-types";
import { buildSmsBody, createAlerter, MAX_SMS_CHARS, type SendSmsFn } from "./index";

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
const base = { from: "+13055550000", baseUrl: "https://gl.example.com", now: () => 42 };
const ok = (sid = "SM1"): SendSmsFn => async () => ({ sid });
const httpError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });

describe("buildSmsBody", () => {
  it("renders the contract template", () => {
    expect(buildSmsBody(makeAlert(), "https://gl.example.com/")).toBe(
      [
        "⚠️ Guardian Loop: possible scam call (risk 82).",
        `"Buy the gift cards and don't tell your daughter."`,
        "Why: payment in gift cards + secrecy request.",
        "Live view: https://gl.example.com/call/CA123",
      ].join("\n"),
    );
  });

  it("quotes the latest caller turn, falling back to the last turn", () => {
    const victimOnly = makeAlert({ snippet: [{ speaker: "victim", text: "I'll buy them now." }] });
    expect(buildSmsBody(victimOnly, "https://x")).toContain(`"I'll buy them now."`);
  });

  it("omits empty quote and link lines", () => {
    const body = buildSmsBody(makeAlert({ snippet: [] }), undefined);
    expect(body).toBe("⚠️ Guardian Loop: possible scam call (risk 82).\nWhy: payment in gift cards + secrecy request.");
  });

  it("does not double the trailing period on the reason", () => {
    expect(buildSmsBody(makeAlert({ reason: "Secrecy request." }), "https://x")).toContain("Why: Secrecy request.\n");
  });

  it("trims the quote, then the reason, to stay within the length budget", () => {
    const long = makeAlert({
      snippet: [{ speaker: "caller", text: "gift cards ".repeat(60) }],
      reason: "urgency ".repeat(60),
    });
    const body = buildSmsBody(long, "https://gl.example.com");
    expect([...body].length).toBeLessThanOrEqual(MAX_SMS_CHARS);
    expect(body).toMatch(/^⚠️ Guardian Loop: possible scam call \(risk 82\)\./);
    expect(body).toMatch(/Live view: https:\/\/gl\.example\.com\/call\/CA123$/);
    expect(body).toContain("…");
  });

  it("url-encodes the callId in the live-view link", () => {
    expect(buildSmsBody(makeAlert({ callId: "a/b c" }), "https://x")).toContain("https://x/call/a%2Fb%20c");
  });
});

describe("sendAlert", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("sends to the guardian and returns alert.sent with the provider SID", async () => {
    const send = vi.fn<SendSmsFn>(ok("SM999"));
    const res = await createAlerter({ ...base, send })(makeAlert(), guardian);

    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][0]).toEqual({
      to: "+13055551234",
      from: "+13055550000",
      body: buildSmsBody(makeAlert(), base.baseUrl),
    });
    expect(res).toEqual({
      type: "alert.sent",
      callId: "CA123",
      alertId: "alert-1",
      channel: "sms",
      status: "sent",
      providerId: "SM999",
      ts: 42,
    });
  });

  it("resolves failed (never throws) when the provider rejects", async () => {
    const res = await createAlerter({ ...base, send: async () => { throw httpError(400); } })(makeAlert(), guardian);
    expect(res).toMatchObject({ status: "failed", error: "HTTP 400", alertId: "alert-1" });
    expect(res.providerId).toBeUndefined();
  });

  it("fails without sending when the guardian phone is not E.164", async () => {
    const send = vi.fn<SendSmsFn>(ok());
    const res = await createAlerter({ ...base, send })(makeAlert(), { name: "Ana", phone: "305-555-1234" });
    expect(send).not.toHaveBeenCalled();
    expect(res).toMatchObject({ status: "failed", error: expect.stringMatching(/E\.164/) });
  });

  it("fails without sending when no from-number is configured", async () => {
    vi.stubEnv("GUARDIAN_ALERT_FROM_NUMBER", "");
    vi.stubEnv("TWILIO_PHONE_NUMBER", "");
    const send = vi.fn<SendSmsFn>(ok());
    const res = await createAlerter({ baseUrl: base.baseUrl, send })(makeAlert(), guardian);
    expect(send).not.toHaveBeenCalled();
    expect(res).toMatchObject({ status: "failed", error: expect.stringMatching(/GUARDIAN_ALERT_FROM_NUMBER/) });
  });

  it("reads from-number and base URL from env, falling back to TWILIO_PHONE_NUMBER", async () => {
    vi.stubEnv("GUARDIAN_ALERT_FROM_NUMBER", "");
    vi.stubEnv("TWILIO_PHONE_NUMBER", "+13055550001");
    vi.stubEnv("PUBLIC_BASE_URL", "https://env.example.com");
    const send = vi.fn<SendSmsFn>(ok());
    await createAlerter({ send })(makeAlert(), guardian);
    expect(send.mock.calls[0][0].from).toBe("+13055550001");
    expect(send.mock.calls[0][0].body).toContain("https://env.example.com/call/CA123");
  });

  it("retries once on a transient error, then succeeds", async () => {
    const send = vi.fn<SendSmsFn>().mockRejectedValueOnce(httpError(503)).mockResolvedValueOnce({ sid: "SM2" });
    const res = await createAlerter({ ...base, send })(makeAlert(), guardian);
    expect(send).toHaveBeenCalledTimes(2);
    expect(res).toMatchObject({ status: "sent", providerId: "SM2" });
  });

  it("gives up after the retry budget on repeated transient errors", async () => {
    const send = vi.fn<SendSmsFn>(async () => { throw httpError(429); });
    const res = await createAlerter({ ...base, send })(makeAlert(), guardian);
    expect(send).toHaveBeenCalledTimes(2);
    expect(res).toMatchObject({ status: "failed", error: "HTTP 429" });
  });

  it("does not retry client errors", async () => {
    const send = vi.fn<SendSmsFn>(async () => { throw httpError(400); });
    await createAlerter({ ...base, send })(makeAlert(), guardian);
    expect(send).toHaveBeenCalledOnce();
  });

  it("retries network errors", async () => {
    const netErr = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    const send = vi.fn<SendSmsFn>().mockRejectedValueOnce(netErr).mockResolvedValueOnce({ sid: "SM3" });
    const res = await createAlerter({ ...base, send })(makeAlert(), guardian);
    expect(res.status).toBe("sent");
  });

  it("times out a hung provider call and resolves failed", async () => {
    vi.useFakeTimers();
    const send: SendSmsFn = () => new Promise(() => {});
    const pending = createAlerter({ ...base, send, timeoutMs: 1000 })(makeAlert(), guardian);
    await vi.advanceTimersByTimeAsync(2000);
    await expect(pending).resolves.toMatchObject({ status: "failed", error: "timeout after 1000ms" });
  });

  it("fails cleanly with the default (not yet wired) provider", async () => {
    const res = await createAlerter(base)(makeAlert(), guardian);
    expect(res).toMatchObject({ status: "failed", error: expect.stringMatching(/not configured/) });
  });
});
