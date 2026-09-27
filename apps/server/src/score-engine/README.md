# score-engine

**Workstream:** B. Core
**Contract:** [`docs/module-contracts.md`](../../../../docs/module-contracts.md) §3.6

## Owns

Combining rule + LLM signals, combo bonuses, ratchet-up and decay over time, and
deciding when to fire an alert.

## Interface (pure reducer — no side effects, no bus access)

```ts
function updateScore(
  prev: ScoreState,
  input: RulesHitsEvent | LLMResult | { type: "tick"; ts: number },
  ctx: { callId: CallId; startedAt: number; recentTurns: Array<{ speaker: Speaker; text: string }> }
): { next: ScoreState; events: Array<ScoreUpdated | AlertTriggered> };

function initialScoreState(): ScoreState;   // store this in CallState on call.started
```

`ctx` comes straight from the orchestrator's `CallState` (`callId`, `startedAt`,
`turns.slice(-3)`). It exists because `tick` has no `callId` and `AlertTriggered`
needs a transcript snippet: the alerts module sends `snippet`/`reason` verbatim, so the
event has to be complete when it leaves the reducer.

## Scoring model (tunables in `config.ts`)

- **Rules** (final only): strongest hit per signal per segment adds its weight; a
  signal already seen from rules adds half. `VICTIM_RESISTANCE` subtracts.
- **Combos**: the first time rule-backed signals complete a combo, add its bonus.
  Hard combos (e.g. `SECRECY + UNTRACEABLE_PAYMENT`) also raise `floor` to ≥ 75.
  LLM-only signals never complete a combo.
- **Floor**: a sticky minimum for the rest of the call. Neither decay nor the LLM
  can take the score below it. Hard rule combos set it, and so do **two consecutive
  LLM reads of 80 or more** (neither benign), at the lower of the two. Without that,
  decay between heartbeats caps a no-keyword scam at roughly the LLM's estimate
  minus the heartbeat's worth of decay, which can never reach 70. A single read can't
  set it, so one manipulated or mistaken read can't alert alone. `llm_error` results
  neither break nor extend the streak.
- **LLM**: the score moves halfway toward the LLM's estimate (a quarter of the way
  when `benignContext` is true and the estimate is higher). `llm_error` is ignored.
- **Decay**: −1 per `tick`, down to `floor`. A tick that changes nothing emits nothing.
- **Alert**: fires when the score reaches 70 while armed, then disarms. It re-arms
  only once the score drops below 50, so a hard-combo floor means one alert per call.

Only **final** rule hits (`isFinal: true`) affect the score — partials are
highlight-only. The orchestrator sends a `tick` about once per second to drive decay.

`ScoreState.floor` is a minimum set by hard rule combos that the LLM's own score
estimate can't undercut — don't let a benign-sounding LLM read pull the score below a
combo that already fired on rules alone.

## Why pure

Same reason as `rules-classifier`: build and test this with nothing else running,
just `ScoreState` in and `{ next, events }` out.

## Done when

Unit tests confirm: hard combos (e.g. secrecy + gift-card request) cross the alert
threshold on rules alone, decay behaves correctly over ticks, the LLM floor holds, and
exactly one `AlertTriggered` fires per threshold crossing (no re-firing until the
score drops well below threshold and re-arms).
