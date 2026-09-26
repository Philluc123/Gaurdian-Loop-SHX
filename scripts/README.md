# scripts

## replay.ts

Publishes a fixture call (`fixtures/calls/*.jsonl`) onto the event bus in real time,
or faster than real time, so downstream modules (orchestrator, rules, score engine,
event store) receive the same sequence of events they'd get from a live call.

```bash
npm run replay -- fixtures/calls/<scenario>.jsonl
```

**Contract:** consumes the `TranscriptEvent` JSONL format described in
[`../fixtures/calls/README.md`](../fixtures/calls/README.md); publishes events onto
`apps/server/src/event-bus` exactly as `stt-adapters` would.

This is the backbone of integration milestone 1 in the root README ("fixture replay →
rules → score → dashboard, no vendors") — keep it working even as other modules churn.
