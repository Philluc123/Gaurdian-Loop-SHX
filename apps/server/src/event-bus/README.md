# event-bus

**Workstream:** shared infra (typically stood up first by whoever starts on B. Core,
since the orchestrator is its first consumer). **Owner:** shared — treat changes here
like changes to `packages/shared-types`: small PR, flag it, tell the team.

## What this is

A thin, typed wrapper around Node's `EventEmitter`. Every module in `apps/server`
publishes and subscribes to events through this, never by importing another module's
internals directly.

See [`docs/module-contracts.md`](../../../../docs/module-contracts.md) section 1 for
the full event flow diagram.

## Contract

- Every event object has a `type` field (string literal) and a `callId`
  (`@guardian-loop/shared-types`), plus a `ts: number` epoch-ms timestamp.
- Publish with the full typed event object, not positional args, so payload shape is
  self-documenting at the call site.
- Prefer one bus instance per process (not per call) — per-call isolation is the
  orchestrator's job (see `../orchestrator/README.md`), not the bus's.

## Done when

Any module can subscribe to any event type declared in
`@guardian-loop/shared-types`/`docs/module-contracts.md` with full type inference on
the payload, and publishing an unknown event type is a compile error.
