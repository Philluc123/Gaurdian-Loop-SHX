import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AlertTriggered,
  AudioFrame,
  GuardianEvent,
  LLMRequest,
  LLMResult,
  RulesHitsEvent,
  ScoreUpdated,
  SttAdapter,
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

describe("orchestrator: guardian notification (M3)", () => {
  it("hands each alert and the call's guardian to sendAlert, then publishes alert.sent", async () => {
    const sendAlert = vi.fn(async (alert: AlertTriggered) => ({
      type: "alert.sent" as const, callId: alert.callId, alertId: alert.alertId,
      channel: "notification" as const, status: "sent" as const, ts: 1,
    }));
    const withAlerts = createOrchestrator(bus, { sendAlert });
    // Replace the default orchestrator so only one handles the call.
    orchestrator.stop();
    orchestrator = withAlerts;

    startCall("c1");
    play(fixture("gift-card-medicare-scam", "c1"));
    await vi.runAllTicks();
    await Promise.resolve();

    const alert = (ofType("alert.triggered") as AlertTriggered[])[0];
    expect(sendAlert).toHaveBeenCalledTimes(1);
    expect(sendAlert).toHaveBeenCalledWith(alert, guardian);
    expect(ofType("alert.sent")).toEqual([
      expect.objectContaining({ alertId: alert.alertId, status: "sent" }),
    ]);
  });

  it("survives a sendAlert that rejects, instead of crashing the server", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    orchestrator.stop();
    orchestrator = createOrchestrator(bus, { sendAlert: () => Promise.reject(new Error("boom")) });

    startCall("c1");
    play(fixture("gift-card-medicare-scam", "c1"));
    await vi.runAllTicks();
    await Promise.resolve();

    expect(ofType("alert.triggered")).toHaveLength(1);
    expect(ofType("alert.sent")).toHaveLength(0);
    expect(error).toHaveBeenCalled();
  });
});

describe("orchestrator: STT sessions", () => {
  function fakeStt() {
    const sent: AudioFrame[] = [];
    const closed: string[] = [];
    const emit: Record<string, (e: TranscriptEvent) => void> = {};
    const adapter: SttAdapter = {
      name: "deepgram",
      openSession(callId, speaker, onTranscript) {
        emit[`${callId}/${speaker}`] = onTranscript;
        return {
          sendAudio: (frame) => sent.push(frame),
          close: async () => void closed.push(`${callId}/${speaker}`),
        };
      },
    };
    return { adapter, sent, closed, emit };
  }

  function frame(callId: string, speaker: "caller" | "victim"): AudioFrame {
    return { type: "audio.frame", callId, speaker, encoding: "pcm16", sampleRate: 16000, payload: "", seq: 0, ts: 0 };
  }

  it("routes audio by speaker, publishes transcripts, and closes sessions on call.ended", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const stt = fakeStt();
    orchestrator.stop();
    orchestrator = createOrchestrator(bus, { stt: stt.adapter });

    startCall("c1");
    bus.publish(frame("c1", "caller"));
    bus.publish(frame("c1", "victim"));
    expect(stt.sent.map((f) => f.speaker)).toEqual(["caller", "victim"]);

    stt.emit["c1/caller"]!({
      type: "transcript", callId: "c1", speaker: "caller", segmentId: "s1",
      text: "hello", isFinal: true, startMs: 0, endMs: 500, ts: 1,
    });
    expect(ofType("transcript")).toHaveLength(1);
    expect(orchestrator.getCall("c1")!.turns).toHaveLength(1);

    bus.publish({ type: "call.ended", callId: "c1", reason: "hangup", ts: 2 });
    await vi.runAllTicks();
    await Promise.resolve();
    expect(stt.closed.sort()).toEqual(["c1/caller", "c1/victim"]);
  });
});

