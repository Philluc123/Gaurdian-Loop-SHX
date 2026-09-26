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
  input: RulesHitsEvent | LLMResult | { type: "tick"; ts: number }
): { next: ScoreState; events: Array<ScoreUpdated | AlertTriggered> };
```

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
