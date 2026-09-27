# stt-adapters/deepgram

Implements the `SttAdapter` interface from [`../README.md`](../README.md) for
Deepgram. Normalize Deepgram-specific response shapes into `TranscriptEvent` here —
nothing Deepgram-specific should leak past this folder.

**Status:** built and verified end to end against `fixtures/audio/`.

| File | Responsibility |
|---|---|
| `index.ts` | The socket: query params, lazy connect, buffering, keepalive, reconnect, flush on close |
| `segments.ts` | Deepgram messages → `TranscriptEvent`s. No socket, so it's unit-tested directly |
| `segments.test.ts` | 16 tests driving recorded Deepgram JSON through the assembler |

The split matters: everything subtle about this adapter is *segmentation*, and keeping
it socket-free is what makes it testable without a vendor connection.

See [`../README.md`](../README.md) for the configured parameters, how one final is
assembled per segment (and why `speech_final` alone isn't enough), and the resilience
behaviour.
