# fixtures/calls

10-15 scripted calls (scam and legitimate), each a `.jsonl` file: one `TranscriptEvent`
per line (see [`docs/module-contracts.md`](../../docs/module-contracts.md) §3.2 for
the exact shape), in chronological order, including partials before their final.

## Used by

`scripts/replay.ts`, which publishes each line onto the event bus in real time (or
faster) — the orchestrator, rules classifier, score engine, and event store can all be
built and tested against this without any vendor connected. The LLM classifier and
dashboard also use these as evaluation/demo data.

## Naming

`<scenario>.jsonl`, e.g. `gift-card-medicare-scam.jsonl`, `legit-family-checkin.jsonl`.
Cover: a range of scam types (impersonation, remote access, romance/urgency), at least
a few clearly legitimate calls (to check for false positives), and a couple of
edge cases (ambiguous, borderline score).

## Format reminder

- `segmentId` ties partials to the final that replaces them.
- `startMs`/`endMs` are relative to call start, not wall-clock time.
- Include realistic transcription noise (e.g. "gift cart" instead of "gift card") —
  the rules classifier is expected to handle it.
