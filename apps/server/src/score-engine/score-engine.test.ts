// Unit tests for the score engine (docs/module-contracts.md §3.6).

import { describe, expect, it } from "vitest";
import type { LLMResult, RuleHit, RulesHitsEvent, ScoreState, Signal, Speaker } from "@guardian-loop/shared-types";
import {
  ALERT_THRESHOLD,
  DECAY_PER_TICK,
  REARM_BELOW,
  initialScoreState,
  updateScore,
  type ScoreContext,
  type ScoreEvent,
  type ScoreInput,
} from "./index";

const T0 = 1_700_000_000_000;
const ctx: ScoreContext = {
  callId: "CA123",
  startedAt: T0,
  recentTurns: [
    { speaker: "caller", text: "This is the IRS." },
    { speaker: "victim", text: "Oh no, what happened?" },
    { speaker: "caller", text: "Buy the gift cards and don't tell your daughter." },
    { speaker: "victim", text: "Okay." },
  ],
};

function hit(signal: Signal, weight: number, ruleId = `${signal.toLowerCase()}.test`): RuleHit {
  return { ruleId, signal, weight, match: "x", start: 0, end: 1 };
}

function rules(hits: RuleHit[], opts: { isFinal?: boolean; speaker?: Speaker; ts?: number } = {}): RulesHitsEvent {
  return {
    type: "rules.hits",
    callId: ctx.callId,
    segmentId: "seg",
    speaker: opts.speaker ?? "caller",
    isFinal: opts.isFinal ?? true,
    hits,
    ts: opts.ts ?? T0 + 1000,
  };
}

function llm(score: number, opts: Partial<LLMResult> = {}): LLMResult {
  return {
    type: "llm.result",
    callId: ctx.callId,
    seq: 1,
    signals: [],
    score,
    benignContext: false,
    reason: "model reason",
    carryContext: "",
    latencyMs: 500,
    model: "test",
    ts: T0 + 2000,
    ...opts,
  };
}

const tick = (ts = T0 + 3000) => ({ type: "tick" as const, ts });

/** Folds a sequence of inputs, collecting every emitted event. */
function run(inputs: ScoreInput[], start: ScoreState = initialScoreState()) {
  let state = start;
  const events: ScoreEvent[] = [];
  for (const input of inputs) {
    const out = updateScore(state, input, ctx);
    state = out.next;
    events.push(...out.events);
  }
  return { state, events, alerts: events.filter((e) => e.type === "alert.triggered") };
}

const ticks = (n: number) => Array.from({ length: n }, (_, i) => tick(T0 + 10_000 + i * 1000));

describe("rule hits", () => {
  it("ignores partial hits entirely", () => {
    const prev = initialScoreState();
    const out = updateScore(prev, rules([hit("UNTRACEABLE_PAYMENT", 35)], { isFinal: false }), ctx);
    expect(out.next).toBe(prev);
    expect(out.events).toEqual([]);
  });

  it("ignores a final segment with no hits", () => {
    const prev = initialScoreState();
    expect(updateScore(prev, rules([]), ctx)).toEqual({ next: prev, events: [] });
  });

  it("adds each signal's weight and records it with firstSeenMs relative to call start", () => {
    const { state, events } = run([rules([hit("URGENCY", 12), hit("IMPERSONATION", 22)], { ts: T0 + 4200 })]);
    expect(state.score).toBe(34 + 8); // + impersonation+urgency soft combo
    expect(state.level).toBe("elevated");
    expect(state.signals.URGENCY).toEqual({ source: "rules", firstSeenMs: 4200 });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "score.updated", callId: "CA123", score: 42, source: "rules" });
  });

  it("counts the strongest hit per signal once within a segment", () => {
    const { state } = run([rules([hit("UNTRACEABLE_PAYMENT", 35), hit("UNTRACEABLE_PAYMENT", 30)])]);
    expect(state.score).toBe(35);
  });

  it("counts a repeated signal at half weight in later segments", () => {
    const { state } = run([rules([hit("URGENCY", 12)]), rules([hit("URGENCY", 12)])]);
    expect(state.score).toBe(18);
  });

  it("lowers the score on victim resistance", () => {
    const { state } = run([rules([hit("IMPERSONATION", 22)]), rules([hit("VICTIM_RESISTANCE", 14)], { speaker: "victim" })]);
    expect(state.score).toBe(8);
  });

  it("clamps to 0-100", () => {
    const big = [hit("CREDENTIAL_REQUEST", 38), hit("IMPERSONATION", 25), hit("UNTRACEABLE_PAYMENT", 35), hit("THREAT", 24)];
    expect(run([rules(big)]).state.score).toBe(100);
    expect(run([rules([hit("VICTIM_RESISTANCE", 14)], { speaker: "victim" })]).state.score).toBe(0);
  });
});

