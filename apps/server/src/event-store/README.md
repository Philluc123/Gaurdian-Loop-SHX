# event-store

**Workstream:** E. Plumbing
**Contract:** [`docs/module-contracts.md`](../../../../docs/module-contracts.md) §3.9
**Status:** an **in-memory** version (`memory.ts`) is running and serves both endpoints,
so the dashboard's History tab works with no database. MongoDB is not built.

The in-memory store applies the same storage rules as below and serves the same two
endpoints, so a Mongo version replaces it without the dashboard noticing. Until then,
history lasts as long as the server process — enough for a demo. It keeps the 50 most
recent calls. Empty final `rules.hits` are skipped as well, since they'd be a row per
sentence carrying nothing.

## Owns

Persistence to MongoDB and the queries behind the call-history REST endpoints. Writes
must never block the live pipeline — fire-and-forget or queue, don't await in the hot
path.

## Input

`call.started`, **final** `transcript` events only, `rules.hits` (final only),
`llm.result`, `score.updated`, `alert.triggered`, `alert.sent`, `call.ended`. Never
audio frames, never partial transcripts — the volume isn't worth it and nothing reads
them back.

## Collections

```ts
// calls
{ _id: CallId, source, from, to, guardian, startedAt, endedAt,
  maxScore: number, finalLevel: RiskLevel, alertCount: number }

// events
{ callId: CallId, ts: number, type: string, payload: object }   // index: { callId: 1, ts: 1 }
```

## Serves

`GET /api/calls` (list) and `GET /api/calls/:callId` (full ordered record) — used by
the dashboard's history view.

## Done when

After a replayed call, `GET /api/calls/:callId` returns the complete, correctly
ordered record with no audio frames or partial transcripts in it.
