# stt-adapters

**Workstream:** A. Audio
**Contract:** [`docs/module-contracts.md`](../../../../docs/module-contracts.md) §3.2

## Owns

Vendor connections, reconnection, and translating vendor responses into one common
`TranscriptEvent` format. Each vendor lives behind the same `SttAdapter` interface so
switching vendors is a config change (`STT_PROVIDER` in `.env`), not a code change.

## Interface every adapter implements

```ts
interface SttAdapter {
  name: "elevenlabs" | "deepgram" | "azure";
  openSession(callId: CallId, speaker: Speaker,
              onTranscript: (e: TranscriptEvent) => void): SttSession;
}

interface SttSession {
  sendAudio(frame: AudioFrame): void;
  close(): Promise<void>;
}
```

## Input / output

Input: `audio.frame` events (the orchestrator opens two sessions per call, one per
speaker, and routes frames by `speaker`). Output: `TranscriptEvent` — partials share a
`segmentId` until the final (`isFinal: true`) replaces them.

## Layout

One subfolder per vendor under test — `elevenlabs/`, `deepgram/`, `azure/` — each
implementing `SttAdapter`. Don't let vendor-specific quirks leak outside that vendor's
folder; normalize to `TranscriptEvent` before it leaves the adapter.

## Done when

Each adapter turns a recorded call (`fixtures/audio/*.wav`) into a clean sequence of
partials followed by one final per segment, and survives a dropped connection by
reconnecting without dropping in-flight audio.