describe("combos", () => {
  it("secrecy + gift-card request crosses the alert threshold on rules alone", () => {
    const { state, alerts } = run([rules([hit("SECRECY", 14, "secrecy.dont_tell"), hit("UNTRACEABLE_PAYMENT", 35, "payment.gift_card")])]);
    expect(state.score).toBeGreaterThanOrEqual(ALERT_THRESHOLD);
    expect(state.floor).toBe(75);
    expect(state.level).toBe("high");
    expect(alerts).toHaveLength(1);
  });

  it("completes a combo across separate segments", () => {
    const { state, alerts } = run([rules([hit("SECRECY", 14)]), rules([hit("UNTRACEABLE_PAYMENT", 35)])]);
    expect(state.floor).toBe(75);
    expect(state.score).toBeGreaterThanOrEqual(75);
    expect(alerts).toHaveLength(1);
    expect(state.lastReason).toBe("secrecy request + untraceable payment request");
  });

  it("applies the combo bonus only once", () => {
    const first = run([rules([hit("URGENCY", 12), hit("THREAT", 22)])]).state; // 34 + 10 bonus
    expect(first.score).toBe(44);
    const again = updateScore(first, rules([hit("THREAT", 22)]), ctx).next;
    expect(again.score).toBe(44 + 11); // half-weight repeat, no second bonus
  });

  it("soft combos bump the score without setting a floor", () => {
    const { state } = run([rules([hit("URGENCY", 12), hit("THREAT", 22)])]);
    expect(state.floor).toBe(0);
  });

  it("LLM-only signals do not complete a combo or set a floor", () => {
    const { state } = run([rules([hit("SECRECY", 14)]), llm(30, { signals: ["UNTRACEABLE_PAYMENT"] })]);
    expect(state.floor).toBe(0);
    expect(state.signals.UNTRACEABLE_PAYMENT?.source).toBe("llm");
  });
});

describe("LLM results", () => {
  it("moves the score halfway toward the LLM estimate, up or down", () => {
    const up = run([llm(60)]).state;
    expect(up.score).toBe(30);
    const down = run([rules([hit("IMPERSONATION", 22), hit("THREAT", 22)]), llm(0)]).state; // 44 -> 22
    expect(down.score).toBe(22);
  });

  it("pulls upward more gently when the context is benign", () => {
    expect(run([llm(80, { benignContext: true })]).state.score).toBe(20);
  });

  it("cannot pull the score below the combo floor", () => {
    const { state, events } = run([
      rules([hit("SECRECY", 14), hit("UNTRACEABLE_PAYMENT", 35)]),
      llm(5, { benignContext: true, reason: "sounds like a legit bank call" }),
    ]);
    expect(state.score).toBe(75);
    expect(state.floor).toBe(75);
    expect(events.at(-1)).toMatchObject({ type: "score.updated", score: 75, source: "llm", reason: "sounds like a legit bank call" });
  });

  it("merges signal sources to 'both' and keeps the first firstSeenMs", () => {
    const { state } = run([rules([hit("URGENCY", 12)], { ts: T0 + 1000 }), llm(40, { signals: ["URGENCY"], ts: T0 + 9000 })]);
    expect(state.signals.URGENCY).toEqual({ source: "both", firstSeenMs: 1000 });
  });

  it("ignores llm_error results", () => {
    const prev = run([rules([hit("IMPERSONATION", 22)])]).state;
    const out = updateScore(prev, llm(0, { reason: "llm_error" }), ctx);
    expect(out.next).toBe(prev);
    expect(out.events).toEqual([]);
  });

  it("can trigger the alert on its own", () => {
    const { alerts } = run([rules([hit("IMPERSONATION", 22), hit("THREAT", 24)]), llm(100)]); // 46 -> 73
    expect(alerts).toHaveLength(1);
  });
});

