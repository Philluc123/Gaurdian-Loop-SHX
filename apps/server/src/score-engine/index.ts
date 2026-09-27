// score-engine (docs/module-contracts.md §3.6).
//
// Pure reducer: (prev state, one input, call context) -> (next state, events).
// No I/O, no bus access, no clock, no randomness, no mutation of `prev`. The
// orchestrator stores `ScoreState` in its CallState and publishes the returned
// events.
//
// Behaviour in one paragraph: final rule hits ratchet the score up by their
// weights (repeats count half); the first time rule hits complete a combo it adds
// a bonus and may raise `floor`, a sticky minimum for the rest of the call. Each
// LLM result moves the score part-way toward the LLM's estimate but never below
// `floor`. Ticks decay the score toward `floor`. An alert fires once when the
// score reaches ALERT_THRESHOLD and re-arms only after it falls below REARM_BELOW.

import type {
  AlertTriggered,
  CallId,
  LLMResult,
  RiskLevel,
  RulesHitsEvent,
  ScoreState,
  ScoreTick,
  ScoreUpdated,
  Signal,
  Speaker,
} from "@guardian-loop/shared-types";
import {
  ALERT_THRESHOLD,
  COMBOS,
  DECAY_PER_TICK,
  LLM_ERROR_REASON,
  LLM_PULL,
  LLM_PULL_BENIGN_UP,
  PROTECTIVE_SIGNALS,
  REARM_BELOW,
  REPEAT_FACTOR,
  SIGNAL_LABELS,
  type Combo,
} from "./config";

export * from "./config";

export type ScoreInput = RulesHitsEvent | LLMResult | ScoreTick;
export type ScoreEvent = ScoreUpdated | AlertTriggered;

/**
 * Per-call facts the orchestrator already holds. Passed in rather than stored in
 * ScoreState so the reducer can emit complete events (`tick` has no callId, and
 * alerts need a transcript snippet) without duplicating orchestrator state.
 */
export interface ScoreContext {
  callId: CallId;
  startedAt: number; // epoch ms, CallState.startedAt
  recentTurns: Array<{ speaker: Speaker; text: string }>; // last few final turns; last 3 go into alerts
}

type SignalMap = ScoreState["signals"];
type Source = "rules" | "llm" | "decay";

export function initialScoreState(): ScoreState {
  return { score: 0, floor: 0, level: "low", signals: {}, alertArmed: true, lastReason: "" };
}

export function levelFor(score: number): RiskLevel {
  if (score >= 70) return "high";
  if (score >= 40) return "elevated";
  return "low";
}

export function updateScore(
  prev: ScoreState,
  input: ScoreInput,
  ctx: ScoreContext
): { next: ScoreState; events: ScoreEvent[] } {
  switch (input.type) {
    case "rules.hits":
      return applyRules(prev, input, ctx);
    case "llm.result":
      return applyLLM(prev, input, ctx);
    case "tick":
      return applyTick(prev, input, ctx);
  }
}

function applyRules(prev: ScoreState, ev: RulesHitsEvent, ctx: ScoreContext) {
  if (!ev.isFinal || ev.hits.length === 0) return unchanged(prev);

  // Strongest hit per signal, so one sentence tripping two gift-card patterns counts once.
  const strongest = new Map<Signal, number>();
  for (const hit of ev.hits) {
    strongest.set(hit.signal, Math.max(strongest.get(hit.signal) ?? 0, hit.weight));
  }

  let delta = 0;
  for (const [signal, weight] of strongest) {
    const points = isRuleBacked(prev.signals, signal) ? Math.round(weight * REPEAT_FACTOR) : weight;
    delta += PROTECTIVE_SIGNALS.has(signal) ? -points : points;
  }

  const signals = mergeSignals(prev.signals, [...strongest.keys()], "rules", ev.ts - ctx.startedAt);
  const newCombos = COMBOS.filter((c) => comboMet(signals, c) && !comboMet(prev.signals, c));
  const bonus = newCombos.reduce((sum, c) => sum + c.bonus, 0);
  const floor = Math.max(prev.floor, ...newCombos.map((c) => c.floor));

  const reasonSignals = newCombos.length > 0 ? newCombos.flatMap((c) => c.signals) : [...strongest.keys()];
  const reason = describe(reasonSignals);

  return finish(prev, { score: prev.score + delta + bonus, floor, signals, lastReason: reason }, "rules", ev.ts, ctx);
}

