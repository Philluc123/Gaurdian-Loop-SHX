import { beforeEach, describe, expect, it } from "vitest";
import type { GuardianEvent } from "@guardian-loop/shared-types";
import { EventBus } from "../event-bus";
import { createMemoryEventStore, shouldStore, type MemoryEventStore } from "./memory";

const guardian = { name: "Maria", phone: "+13055551234" };

let bus: EventBus;
let store: MemoryEventStore;

beforeEach(() => {
  bus = new EventBus();
  store = createMemoryEventStore(bus, { maxCalls: 3 });
});

const start = (callId: string, ts = 1000): GuardianEvent => ({
  type: "call.started", callId, source: "webrtc", guardian, ts,
});

describe("shouldStore (contract §3.9)", () => {
  const base = { callId: "c", ts: 1 };

  it("never stores audio frames", () => {
    expect(shouldStore({ ...base, type: "audio.frame", speaker: "caller", encoding: "pcm16", sampleRate: 16000, payload: "", seq: 1 })).toBe(false);
  });

  it("stores final transcripts only", () => {
    const t = { ...base, type: "transcript" as const, speaker: "caller" as const, segmentId: "s", text: "x", startMs: 0, endMs: 1 };
    expect(shouldStore({ ...t, isFinal: true })).toBe(true);
    expect(shouldStore({ ...t, isFinal: false })).toBe(false);
  });

  it("stores final rule hits that found something", () => {
    const r = { ...base, type: "rules.hits" as const, segmentId: "s", speaker: "caller" as const };
    const hit = { ruleId: "x", signal: "SECRECY" as const, weight: 10, match: "x", start: 0, end: 1 };
    expect(shouldStore({ ...r, isFinal: true, hits: [hit] })).toBe(true);
    expect(shouldStore({ ...r, isFinal: true, hits: [] })).toBe(false);
    expect(shouldStore({ ...r, isFinal: false, hits: [hit] })).toBe(false);
  });
});

describe("memory event store", () => {
  it("summarizes a call from its events", () => {
    bus.publish(start("c1"));
    bus.publish({ type: "score.updated", callId: "c1", score: 82, level: "high", signals: ["SECRECY"], reason: "r", source: "rules", ts: 2000 });
    bus.publish({ type: "score.updated", callId: "c1", score: 60, level: "elevated", signals: ["SECRECY"], reason: "r", source: "decay", ts: 3000 });
    bus.publish({ type: "alert.triggered", callId: "c1", alertId: "a1", score: 82, threshold: 70, reason: "r", snippet: [], ts: 2000 });
    bus.publish({ type: "call.ended", callId: "c1", reason: "hangup", ts: 4000 });

    expect(store.get("c1")!.call).toMatchObject({
      callId: "c1", maxScore: 82, finalLevel: "elevated", alertCount: 1, startedAt: 1000, endedAt: 4000,
    });
  });

  it("returns a call's events in timestamp order", () => {
    bus.publish(start("c1", 1000));
    bus.publish({ type: "call.ended", callId: "c1", reason: "hangup", ts: 5000 });
    bus.publish({ type: "score.updated", callId: "c1", score: 10, level: "low", signals: [], reason: "", source: "rules", ts: 3000 });
    const ts = store.get("c1")!.events.map((e) => e.ts);
    expect(ts).toEqual([...ts].sort((a, b) => a - b));
  });

  it("lists calls newest first", () => {
    bus.publish(start("old", 1000));
    bus.publish(start("new", 2000));
    expect(store.list().map((c) => c.callId)).toEqual(["new", "old"]);
  });

  it("keeps only the most recent calls", () => {
    for (const [i, id] of ["a", "b", "c", "d"].entries()) bus.publish(start(id, i));
    expect(store.list().map((c) => c.callId)).toEqual(["d", "c", "b"]);
    expect(store.get("a")).toBeUndefined();
  });

  it("ignores events for calls it never saw start", () => {
    bus.publish({ type: "call.ended", callId: "ghost", reason: "hangup", ts: 1 });
    expect(store.get("ghost")).toBeUndefined();
  });

  it("hands out copies, so callers can't mutate stored history", () => {
    bus.publish(start("c1"));
    store.list()[0].maxScore = 999;
    expect(store.get("c1")!.call.maxScore).toBe(0);
  });
});