describe("decay", () => {
  it("decays by DECAY_PER_TICK per tick and emits source 'decay'", () => {
    const { state, events } = run([rules([hit("IMPERSONATION", 22)]), tick(), tick()]);
    expect(state.score).toBe(22 - 2 * DECAY_PER_TICK);
    expect(events.at(-1)).toMatchObject({ type: "score.updated", source: "decay", score: state.score });
  });

  it("stops at zero and goes quiet", () => {
    const { state } = run([rules([hit("URGENCY", 12)]), ...ticks(30)]);
    expect(state.score).toBe(0);
    const out = updateScore(state, tick(), ctx);
    expect(out.next).toBe(state);
    expect(out.events).toEqual([]);
  });

  it("never decays below the floor (sticky for the call)", () => {
    const { state } = run([rules([hit("SECRECY", 14), hit("UNTRACEABLE_PAYMENT", 35)]), ...ticks(300)]);
    expect(state.score).toBe(75);
    expect(state.level).toBe("high");
  });

  it("updates the risk level as it decays", () => {
    const { state } = run([rules([hit("IMPERSONATION", 22), hit("THREAT", 22)]), ...ticks(5)]); // 44 -> 39
    expect(state.score).toBe(39);
    expect(state.level).toBe("low");
  });
});

describe("alerts", () => {
  it("emits a complete AlertTriggered after the score update", () => {
    const { events } = run([rules([hit("SECRECY", 14), hit("UNTRACEABLE_PAYMENT", 35)], { ts: T0 + 5000 })]);
    expect(events.map((e) => e.type)).toEqual(["score.updated", "alert.triggered"]);
    expect(events[1]).toEqual({
      type: "alert.triggered",
      callId: "CA123",
      alertId: `CA123:alert:${T0 + 5000}`,
      score: 75, // 14 + 35 + 25 bonus = 74, lifted to the combo floor
      threshold: 70,
      reason: "secrecy request + untraceable payment request",
      snippet: ctx.recentTurns.slice(-3),
      ts: T0 + 5000,
    });
  });

  it("fires exactly once while the score stays above threshold", () => {
    const { alerts, state } = run([
      rules([hit("SECRECY", 14), hit("UNTRACEABLE_PAYMENT", 35)]),
      rules([hit("THREAT", 24)]),
      llm(100),
      rules([hit("UNTRACEABLE_PAYMENT", 35)]),
      ...ticks(10),
      llm(95),
    ]);
    expect(alerts).toHaveLength(1);
    expect(state.alertArmed).toBe(false);
  });

  it("does not re-fire after dipping just below threshold (hysteresis)", () => {
    // No floor: impersonation + threat + urgency via soft combos, pushed up by the LLM.
    const { alerts, state } = run([
      rules([hit("IMPERSONATION", 22), hit("THREAT", 24)]),
      llm(100), // 46 -> 73, fires
      ...ticks(10), // 63: below threshold but above REARM_BELOW
      llm(90), // back up to 77
    ]);
    expect(state.score).toBeGreaterThanOrEqual(ALERT_THRESHOLD);
    expect(alerts).toHaveLength(1);
  });

  it("re-arms once the score drops below REARM_BELOW and fires again on the next crossing", () => {
    const { alerts, state } = run([
      rules([hit("IMPERSONATION", 22), hit("THREAT", 24)]),
      llm(100), // fires
      ...ticks(30), // 73 -> 43, re-arms
      llm(100, { ts: T0 + 60_000 }), // 43 -> 72, fires again
    ]);
    expect(alerts).toHaveLength(2);
    expect(alerts[0]!.alertId).not.toBe(alerts[1]!.alertId);
    expect(state.alertArmed).toBe(false);
  });

  it("re-arms at REARM_BELOW exactly as configured", () => {
    const armedAt = (score: number) => updateScore({ ...initialScoreState(), score: score + 1, alertArmed: false }, tick(), ctx).next.alertArmed;
    expect(armedAt(REARM_BELOW)).toBe(false);
    expect(armedAt(REARM_BELOW - 1)).toBe(true);
  });

  it("with a hard-combo floor, never re-arms for the rest of the call", () => {
    const { alerts } = run([
      rules([hit("SECRECY", 14), hit("UNTRACEABLE_PAYMENT", 35)]),
      ...ticks(120),
      llm(0),
      rules([hit("CREDENTIAL_REQUEST", 36)]),
    ]);
    expect(alerts).toHaveLength(1);
  });
});

describe("purity", () => {
  it("does not mutate the previous state", () => {
    const prev = run([rules([hit("URGENCY", 12)])]).state;
    const snapshot = structuredClone(prev);
    updateScore(prev, rules([hit("SECRECY", 14), hit("UNTRACEABLE_PAYMENT", 35)]), ctx);
    updateScore(prev, llm(90, { signals: ["THREAT"] }), ctx);
    updateScore(prev, tick(), ctx);
    expect(prev).toEqual(snapshot);
  });

  it("is deterministic", () => {
    const inputs: ScoreInput[] = [rules([hit("SECRECY", 14)]), llm(50), rules([hit("UNTRACEABLE_PAYMENT", 35)]), ...ticks(5)];
    expect(run(inputs)).toEqual(run(inputs));
  });
});
