# scripts

| Script | Command | What it does |
|---|---|---|
| `fake-webrtc.ts` | `npm run fake-call -- --caller <wav> [--victim <wav>]` | Streams wavs into the call socket as two fake participants |
| `make-fixture-audio.ts` | `npm run make-audio -- <dialogue file>` | Renders a dialogue script into per-speaker 8kHz mu-law wavs using Windows TTS |
| `replay.ts` | `npm run replay -- fixtures/calls/<scenario>.jsonl` | **Not built yet.** Publishes a transcript fixture onto the event bus |
| `lib/audio.ts` | — | Shared WAV parsing and G.711 mu-law conversion |

## fake-webrtc.ts

Opens one WebSocket per participant and speaks the same protocol the browser page does,
so everything from the socket inward is the real path — including the attribution gate.
The fastest way to exercise the whole chain without two people and two microphones.

```bash
npm run dev                                    # terminal 1
npm run fake-call -- --room test --secret <WEBRTC_ROOM_SECRET>   --caller fixtures/audio/gift-card-medicare-scam-caller.wav   --victim fixtures/audio/gift-card-medicare-scam-victim.wav
```

Options: `--url`, `--room`, `--secret`, `--encoding pcm16|mulaw`, `--sample-rate`,
`--speed`. The fixtures are 8kHz mu-law and are decoded and resampled to whatever the
server is configured to expect.

Real-time pacing is the default and usually what you want: Deepgram's endpointing is
wall-clock based, so streaming faster moves where segments break.

**Not covered:** `getUserMedia`, the AudioWorklet, and the peer connection — those need
real browsers.

To see the gate engage, give both roles overlapping audio. Complementary tracks (one
silent while the other talks) never trigger it, which is correct.

## make-fixture-audio.ts

See [`../fixtures/dialogues/README.md`](../fixtures/dialogues/README.md) for the
dialogue format. Windows-only (uses `System.Speech`); the generated wavs are committed
so teammates on other platforms don't need it.

## replay.ts

Still to be written (Workstream B). It consumes the `TranscriptEvent` JSONL format in
[`../fixtures/calls/README.md`](../fixtures/calls/README.md) and publishes onto
`apps/server/src/event-bus` exactly as `stt-adapters` does, which is the backbone of
integration milestone 1 ("fixture replay → rules → score → dashboard, no vendors").

Note the difference: `replay.ts` starts from *text* and needs no vendor, while
`fake-webrtc.ts` will start from *audio* and exercise the real STT adapter.
