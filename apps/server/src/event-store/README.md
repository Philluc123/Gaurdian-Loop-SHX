# event-store

**Workstream:** E. Plumbing
**Contract:** [`docs/module-contracts.md`](../../../../docs/module-contracts.md) §3.9

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
