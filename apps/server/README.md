# apps/server

The one Node service Guardian Loop runs as. Every module below is a folder under
`src/`, communicating only through the in-process event bus described in
[`docs/module-contracts.md`](../../docs/module-contracts.md) section 1.

`src/index.ts` is the composition root — it wires modules together and starts the
HTTP/WebSocket listeners. It should stay thin; module logic belongs in the module's
own folder, not here.

## Module folders

| Folder | Workstream | Contract |
|---|---|---|
| [`src/event-bus/`](src/event-bus/README.md) | shared infra | §1 |
| [`src/call-ingestion/`](src/call-ingestion/README.md) | A. Audio | §3.1 |
| [`src/stt-adapters/`](src/stt-adapters/README.md) | A. Audio | §3.2 |
| [`src/orchestrator/`](src/orchestrator/README.md) | B. Core | §3.3 |
| [`src/rules-classifier/`](src/rules-classifier/README.md) | B. Core | §3.4 |
| [`src/llm-classifier/`](src/llm-classifier/README.md) | C. AI | §3.5 |
| [`src/score-engine/`](src/score-engine/README.md) | B. Core | §3.6 |
| [`src/alerts/`](src/alerts/README.md) | E. Plumbing | §3.7 |
| [`src/event-store/`](src/event-store/README.md) | E. Plumbing | §3.9 |

(§ numbers refer to sections in `docs/module-contracts.md`.)

## Running locally

```bash
npm install
cp ../../.env.example ../../.env   # fill in only what your module needs
npm run dev --workspace=@guardian-loop/server
```

You do not need real vendor credentials to build most modules — replay a fixture
instead (see [`../../fixtures/README.md`](../../fixtures/README.md) and
[`../../mocks/README.md`](../../mocks/README.md)).

## Rules for this app

- Only `src/orchestrator/` holds per-call state. Every other module is a pure
  function or a stateless async function — this is what makes them independently
  testable and safe to build in parallel.
- Modules never import each other's internals directly. They communicate through
  events on the shared bus, typed via `@guardian-loop/shared-types`.
- If two modules need to agree on a shape that isn't in
  `@guardian-loop/shared-types` yet, add it there first (see root `CONTRIBUTING.md`).
