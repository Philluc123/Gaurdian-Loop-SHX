# call-ingestion

**Workstream:** A. Audio
**Contract:** [`docs/module-contracts.md`](../../../../docs/module-contracts.md) §3.1

## Owns

The Twilio webhook (TwiML), the Media Streams WebSocket, and the WebRTC fallback page.

## Input

Twilio webhooks and Media Streams messages, or browser microphone audio for the
WebRTC fallback.

## Output events

`call.started`, `audio.frame` (per speaker, ~20ms mulaw/pcm16 frames), `call.ended`.
Exact shapes are in the contract doc — import the types from
`@guardian-loop/shared-types`, don't redeclare them here.

## Suggested layout

```
call-ingestion/
  twilio/       webhook handler + Media Streams WS
  webrtc/       browser fallback signaling + audio capture
  index.ts      publishes CallStarted / AudioFrame / CallEnded onto the event bus
```

## Building without a live Twilio number

Use `fixtures/audio/*.wav` and `scripts/replay.ts` — see
[`../../../../fixtures/README.md`](../../../../fixtures/README.md). You don't need a
Twilio account to build and test the orchestrator/rules/score chain; you need one
only to validate this module's own webhook + Media Streams wiring against a real call.

## Done when

A test call produces `call.started`, a steady stream of `audio.frame` for both
speakers (confirm which Twilio track is the caller vs. victim), and `call.ended`. The
WebRTC fallback emits the exact same three event types.
