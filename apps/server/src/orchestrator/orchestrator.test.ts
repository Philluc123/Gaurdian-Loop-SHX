import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AlertTriggered,
  GuardianEvent,
  RulesHitsEvent,
  ScoreUpdated,
  TranscriptEvent,
} from "@guardian-loop/shared-types";
import { EventBus } from "../event-bus";
import { createOrchestrator, type Orchestrator } from "./index";

const FIXTURES = join(__dirname, "../../../../fixtures/calls");
const guardian = { name: "Maria", phone: "+13055551234" };

/** A fixture call, re-labelled with our callId. Fixture `ts` values are call-relative. */
function fixture(name: string, callId: string): TranscriptEvent[] {
  return readFileSync(join(FIXTURES, `${name}.jsonl`), "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => ({ ...JSON.parse(line), callId }));
}

let bus: EventBus;
let orchestrator: Orchestrator;
let published: GuardianEvent[];

beforeEach(() => {
  vi.useFakeTimers();
  bus = new EventBus();
  published = [];
  bus.subscribeAll((e) => published.push(e));
  orchestrator = createOrchestrator(bus, { tickMs: 1000, now: () => Date.now() });
});

afterEach(() => {
  orchestrator.stop();
  vi.useRealTimers();
});

function startCall(callId: string) {
  bus.publish({ type: "call.started", callId, source: "webrtc", guardian, ts: 0 });
}

function play(events: TranscriptEvent[]) {
  for (const event of events) bus.publish(event);
}

const ofType = <T extends GuardianEvent["type"]>(type: T) =>
  published.filter((e): e is Extract<GuardianEvent, { type: T }> => e.type === type);

describe("orchestrator: transcripts drive the score", () => {
  it("scores the Medicare gift-card scam past the alert threshold, alerting once", () => {
    startCall("scam");
    play(fixture("gift-card-medicare-scam", "scam"));

    const scores = ofType("score.updated") as ScoreUpdated[];
    expect(Math.max(...scores.map((s) => s.score))).toBeGreaterThanOrEqual(70);

    const alerts = ofType("alert.triggered") as AlertTriggered[];
    expect(alerts).toHaveLength(1);
    expect(alerts[0].callId).toBe("scam");
    // The snippet is what the guardian reads, so it must be real turns from the call.
    expect(alerts[0].snippet.length).toBeGreaterThan(0);
    expect(alerts[0].snippet.length).toBeLessThanOrEqual(3);
  });

  it("scores the tech-support remote-access scam past the threshold too", () => {
    startCall("tech");
    play(fixture("tech-support-remote-access-scam", "tech"));
    expect(ofType("alert.triggered")).toHaveLength(1);
  });

  it("keeps a legitimate family check-in below the threshold, with no alert", () => {
    startCall("legit");
    play(fixture("legit-family-checkin", "legit"));

    const scores = ofType("score.updated") as ScoreUpdated[];
    const max = scores.length ? Math.max(...scores.map((s) => s.score)) : 0;
    expect(max).toBeLessThan(70);
    expect(ofType("alert.triggered")).toHaveLength(0);
  });
});

describe("orchestrator: rules.hits", () => {
  it("publishes rules.hits for partials as well as finals, keeping isFinal", () => {
    startCall("c1");
    play(fixture("gift-card-medicare-scam", "c1"));

    const hits = ofType("rules.hits") as RulesHitsEvent[];
    expect(hits.some((h) => !h.isFinal)).toBe(true);
    expect(hits.some((h) => h.isFinal)).toBe(true);
  });

  it("publishes one rules.hits per transcript, even with no hits, so stale highlights clear", () => {
    startCall("c1");
    const transcripts = fixture("legit-family-checkin", "c1");
    play(transcripts);
    expect(ofType("rules.hits")).toHaveLength(transcripts.length);
  });

  it("only final transcripts become turns", () => {
    startCall("c1");
    const transcripts = fixture("gift-card-medicare-scam", "c1");
    play(transcripts);
    const finals = transcripts.filter((t) => t.isFinal).length;
    expect(orchestrator.getCall("c1")!.turns).toHaveLength(finals);
  });

  it("ignores transcripts for a call it never saw start", () => {
    play(fixture("gift-card-medicare-scam", "ghost"));
    expect(ofType("rules.hits")).toHaveLength(0);
    expect(orchestrator.getCall("ghost")).toBeUndefined();
  });
});

describe("orchestrator: decay tick", () => {
  it("decays a live call's score each tick, but never below its floor", () => {
    startCall("c1");
    play(fixture("gift-card-medicare-scam", "c1"));
    const call = orchestrator.getCall("c1")!;
    const before = call.score.score;
    const floor = call.score.floor;

    vi.advanceTimersByTime(5_000);
    const after = orchestrator.getCall("c1")!.score.score;
    expect(after).toBeLessThanOrEqual(before);
    expect(after).toBeGreaterThanOrEqual(floor);
  });

  it("stops ticking an ended call", () => {
    startCall("c1");
    bus.publish({
      type: "transcript", callId: "c1", speaker: "caller", segmentId: "s1",
      text: "you need to act today or you will be arrested", isFinal: true,
      startMs: 0, endMs: 1000, ts: 1000,
    });
    bus.publish({ type: "call.ended", callId: "c1", reason: "hangup", ts: 2000 });
    const count = ofType("score.updated").length;

    vi.advanceTimersByTime(10_000);
    expect(ofType("score.updated")).toHaveLength(count);
  });

  it("still scores a final that arrives just after hangup — the STT flush", () => {
    startCall("c1");
    bus.publish({ type: "call.ended", callId: "c1", reason: "hangup", ts: 1000 });
    play(fixture("gift-card-medicare-scam", "c1"));
    expect(ofType("alert.triggered")).toHaveLength(1);
  });
});

describe("orchestrator: state for the dashboard", () => {
  it("tracks the latest call", () => {
    startCall("a");
    startCall("b");
    expect(orchestrator.latestCallId).toBe("b");
  });

  it("builds a snapshot matching the call so far", () => {
    startCall("c1");
    play(fixture("gift-card-medicare-scam", "c1"));
    const snap = orchestrator.snapshot("c1")!;
    const call = orchestrator.getCall("c1")!;

    expect(snap.callId).toBe("c1");
    expect(snap.turns).toHaveLength(call.turns.length);
    expect(snap.score).toBe(call.score.score);
    expect(snap.alerts).toHaveLength(1);
    expect(snap.highlights.length).toBeGreaterThan(0);
    // Signals are listed in the order they were first seen.
    expect(snap.signals.length).toBeGreaterThan(0);
  });

  it("returns undefined for an unknown call", () => {
    expect(orchestrator.snapshot("nope")).toBeUndefined();
  });

  it("finds an alert by id, for the delivery-status update", () => {
    startCall("c1");
    play(fixture("gift-card-medicare-scam", "c1"));
    const alert = (ofType("alert.triggered") as AlertTriggered[])[0];
    expect(orchestrator.findAlert("c1", alert.alertId)).toEqual(alert);
    expect(orchestrator.findAlert("c1", "nope")).toBeUndefined();
  });

  it("keeps only a bounded number of ended calls", () => {
    const small = createOrchestrator(bus, { maxEndedCalls: 2 });
    for (const id of ["a", "b", "c", "d"]) {
      bus.publish({ type: "call.started", callId: id, source: "webrtc", guardian, ts: 0 });
      bus.publish({ type: "call.ended", callId: id, reason: "hangup", ts: 1 });
    }
    // Eviction runs on the next call.started.
    bus.publish({ type: "call.started", callId: "e", source: "webrtc", guardian, ts: 0 });
    expect(small.getCall("a")).toBeUndefined();
    expect(small.getCall("d")).toBeDefined();
    expect(small.getCall("e")).toBeDefined();
    small.stop();
  });
});
