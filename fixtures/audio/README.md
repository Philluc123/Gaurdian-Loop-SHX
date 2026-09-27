# fixtures/audio

Recorded μ-law (or pcm16) `.wav` audio, one file per speaker per call, used to
build and test the STT adapters (`apps/server/src/stt-adapters`) against real audio
without a live WebRTC call.

## Naming

`<scenario>-caller.wav`, `<scenario>-victim.wav` — matching the scenario names used in
[`../calls/`](../calls/README.md) where possible, so a recorded call and its
transcript fixture can be cross-checked.

## Generating these files

The committed wavs are generated from the scripts in
[`../dialogues/`](../dialogues/README.md), not recorded:

```bash
npm run make-audio -- fixtures/dialogues/gift-card-medicare-scam.txt
```

That writes `<scenario>-caller.wav`, `<scenario>-victim.wav` and
`<scenario>.expected.txt` (the ground-truth transcript, for judging STT accuracy).
The wavs are committed so teammates who aren't on Windows can still use them
without regenerating.

Synthetic TTS audio transcribes more cleanly than real speech. It proves the pipeline
works; it does not prove the rules classifier survives real transcription noise. Keep
at least one genuinely recorded call for that.

## Format

8kHz mulaw is the telephony format, and what these fixtures are rendered to (see
`AudioFrame.encoding`/`sampleRate` in
[`docs/module-contracts.md`](../../docs/module-contracts.md) §3.1-3.2). If you record
at 16kHz pcm16 for clarity, note it in the filename or a sidecar `.json` so adapters
don't assume the wrong format.