function applyLLM(prev: ScoreState, r: LLMResult, ctx: ScoreContext) {
  // An errored call carries no information; leave the score exactly where it was.
  if (r.reason === LLM_ERROR_REASON) return unchanged(prev);

  const pull = r.benignContext && r.score > prev.score ? LLM_PULL_BENIGN_UP : LLM_PULL;
  const score = prev.score + (r.score - prev.score) * pull;
  const signals = mergeSignals(prev.signals, r.signals, "llm", r.ts - ctx.startedAt);

  return finish(prev, { score, signals, lastReason: r.reason || prev.lastReason }, "llm", r.ts, ctx);
}

function applyTick(prev: ScoreState, t: ScoreTick, ctx: ScoreContext) {
  if (prev.score <= prev.floor) return unchanged(prev);
  return finish(prev, { score: prev.score - DECAY_PER_TICK }, "decay", t.ts, ctx);
}

/** Clamps, applies the floor, re-arms/fires the alert, and builds the events. */
function finish(
  prev: ScoreState,
  patch: Partial<ScoreState>,
  source: Source,
  ts: number,
  ctx: ScoreContext
): { next: ScoreState; events: ScoreEvent[] } {
  const floor = patch.floor ?? prev.floor;
  const score = clamp(Math.max(Math.round(patch.score ?? prev.score), floor));
  const signals = patch.signals ?? prev.signals;
  const lastReason = patch.lastReason ?? prev.lastReason;

  let alertArmed = prev.alertArmed || score < REARM_BELOW;
  const fire = alertArmed && score >= ALERT_THRESHOLD;
  if (fire) alertArmed = false;

  const next: ScoreState = { score, floor, level: levelFor(score), signals, alertArmed, lastReason };
  const events: ScoreEvent[] = [];

  // Decay only reports actual movement; rules/LLM always report (signals or reason may have changed).
  if (source !== "decay" || score !== prev.score) {
    events.push({
      type: "score.updated",
      callId: ctx.callId,
      score,
      level: next.level,
      signals: orderedSignals(signals),
      reason: lastReason,
      source,
      ts,
    });
  }
  if (fire) {
    events.push({
      type: "alert.triggered",
      callId: ctx.callId,
      alertId: `${ctx.callId}:alert:${ts}`,
      score,
      threshold: ALERT_THRESHOLD,
      reason: lastReason,
      snippet: ctx.recentTurns.slice(-3).map(({ speaker, text }) => ({ speaker, text })),
      ts,
    });
  }
  return { next, events };
}

function unchanged(prev: ScoreState): { next: ScoreState; events: ScoreEvent[] } {
  return { next: prev, events: [] };
}

function mergeSignals(prev: SignalMap, add: Signal[], source: "rules" | "llm", firstSeenMs: number): SignalMap {
  if (add.length === 0) return prev;
  const next: SignalMap = { ...prev };
  for (const signal of add) {
    const existing = next[signal];
    if (!existing) {
      next[signal] = { source, firstSeenMs: Math.max(0, firstSeenMs) };
    } else if (existing.source !== source && existing.source !== "both") {
      next[signal] = { ...existing, source: "both" };
    }
  }
  return next;
}

function isRuleBacked(signals: SignalMap, signal: Signal): boolean {
  const s = signals[signal]?.source;
  return s === "rules" || s === "both";
}

function comboMet(signals: SignalMap, combo: Combo): boolean {
  return combo.signals.every((s) => isRuleBacked(signals, s));
}

function orderedSignals(signals: SignalMap): Signal[] {
  return (Object.keys(signals) as Signal[]).sort(
    (a, b) => signals[a]!.firstSeenMs - signals[b]!.firstSeenMs || a.localeCompare(b)
  );
}

function describe(signals: Signal[]): string {
  return [...new Set(signals)].map((s) => SIGNAL_LABELS[s]).join(" + ");
}

function clamp(n: number): number {
  return Math.min(100, Math.max(0, n));
}
