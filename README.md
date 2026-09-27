# Guardian Loop

ShellHacks project. Guardian Loop listens to a phone call in real time, scores it for
scam-call risk (impersonation, urgency, gift-card/wire payment requests, secrecy
coaching, etc.), and alerts a designated guardian with a notification linking to a live
dashboard of the call.

Full input/output contracts for every module live in
[`docs/module-contracts.md`](docs/module-contracts.md) — **read that before writing
any code that crosses a module boundary.** This README is the map; that doc is the law.

## How it fits together

One Node service, one in-process event bus (a typed wrapper around `EventEmitter`).
Modules publish and subscribe to events; the orchestrator is the only module that
holds per-call state, everything else is a pure/stateless function. Full diagram in
`docs/module-contracts.md` section 1.

```
Call ingestion → STT adapter → Orchestrator → Rules classifier ┐
                                    │          LLM classifier   ├→ Score engine → Dashboard
                                    │                                            → Alerts (notifications)
                                    └──────────────────────────────────────────→ Event store (Mongo)
```

## Repo layout

```
apps/server/        the one Node service — see apps/server/README.md
  src/<module>/      one folder per module in docs/module-contracts.md section 3
apps/dashboard/      React + WebSocket guardian dashboard (owns UI only, no scoring)
packages/shared-types/  the contracts everyone imports from — never redefine locally
fixtures/            scripted calls + audio so you can build without any vendor
mocks/               fake LLM + fake dashboard WebSocket server for local dev
scripts/             replay.ts — plays a fixture onto the event bus in real time
docs/                module-contracts.md (source of truth) and ADRs
```

Every folder above has its own README with that piece's ownership, contract, and
"done when" criteria. Start there before writing code in it.

## Getting started

```bash
npm install
cp .env.example .env        # in the repo root; fill in only the keys your module needs
npm run typecheck --workspaces
npm test
```

### See a call get transcribed, with no second person

Only `DEEPGRAM_API_KEY` and `WEBRTC_ROOM_SECRET` are needed for this:

```bash
npm run dev                                    # terminal 1
npm run fake-call -- --room test --secret <WEBRTC_ROOM_SECRET>   --caller fixtures/audio/gift-card-medicare-scam-caller.wav   --victim fixtures/audio/gift-card-medicare-scam-victim.wav
```

`scripts/fake-webrtc.ts` speaks the same protocol the browser does, so everything from
the WebSocket inward is the real path. `LOG_PARTIALS=1` also shows partials.

For a live two-person call, follow [`docs/calling-setup.md`](docs/calling-setup.md) —
tunnel, links, earbuds, and tuning the speaker-attribution gate.

To build against a module you don't own yet, don't wait for it — replay a fixture:

```bash
npm run replay -- fixtures/calls/<some-call>.jsonl    # not built yet (Workstream B)
```

See [`fixtures/README.md`](fixtures/README.md) and [`mocks/README.md`](mocks/README.md).

## Workstreams (see `docs/module-contracts.md` section 6)

| Workstream | Modules | Folder(s) |
|---|---|---|
| A. Audio | Call ingestion (WebRTC), STT adapters | `apps/server/src/call-ingestion` (**built**), `apps/server/src/stt-adapters` (**Deepgram built**) |
| B. Core | Orchestrator, rules classifier, score engine | `apps/server/src/orchestrator`, `apps/server/src/rules-classifier`, `apps/server/src/score-engine` |
| C. AI | LLM classifier (prompt, schema, eval) | `apps/server/src/llm-classifier` |
| D. Frontend | Guardian dashboard | `apps/dashboard` |
| E. Plumbing | Guardian notification, event store | `apps/server/src/alerts`, `apps/server/src/event-store` |

## Integration milestones

1. Fixture replay → rules → score → dashboard (no vendors).
2. Swap replay for live STT on recorded audio.
3. Swap recorded audio for a live WebRTC call.
4. Replace the mock LLM with Gemini.
5. Turn on guardian notifications and MongoDB writes.

Each milestone swaps exactly one mock for the real thing — when something breaks you
know which module caused it.

## Working concurrently

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for branching, PRs, and — most importantly —
the process for changing a shared contract without breaking four other people's work.
