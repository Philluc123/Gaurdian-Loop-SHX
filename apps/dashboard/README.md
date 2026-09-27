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
npm run mock:dashboard -- --speed 2                  # terminal 1: mock backend on :3000
npm run dev --workspace=@guardian-loop/dashboard     # terminal 2: http://localhost:5173
```

The mock ([`../../mocks/dashboard-ws.ts`](../../mocks/dashboard-ws.ts)) replays
`fixtures/calls/*.jsonl` through the real rules classifier and score engine and serves
the same WebSocket + REST contract as the real server, so the whole UI can be built
and demoed before the backend exists. The Vite dev server proxies `/ws/dashboard` and
`/api` to `BACKEND_URL` (default `http://localhost:3000`), so switching to the real
server is just starting it on that port instead.

| Page | What it shows |
|---|---|
| `/` | Follows the latest call; switches automatically when a new one starts |
| `/call/:callId` | One call — the live-view link in the guardian's notification |
| `/history`, `/history/:callId` | Past calls and one call's stored record |

Overrides: `VITE_DASHBOARD_WS_URL` (full ws URL) and `VITE_API_BASE` skip the proxy.

## Done when

The dashboard renders correctly end-to-end (transcript, live highlighting, score
gauge, alert banner, call history) driven entirely by the mock WebSocket server, with
no real backend running.
