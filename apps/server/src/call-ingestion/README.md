# call-ingestion

**Workstream:** A. Audio
**Contract:** [`docs/module-contracts.md`](../../../../docs/module-contracts.md) §3.1

## Owns

WebRTC signaling, peer connection setup, and capturing each participant's audio track.

## Input

WebRTC audio tracks for the caller and the victim.

## Output events

`call.started`, `audio.frame` (per speaker, ~20ms mulaw/pcm16 frames), `call.ended`.
Exact shapes are in the contract doc — import the types from
`@guardian-loop/shared-types`, don't redeclare them here.

## Suggested layout

```
call-ingestion/
  webrtc/       signaling + peer connection + per-track audio capture
  index.ts      publishes CallStarted / AudioFrame / CallEnded onto the event bus
```

## Building without a live call

Use `fixtures/audio/*.wav` and `scripts/replay.ts` — see
[`../../../../fixtures/README.md`](../../../../fixtures/README.md). You don't need a
live WebRTC session to build and test the orchestrator/rules/score chain; you need one
only to validate this module's own signaling + audio capture against a real call.

## Done when

A test call produces `call.started`, a steady stream of `audio.frame` for both
speakers (confirm which track is the caller vs. victim), and `call.ended`.
