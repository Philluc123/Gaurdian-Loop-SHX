# stt-adapters

**Workstream:** A. Audio
**Contract:** [`docs/module-contracts.md`](../../../../docs/module-contracts.md) §3.2
**Status:** Deepgram, built and verified. It is the only vendor.

## Owns

The vendor connection, reconnection, and translating vendor responses into the common
`TranscriptEvent` format. The vendor sits behind the `SttAdapter` interface, so nothing
outside this folder knows it's Deepgram.

## Interface every adapter implements

```ts
interface SttAdapter {
  name: "deepgram";
  openSession(callId: CallId, speaker: Speaker,
              onTranscript: (e: TranscriptEvent) => void): SttSession;
}

interface SttSession {
  sendAudio(frame: AudioFrame): void;
  close(): Promise<void>;
}
```

## Input / output

Input: `audio.frame` events. The orchestrator opens one session per speaker per call
and routes frames by `speaker` (`../orchestrator/stt-sessions.ts`).
Output: `TranscriptEvent` — partials share a `segmentId` until the final
(`isFinal: true`) replaces them.

## Layout

```
stt-adapters/
  index.ts          createSttAdapter(cfg) — the adapter the service runs with
  deepgram/
    index.ts        the WebSocket: params, buffering, keepalive, reconnect, flush
    segments.ts     Deepgram messages -> TranscriptEvents; pure, unit-tested
```

## How Deepgram is configured

`model=nova-3`, with `encoding` and `sample_rate` taken from the incoming
`AudioFrame` — `linear16`/16000 for browser capture by default, or `mulaw`/8000 when
the telephony format is being tested. Audio is forwarded byte-for-byte either way, so
there is no transcoding step and nothing to go wrong in one.

`interim_results=true`, `endpointing=300`, `utterance_end_ms=1000`, `vad_events=true`,
`smart_format=true`, `punctuate=true`.

## Segment assembly (the part worth understanding)

Deepgram's own docs say `speech_final` must not be used alone to capture full
transcripts: one spoken sentence usually arrives as several `is_final` results, and
with noisy audio `speech_final` can fail to arrive at all. So `segments.ts`:

1. emits **partials** as interim text arrives (whole utterance so far, not a delta,
   because `TranscriptEvent.text` is defined as the full segment text),
2. **buffers** each `is_final` chunk,
3. **commits one final** on `speech_final` — or on `UtteranceEnd`, the backstop that
   prevents a segment being stranded uncommitted.

`utterance_end_ms` requires `interim_results=true`, and values under 1000 buy nothing
because Deepgram sends interim results about once a second.

## Resilience

- **Lazy connect:** the socket opens on the first frame, so the encoding comes from
  the audio rather than being guessed, and a silent speaker costs nothing.
- **Reconnect:** exponential backoff (250ms → 4s), with audio buffered meanwhile
  (capped at ~10s, oldest dropped) so words aren't lost to a blip.
- **Timestamps across reconnects:** Deepgram's clock restarts at 0 on each new
  socket, so the session tracks total audio sent and offsets every timestamp by it.
  `startMs`/`endMs` stay call-relative and monotonic.
- **Keepalive:** a `KeepAlive` every 5s, inside Deepgram's ~10s idle timeout.
- **Flush on hangup:** `close()` sends `CloseStream` and waits up to 2s, so the last
  words before a hangup still arrive as finals.

## Note for downstream workstreams

`smart_format=true` rewrites spoken numbers: "four hundred dollars" becomes "$400",
"one hundred" becomes "$100". Rules that match on payment amounts need to expect the
formatted form. Turn it off in `buildQuery` if that's a problem.

## Done when

The adapter turns a recorded call (`fixtures/audio/*.wav`) into a clean sequence of
partials followed by one final per segment, and survives a dropped connection by
reconnecting without dropping in-flight audio.

**Deepgram: done** — verified end to end against generated fixture audio at
mu-law 8kHz. Re-verify once browser capture lands, since the format changes.
