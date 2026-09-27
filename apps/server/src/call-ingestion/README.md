# call-ingestion

**Workstream:** A. Audio
**Contract:** [`docs/module-contracts.md`](../../../../docs/module-contracts.md) §3.1
**Status:** built and verified end to end. Twilio was removed from the project; browser
WebRTC is the only ingestion path.

## Owns

The WebRTC signalling server, the browser call page, the audio fork that carries each
participant's own microphone to the server, and the speaker-attribution gate.

## Output events

`call.started`, `audio.frame` (per speaker, ~20ms frames), `call.ended` — imported from
`@guardian-loop/shared-types`, never redeclared here. Everything downstream (STT
adapters, transcript log, and later the orchestrator) is transport-agnostic and needs
no changes.

## Shape of a call

```
Caller browser ←═══ RTCPeerConnection (Opus, P2P) ═══→ Victim browser
   │  earbuds                                            earbuds  │
   │  WS /webrtc/signal   SDP offer/answer + ICE                  │
   │  WS /webrtc/media    fork of its OWN mic                     │
   └──────────────────► this module ◄─────────────────────────────┘
                              │
                    call.started · audio.frame ×2 · call.ended
```

Two transports on purpose. `RTCPeerConnection` carries the conversation so the two
people can hear each other; the WebSocket fork is what lets the server analyse it.
P2P alone would never reach us, and a server-relayed call would sound worse.

Each browser forks **its own microphone only**, never the remote track, so the speaker
label comes from the role in the join message rather than being inferred.

## Layout

```
call-ingestion/
  webrtc/
    index.ts      the WebSocket: join, signalling relay, audio -> the three events
    protocol.ts   wire format shared with the browser page and the test harness
    rooms.ts      room registry and call lifecycle; pure, unit-tested
    gate.ts       the attribution gate; levels in -> decisions out, unit-tested
    levels.ts     frame RMS in dBFS, and per-format silence
    public/       index.html, call.js, capture-worklet.js
```

**One socket per participant**, carrying JSON control frames and binary audio frames
together. Two endpoints would mean reconciling two lifecycles per person for no gain —
this way a socket closing is unambiguously "that person left".

A call starts on the **first audio frame**, not on joining, so a page left sitting on
the join screen never creates an empty call. It ends when either participant
disconnects, which matches a two-party phone call and makes a page refresh end the call
predictably.

## Same-room audio: the hard part

Both participants sit in one room for the demo, so **each microphone hears both
people**. That breaks speaker attribution unless it's handled in layers:

1. **Close-talking earbud mics**, one pair per person. An earbud mic ~10cm from the
   mouth versus the other person ~1m away gives roughly 16–20dB of separation for
   free. This is the single biggest factor and it is hardware, not code. Earbuds also
   remove the speaker-to-mic path entirely, which is what every echo-cancellation
   guide recommends first.
2. **Capture constraints:** `echoCancellation: true`, `noiseSuppression: true`, and
   `autoGainControl: false`. AGC is actively harmful here — it raises gain during your
   silence, amplifying the other person and the room, and destabilising the levels the
   gate depends on.
3. **A gating automixer, server-side** (`gate.ts`), modelled on professional AV
   practice: compare both tracks' RMS per 20ms frame and silence the quieter one while
   the other is clearly dominant, with a ~300ms hangover so words aren't clipped and a
   noise floor so nothing gates when both are silent.

The gate is config-flagged (`WEBRTC_GATE`) because it has a real failure mode:
genuine simultaneous speech gets suppressed. The fallback is to disable it and dedupe
at the transcript level instead — no audio lost, but double the Deepgram usage.

Tune the thresholds **in the actual demo room**. The right values depend on its noise
floor, and ten minutes on site beats any amount of guessing.

## Secure context

`getUserMedia` requires a secure context. `localhost` qualifies, but a second laptop or
a phone reaching this over plain http on the LAN will have its microphone blocked —
set `PUBLIC_BASE_URL` to an https tunnel origin and load the page from there. Doing so
also means the page works on real phones.

The tunnel URL is public, so joining a room requires `WEBRTC_ROOM_SECRET`.

## Testing without two people

```bash
npm run dev
npm run fake-call -- --room test --secret <WEBRTC_ROOM_SECRET>   --caller fixtures/audio/<scenario>-caller.wav   --victim fixtures/audio/<scenario>-victim.wav
```

`scripts/fake-webrtc.ts` opens one socket per participant and speaks the same protocol
the browser does, so everything from the WebSocket inward is the real path — gate
included. It skips only `getUserMedia`, the AudioWorklet and the peer connection.

## Done when

Two browsers produce `call.started`, a steady stream of `audio.frame` for both
speakers, and `call.ended`; and a conversation held in one room yields transcripts
where each turn is attributed to the right speaker.

**Verified:** a fixture call produces one shared `callId`, both speakers transcribed
correctly, and `call.ended` on hangup. The gate was checked against simulated bleed —
feeding the victim's track nothing but the caller's voice at -18dB produced **zero**
victim transcript lines, while the caller was never suppressed.
