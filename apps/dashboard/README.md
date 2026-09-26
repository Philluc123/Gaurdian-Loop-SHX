# apps/dashboard

**Workstream:** D. Frontend
**Contract:** [`docs/module-contracts.md`](../../docs/module-contracts.md) §3.8

## Owns

The guardian-facing UI only. **This app never computes a score or a signal** — it
renders exactly what the server sends over WebSocket, nothing more.

## Connection

`wss://<host>/ws/dashboard` (path from `DASHBOARD_WS_PATH` in `.env`).

Client → server messages: `subscribe`, `ack_alert`, `join_call` (stretch).
Server → client messages: `snapshot`, `transcript`, `highlights`, `score`, `alert`,
`call_ended`. Full shapes are in the contract doc — import types from
`@guardian-loop/shared-types` rather than redeclaring the message unions here.

Always send `snapshot` handling on connect/reconnect — a page refresh must recover
the full call state, not just wait for the next incremental update.

## REST (call history)

`GET /api/calls` (list), `GET /api/calls/:callId` (full record) — served by
`apps/server`'s `event-store` module.

## Running locally without a backend

```bash
npm run dev --workspace=@guardian-loop/dashboard
```

Point the WebSocket client at `mocks/dashboard-ws.ts` instead of the real server (see
[`../../mocks/README.md`](../../mocks/README.md)) — it streams `ServerMsg`s from a
fixture file, so you can build and demo the whole UI before the backend exists.

## Done when

The dashboard renders correctly end-to-end (transcript, live highlighting, score
gauge, alert banner, call history) driven entirely by the mock WebSocket server, with
no real backend running.
