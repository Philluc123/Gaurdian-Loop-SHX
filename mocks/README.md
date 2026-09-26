# mocks

**Contract:** [`docs/module-contracts.md`](../docs/module-contracts.md) §5

Fakes that let you build a module without its real upstream/downstream dependency
running.

| File | What it is | Who uses it |
|---|---|---|
| `dashboard-ws.ts` | Tiny WebSocket server that streams `ServerMsg`s from a fixture call | Dashboard (Workstream D) |
| `llm.ts` | Fake `classify()` returning canned `LLMResult`s after an ~800ms delay | Orchestrator, score engine (Workstream B) |

## Rules for mocks

- A mock must speak the exact same contract as the real thing (same event/message
  shapes from `@guardian-loop/shared-types`) — the whole point is that swapping a mock
  for the real implementation later is a config change, not a code change.
- Keep mocks deterministic where possible (canned responses, fixed delay) so tests
  relying on them are reproducible.
- When the real implementation lands, don't delete the mock — it's still useful for
  fast local dev and CI, per the integration milestones in the root README.
