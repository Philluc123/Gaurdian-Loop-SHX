# orchestrator

**Workstream:** B. Core
**Contract:** [`docs/module-contracts.md`](../../../../docs/module-contracts.md) §3.3

## Owns

The event bus wiring, per-call state, the rolling context window, the LLM trigger
policy (when to call it, debounce, one request in flight), and fan-out to the
dashboard, event store, and alerts.

**This is the only module in the whole service allowed to hold per-call state.**
Every other module (rules, score engine, LLM classifier) is a pure or stateless async
function specifically so it can be built and tested without touching this file.

## State shape

```ts
interface CallState {
  callId: CallId;
  guardian: Guardian;
  startedAt: number;
  turns: Turn[];
  windowSec: number;
  score: ScoreState;                      // owned by score-engine, stored here
  llm: { inFlight: boolean; dirty: boolean; seq: number; lastRunAt: number; carryContext: string };
}
```

## Trigger policy (call the LLM when)

1. a final segment produces any rule hit,
2. a victim-side compliance or disclosure hit occurs,
3. ~45s of speech pass with no LLM call (heartbeat).

Debounce each trigger ~1.2s. Keep at most one LLM request in flight per call; drop
results whose `seq` is stale.

## Depends on

`../call-ingestion`, `../stt-adapters` (indirectly, via events), `../rules-classifier`,
`../llm-classifier`, `../score-engine` — always through the event bus, never by
importing their internals.

## Done when

Replaying a fixture file (`scripts/replay.ts`) drives the full chain — transcript →
rules → LLM trigger → score → dashboard/store/alerts — end to end with zero vendors
connected.
