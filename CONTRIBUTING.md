# Contributing / working concurrently

Guardian Loop is built by five workstreams in parallel (see root `README.md`). This
only works if modules talk to each other **only** through the events and function
signatures in [`docs/module-contracts.md`](docs/module-contracts.md).

## The one rule

If you need a new field, a new event, or a changed signature: add it to
`docs/module-contracts.md` and `packages/shared-types` **first**, in its own small PR,
and say so in the team channel before you build on it. Never redefine a shared type
locally in your module "just for now" — it will silently drift.

## Branching and PRs

- Branch names: `<workstream-letter>/<short-description>`, e.g. `b/score-engine-decay`,
  `d/dashboard-highlighting`.
- Keep PRs scoped to one module/folder where possible — it makes review fast and
  keeps CI failures attributable.
- PR into `main`. CI (typecheck, lint, test per workspace) must pass before merge.
- If your PR changes a file under `packages/shared-types/` or
  `docs/module-contracts.md`, flag it clearly in the PR title/description — those
  changes affect everyone and deserve a quick look from more than one person.

## Building without waiting on someone else

Every module has fixtures and mocks so you never block on a teammate or a vendor:

- No Twilio account yet? Use `fixtures/calls/*.jsonl` + `scripts/replay.ts`.
- No LLM key yet? Use `mocks/llm.ts`.
- No backend running yet? Point the dashboard at `mocks/dashboard-ws.ts`.

Write your fixture calls on day one — they double as your test cases.

## Definition of done for a module

Each module README states its own "done when" criteria (pulled from
`docs/module-contracts.md`). A module is mergeable when it meets that bar against the
fixtures, independent of whether any other module is finished.

## Integration order

Don't try to wire the real Twilio call, real STT, real Gemini, real Mongo, and real
SMS together on day one. Follow the integration milestones in the root README —
swap one mock for the real thing at a time.
