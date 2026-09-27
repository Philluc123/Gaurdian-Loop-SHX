# fixtures

**Owner:** shared — everyone contributes fixtures, everyone depends on them.
**Contract:** [`docs/module-contracts.md`](../docs/module-contracts.md) §5

The thing that lets all five workstreams start on day one without a live call,
an STT vendor key, or a Gemini key: scripted calls that stand in for a real one.

## Contents

- [`calls/`](calls/README.md) — scripted calls as timed `TranscriptEvent` JSONL files.
- [`audio/`](audio/README.md) — recorded μ-law audio per speaker, for STT adapter work.

## Write fixtures first

Write 10-15 scripted calls (mix of scam and legitimate) on day one. They aren't just
test data — they double as the acceptance tests for the rules classifier and the LLM
prompt, and as the source material `scripts/replay.ts` uses to drive the whole
pipeline before any vendor is connected.
