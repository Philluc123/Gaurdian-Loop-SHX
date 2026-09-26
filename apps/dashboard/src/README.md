# apps/dashboard/src

React app source (not yet scaffolded — first PR here should add the Vite + React
entrypoint). See [`../README.md`](../README.md) for the WebSocket contract this UI
renders and the mock server to build against.

Suggested shape once started:

```
src/
  main.tsx           Vite entrypoint
  ws-client.ts        connects to /ws/dashboard (or mocks/dashboard-ws.ts), typed via
                       @guardian-loop/shared-types
  components/
    Transcript.tsx     renders turns + live highlighting from `highlights` messages
    ScoreGauge.tsx      renders `score` messages
    AlertBanner.tsx     renders `alert` messages, calls `ack_alert`
    CallHistory.tsx     GET /api/calls, GET /api/calls/:callId
```

Keep this app free of scoring/classification logic — it only renders what the server
sends.
