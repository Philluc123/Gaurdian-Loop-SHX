import { describe, expect, it } from "vitest";
import type { AlertTriggered, ServerMsg, TranscriptEvent } from "@guardian-loop/shared-types";
import { initialState, reduce, splitHighlights, type DashboardState } from "./state";

const callId = "CA123";

const snapshot: ServerMsg = {
  type: "snapshot",
  call: {
    callId,
    startedAt: 1000,
    turns: [{ segmentId: "c-1", speaker: "caller", text: "This is Medicare calling.", startMs: 0, endMs: 900 }],
    score: 22,
    level: "low",
    signals: ["IMPERSONATION"],
    highlights: [{ segmentId: "c-1", start: 8, end: 16, signal: "IMPERSONATION" }],
    alerts: [],
  },
};

const transcript = (over: Partial<TranscriptEvent>): ServerMsg => ({
  type: "transcript",
  event: { type: "transcript", callId, speaker: "caller", segmentId: "c-2", text: "", isFinal: false, startMs: 1000, endMs: 1500, ts: 2000, ...over },
});

const alert: AlertTriggered = {
  type: "alert.triggered",
  callId,
  alertId: "a1",
  score: 82,
  threshold: 70,
  reason: "secrecy request + untraceable payment request",
  snippet: [{ speaker: "caller", text: "Buy the gift cards" }],
  ts: 5000,
};

const run = (msgs: ServerMsg[], from: DashboardState = initialState) => msgs.reduce((s, m) => reduce(s, m, 9999), from);

describe("reduce", () => {
  it("ignores incremental updates until a snapshot arrives", () => {
    expect(run([transcript({ text: "hi" })])).toEqual(initialState);
  });

  it("builds the view from a snapshot", () => {
    const { call } = run([snapshot]);
    expect(call?.segments).toHaveLength(1);
    expect(call?.segments[0].isFinal).toBe(true);
    expect(call?.highlights["c-1"].spans).toEqual([{ start: 8, end: 16, signal: "IMPERSONATION" }]);
    expect(call?.history).toEqual([{ ts: 9999, score: 22 }]);
  });

  it("replaces partials with their final and ignores a late partial", () => {
    const { call } = run([
      snapshot,
      transcript({ text: "Buy the" }),
      transcript({ text: "Buy the gift cards", isFinal: true }),
      transcript({ text: "Buy the gift", isFinal: false }),
    ]);
    expect(call?.segments.map((s) => [s.segmentId, s.text, s.isFinal])).toEqual([
      ["c-1", "This is Medicare calling.", true],
      ["c-2", "Buy the gift cards", true],
    ]);
  });

  it("keeps segments ordered by start time", () => {
    const { call } = run([snapshot, transcript({ segmentId: "v-3", startMs: 3000 }), transcript({ segmentId: "c-2", startMs: 2000 })]);
    expect(call?.segments.map((s) => s.segmentId)).toEqual(["c-1", "c-2", "v-3"]);
  });

  it("lets final highlights win over later partial ones", () => {
    const { call } = run([
      snapshot,
      { type: "highlights", segmentId: "c-2", isFinal: true, spans: [{ start: 0, end: 3, signal: "UNTRACEABLE_PAYMENT" }] },
      { type: "highlights", segmentId: "c-2", isFinal: false, spans: [] },
    ]);
    expect(call?.highlights["c-2"].spans).toHaveLength(1);
  });

  it("applies score updates and records history", () => {
    const { call } = run([
      snapshot,
      { type: "score", event: { type: "score.updated", callId, score: 75, level: "high", signals: ["SECRECY"], reason: "why", source: "rules", ts: 4000 } },
    ]);
    expect(call).toMatchObject({ score: 75, level: "high", signals: ["SECRECY"], reason: "why" });
    expect(call?.history.at(-1)).toEqual({ ts: 4000, score: 75 });
  });

  it("drops messages for a different call", () => {
    const before = run([snapshot]);
    const after = run(
      [
        transcript({ callId: "other", text: "x" }),
        { type: "score", event: { type: "score.updated", callId: "other", score: 99, level: "high", signals: [], reason: "", source: "rules", ts: 1 } },
        { type: "call_ended", callId: "other", ts: 1 },
      ],
      before
    );
    expect(after).toBe(before);
  });

  it("upserts alerts by id and keeps delivery status", () => {
    const { call } = run([
      snapshot,
      { type: "alert", event: alert },
      { type: "alert", event: alert, delivery: "sent" },
      { type: "alert", event: alert },
    ]);
    expect(call?.alerts).toEqual([{ event: alert, delivery: "sent" }]);
  });

  it("marks the call ended", () => {
    expect(run([snapshot, { type: "call_ended", callId, ts: 7000 }]).call?.endedAt).toBe(7000);
  });

  it("a new snapshot replaces all prior state (reconnect / latest call moved on)", () => {
    const next: ServerMsg = { type: "snapshot", call: { ...snapshot.call, callId: "CA456", turns: [], highlights: [] } };
    const { call } = run([snapshot, { type: "alert", event: alert }, next]);
    expect(call).toMatchObject({ callId: "CA456", segments: [], alerts: [] });
  });
});

describe("splitHighlights", () => {
  it("splits text into plain and highlighted runs", () => {
    expect(splitHighlights("buy gift cards now", [{ start: 4, end: 14, signal: "UNTRACEABLE_PAYMENT" }])).toEqual([
      { text: "buy " },
      { text: "gift cards", signal: "UNTRACEABLE_PAYMENT" },
      { text: " now" },
    ]);
  });

  it("clamps spans past the end of the text and skips overlaps", () => {
    expect(
      splitHighlights("don't tell", [
        { start: 0, end: 10, signal: "SECRECY" },
        { start: 6, end: 40, signal: "URGENCY" },
      ])
    ).toEqual([{ text: "don't tell", signal: "SECRECY" }]);
  });
});