describe("orchestrator: LLM trigger policy (M4)", () => {
  const DEBOUNCE = 1200;
  const HEARTBEAT = 30_000;

  /** A classify() whose responses the test releases one at a time. */
  function fakeClassify(respond: (req: LLMRequest) => Partial<LLMResult> = () => ({})) {
    const requests: LLMRequest[] = [];
    const waiting: Array<() => void> = [];
    const classify = (req: LLMRequest) =>
      new Promise<LLMResult>((resolve) => {
        requests.push(req);
        waiting.push(() =>
          resolve({
            type: "llm.result",
            callId: req.callId,
            seq: req.seq,
            signals: [],
            score: 50,
            benignContext: false,
            reason: "fake read",
            carryContext: `memory after seq ${req.seq}`,
            latencyMs: 5,
            model: "fake",
            ts: Date.now(),
            ...respond(req),
          })
        );
      });
    /** Resolves the oldest outstanding request and lets its handlers run. */
    const settle = async () => {
      waiting.shift()!();
      await vi.advanceTimersByTimeAsync(0);
    };
    return { classify, requests, settle };
  }

  let seg = 0;
  function say(callId: string, speaker: "caller" | "victim", text: string) {
    seg += 1;
    bus.publish({
      type: "transcript", callId, speaker, segmentId: `s${seg}`, text, isFinal: true,
      startMs: seg * 3000, endMs: seg * 3000 + 2000, ts: Date.now(),
    });
  }

  function withLlm(fake: ReturnType<typeof fakeClassify>) {
    orchestrator.stop();
    orchestrator = createOrchestrator(bus, {
      now: () => Date.now(),
      classify: fake.classify,
      llmDebounceMs: DEBOUNCE,
      llmHeartbeatMs: HEARTBEAT,
    });
  }

  it("catches a caller who never says a keyword: the heartbeat sends the talk to the LLM", async () => {
    const fake = fakeClassify(() => ({ score: 80, signals: ["IMPERSONATION"], reason: "vague authority claim" }));
    withLlm(fake);
    startCall("c1");

    say("c1", "caller", "hi there, can you do me a favor and head down to the store for me");
    say("c1", "victim", "sure, what do you need");
    // Self-check: this conversation really does slip past the rules.
    expect((ofType("rules.hits") as RulesHitsEvent[]).every((h) => h.hits.length === 0)).toBe(true);

    await vi.advanceTimersByTimeAsync(HEARTBEAT - 2000);
    expect(fake.requests).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2000 + DEBOUNCE);
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]).toMatchObject({ callId: "c1", seq: 1, trigger: "heartbeat" });
    expect(fake.requests[0].turns.map((t) => t.speaker)).toEqual(["caller", "victim"]);

    await fake.settle();
    expect(ofType("llm.result")).toHaveLength(1);
    const scores = ofType("score.updated") as ScoreUpdated[];
    expect(scores.at(-1)).toMatchObject({ source: "llm", reason: "vague authority claim" });
    expect(orchestrator.getCall("c1")!.score.signals.IMPERSONATION?.source).toBe("llm");
  });

  it("doesn't heartbeat when nobody has said anything new", async () => {
    const fake = fakeClassify();
    withLlm(fake);
    startCall("c1");
    await vi.advanceTimersByTimeAsync(HEARTBEAT * 3);
    expect(fake.requests).toHaveLength(0);
  });

  it("calls the LLM once, after the debounce, for a burst of rule hits", async () => {
    const fake = fakeClassify();
    withLlm(fake);
    startCall("c1");

    say("c1", "caller", "this is Officer Daniels calling from Medicare");
    say("c1", "caller", "you need to pay with a gift card today");
    await vi.advanceTimersByTimeAsync(DEBOUNCE - 1);
    expect(fake.requests).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0].trigger).toBe("rule");
    expect(fake.requests[0].turns).toHaveLength(2);
  });

  it("labels victim compliance or disclosure as the stronger 'victim' trigger", async () => {
    const fake = fakeClassify();
    withLlm(fake);
    startCall("c1");

    say("c1", "caller", "you need to pay with a gift card today");
    say("c1", "victim", "okay, I'm heading to the store now");
    const victimHits = (ofType("rules.hits") as RulesHitsEvent[]).filter((h) => h.speaker === "victim");
    expect(victimHits.at(-1)!.hits.some((h) => h.signal === "VICTIM_COMPLIANCE")).toBe(true);

    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    expect(fake.requests.map((r) => r.trigger)).toEqual(["victim"]);
  });

  it("keeps one request in flight, then runs what queued up behind it", async () => {
    const fake = fakeClassify();
    withLlm(fake);
    startCall("c1");

    say("c1", "caller", "this is Officer Daniels calling from Medicare");
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    expect(fake.requests).toHaveLength(1);

    say("c1", "caller", "you need to pay with a gift card today");
    say("c1", "caller", "don't tell anyone about this call");
    await vi.advanceTimersByTimeAsync(DEBOUNCE * 5);
    expect(fake.requests).toHaveLength(1); // still waiting on the first

    await fake.settle();
    expect(fake.requests).toHaveLength(2);
    expect(fake.requests[1]).toMatchObject({ seq: 2, trigger: "rule" });
    // The memory from the first result rides along into the second request.
    expect(fake.requests[1].state.carryContext).toBe("memory after seq 1");
  });

  it("takes one last look at hangup, at speech the heartbeat never got to", async () => {
    const fake = fakeClassify();
    withLlm(fake);
    startCall("c1");
    say("c1", "caller", "hi there, can you do me a favor and head down to the store for me");
    say("c1", "victim", "I suppose I can drive over there now");
    await vi.advanceTimersByTimeAsync(HEARTBEAT / 2);
    expect(fake.requests).toHaveLength(0);

    bus.publish({ type: "call.ended", callId: "c1", reason: "hangup", ts: Date.now() });
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]).toMatchObject({ trigger: "final" });
    expect(fake.requests[0].turns.at(-1)!.text).toBe("I suppose I can drive over there now");

    await fake.settle();
    expect(ofType("llm.result")).toHaveLength(1); // an ended call still scores
  });

  it("skips the final look when the LLM has already read everything", async () => {
    const fake = fakeClassify();
    withLlm(fake);
    startCall("c1");
    say("c1", "caller", "this is Officer Daniels calling from Medicare");
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    await fake.settle();

    bus.publish({ type: "call.ended", callId: "c1", reason: "hangup", ts: Date.now() });
    await vi.advanceTimersByTimeAsync(DEBOUNCE * 3);
    expect(fake.requests).toHaveLength(1);
  });

  it("waits for the STT flush, so the last words before hangup are included", async () => {
    const fake = fakeClassify();
    let emitCaller: ((e: TranscriptEvent) => void) | undefined;
    const stt: SttAdapter = {
      name: "deepgram",
      openSession(callId, speaker, onTranscript) {
        if (speaker === "caller") emitCaller = onTranscript;
        return {
          sendAudio: () => {},
          // The vendor's tail arrives while closing, like Deepgram's flush.
          close: async () => {
            if (speaker !== "caller") return;
            await Promise.resolve();
            onTranscript({
              type: "transcript", callId, speaker, segmentId: "tail", isFinal: true,
              text: "if you hang up the case goes to the federal courts",
              startMs: 9000, endMs: 11000, ts: Date.now(),
            });
          },
        };
      },
    };
    vi.spyOn(console, "log").mockImplementation(() => {});
    orchestrator.stop();
    orchestrator = createOrchestrator(bus, {
      stt, classify: fake.classify, llmDebounceMs: DEBOUNCE, llmHeartbeatMs: HEARTBEAT,
    });
    startCall("c1");
    emitCaller!({
      type: "transcript", callId: "c1", speaker: "caller", segmentId: "s1", isFinal: true,
      text: "stay on the line with me", startMs: 0, endMs: 2000, ts: Date.now(),
    });

    bus.publish({ type: "call.ended", callId: "c1", reason: "hangup", ts: Date.now() });
    await vi.advanceTimersByTimeAsync(DEBOUNCE * 2);
    const texts = fake.requests.flatMap((r) => r.turns.map((t) => t.text));
    expect(texts).toContain("if you hang up the case goes to the federal courts");
  });

  it("drops a result whose seq is stale", async () => {
    const fake = fakeClassify(() => ({ seq: 99, score: 100 }));
    withLlm(fake);
    startCall("c1");
    say("c1", "caller", "this is Officer Daniels calling from Medicare");
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    await fake.settle();

    expect(ofType("llm.result")).toHaveLength(0);
    expect((ofType("score.updated") as ScoreUpdated[]).some((s) => s.source === "llm")).toBe(false);
  });

  it("still alerts exactly once on the Medicare scam with the LLM agreeing", async () => {
    const fake = fakeClassify(() => ({ score: 90 }));
    withLlm(fake);
    startCall("scam");
    play(fixture("gift-card-medicare-scam", "scam"));
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    await fake.settle();
    expect(ofType("alert.triggered")).toHaveLength(1);
  });

  it("keeps the family check-in quiet when the LLM reads it as benign", async () => {
    const fake = fakeClassify(() => ({ score: 5, benignContext: true, reason: "grandson checking in" }));
    withLlm(fake);
    startCall("legit");
    play(fixture("legit-family-checkin", "legit"));
    await vi.advanceTimersByTimeAsync(HEARTBEAT + DEBOUNCE);
    while (fake.requests.length > ofType("llm.result").length) await fake.settle();
    expect(ofType("alert.triggered")).toHaveLength(0);
  });
});
