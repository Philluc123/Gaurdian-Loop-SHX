# orchestrator

**Workstream:** B. Core
**Contract:** [`docs/module-contracts.md`](../../../../docs/module-contracts.md) §3.3
**Status:** rules → score → dashboard → guardian notification is built and running
(M1–M3). Still to wire in: the LLM trigger policy (M4).

## What's built

| File | Does |
|---|---|
| `index.ts` | per-call state; transcript → `runRules` → `rules.hits` → `updateScore` → `score.updated` / `alert.triggered`; one 1s decay tick for all live calls |
| `dashboard-feed.ts` | `/ws/dashboard` (§3.8): snapshot on subscribe and on call start, then transcript / highlights / score / alert / call_ended for the followed call; `notify()` reaches every dashboard |
| `dashboard-alerts.ts` | the alerts module's notification provider (M3): delivers its notification through the feed, and fails honestly when no guardian dashboard is connected |

Checked against the transcript fixtures: both scam calls cross the threshold and alert
exactly once; the legitimate family check-in stays below it with no alert.

**Wiring order matters.** Create the orchestrator before the dashboard feed. Bus
listeners run in registration order, and the snapshot the feed pushes on `call.started`
needs the orchestrator to have created that call's state first.

Rules run on **partial** transcripts too, and `rules.hits` is published for every
transcript even when empty: partial hits drive live highlighting, an empty one clears
highlights an earlier partial put up, and only final hits move the score (the score
engine enforces that).

An ended call keeps accepting finals, because the STT adapter flushes the last words
just after hangup. It stops decaying.

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
