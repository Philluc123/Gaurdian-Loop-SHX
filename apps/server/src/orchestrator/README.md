# orchestrator

**Workstream:** B. Core
**Contract:** [`docs/module-contracts.md`](../../../../docs/module-contracts.md) §3.3
**Status:** rules → score → dashboard → guardian notification (M1–M3) and the LLM
trigger policy (M4) are built and running. The LLM is on when `GEMINI_API_KEY` is set;
without it, scoring runs on rules alone.

## What's built

| File | Does |
|---|---|
| `index.ts` | per-call state; transcript → `runRules` → `rules.hits` → `updateScore` → `score.updated` / `alert.triggered`; one 1s decay tick for all live calls; the LLM trigger policy (rule / victim / heartbeat → `classify` → `llm.result` → `updateScore`) |
| `stt-sessions.ts` | one STT session per speaker per call: opened on `call.started`, fed `audio.frame` by speaker, flushed and closed on `call.ended`; transcripts are published to the bus |
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
just after hangup. It stops decaying and heartbeating, gets one final LLM look once
the flush is in, and stays in memory (the last 20 ended calls) for the dashboard.

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
  windowSec: number;                      // rolling context window for the LLM (60)
  score: ScoreState;                      // owned by score-engine, stored here
  llm: {
    inFlight: boolean;
    dirty: boolean;                       // new speech since the last request
    seq: number;
    lastRunAt: number;                    // heartbeat clock
    carryContext: string;
    pending?: "rule" | "victim" | "heartbeat" | "final";
  };
}
```

## Trigger policy (call the LLM when)

1. a final segment produces any rule hit,
2. a victim-side compliance or disclosure hit occurs (sent as the stronger `"victim"` trigger),
3. ~15s pass with new speech but no LLM call (heartbeat, `LLM_HEARTBEAT_SEC`; 15 while testing, 30 for the demo),
4. the call ends with speech the LLM hasn't read (`"final"`), after the STT flush.

The heartbeat is what catches a caller who avoids every keyword: with no rule hits,
it is the only thing that sends the conversation to the LLM. The rule triggers let the
LLM read a keyword in context, so a benign mention gets pulled back down.

Debounce ~1.2s. The first trigger starts the timer and later ones join it, so a stream
of hits can't starve the LLM. At most one request is in flight per call; a trigger that
arrives mid-request runs as soon as it settles. Results with a stale `seq` are dropped.
Each request sends the final turns from the last 60s of speech (at most 10) plus the
previous result's `carryContext`.

## Depends on

`../call-ingestion`, `../stt-adapters` (indirectly, via events), `../rules-classifier`,
`../llm-classifier`, `../score-engine` — always through the event bus, never by
importing their internals.

## Done when

Replaying a fixture file (`scripts/replay.ts`) drives the full chain — transcript →
rules → LLM trigger → score → dashboard/store/alerts — end to end with zero vendors
connected.
