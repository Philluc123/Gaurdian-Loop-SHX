# fixtures/audio

Recorded μ-law (or pcm16) `.wav` audio, one file per speaker per call, used to
build and test the STT adapters (`apps/server/src/stt-adapters`) against real audio
without a live WebRTC call.

## Naming

`<scenario>-caller.wav`, `<scenario>-victim.wav` — matching the scenario names used in
[`../calls/`](../calls/README.md) where possible, so a recorded call and its
transcript fixture can be cross-checked.

## Format

Match what call ingestion actually emits (see
`AudioFrame.encoding`/`sampleRate` in
[`docs/module-contracts.md`](../../docs/module-contracts.md) §3.1-3.2). If you record
at 16kHz pcm16 for clarity, note it in the filename or a sidecar `.json` so adapters
don't assume the wrong format.
