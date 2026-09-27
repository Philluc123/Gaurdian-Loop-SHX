# apps/dashboard/src

React app source. See [`../README.md`](../README.md) for the WebSocket contract this UI
renders and how to run it against the mock server.

```
src/
  main.tsx              Vite entrypoint
  App.tsx               top bar, routing, connection status
  router.tsx            /, /call/:callId (the notification link), /history[/:callId]
  ws-client.ts          reconnecting /ws/dashboard client; re-subscribes on every open
                          so the server re-sends `snapshot`
  state.ts              pure reducer: ServerMsg -> view model (tested in state.test.ts)
  api.ts                GET /api/calls, GET /api/calls/:callId
  format.ts             display labels for signals, levels, speakers, times
  components/
    LiveCall.tsx        live page layout; holds local alert-ack state
    Transcript.tsx      turns + live partials, highlighting from `highlights` messages
    ScoreGauge.tsx      renders `score` messages: figure, level, meter, score-over-time
    AlertBanner.tsx     renders `alert` messages + notification delivery, sends `ack_alert`
    CallHistory.tsx     call list + one call's stored record
```

Keep this app free of scoring/classification logic — it only renders what the server
sends. `state.ts` merges partials into finals and remembers score history for the
chart; it never derives a score, level, or signal.
