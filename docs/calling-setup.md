# Setting up calls + transcription

How to get a live two-person call transcribed, from nothing to a working call.
Covers Workstream A (`call-ingestion` + `stt-adapters`).

Contracts: [`module-contracts.md`](module-contracts.md) §3.1 and §3.2.

---

## What you need

**A Deepgram API key** — [console.deepgram.com](https://console.deepgram.com), Member
role. New accounts include free credit. This is the only paid-ish account in the stack.

**An https tunnel**, for any device that isn't your own laptop:

```powershell
winget install Cloudflare.cloudflared
cloudflared tunnel --url http://localhost:3000
```

`getUserMedia` only works in a secure context. `localhost` counts; a LAN address like
`http://192.168.1.20:3000` does not, and the microphone is silently blocked. No account
is needed, and the random URL is fine since nothing external calls back into us.

**Two pairs of wired earbuds with inline mics.** Not optional — see below.

---

## Why earbuds decide whether this works

Both people sit in one room, so **each microphone hears both voices**. Untreated, every
sentence lands in both transcripts and speaker attribution is meaningless.

Earbuds fix most of it in two ways:

- **No speaker-to-mic path.** Nothing plays out loud, so the other person's voice can't
  loop into your mic. Removing the acoustic path is the first recommendation in every
  echo-cancellation guide, and it's more reliable than any amount of processing.
- **Close-talking mic.** An earbud mic ~10cm from your mouth versus the other person
  ~1m away gives roughly 16–20dB of separation, for free. This is exactly why phone
  handsets work.

Wired, not Bluetooth: less latency and no pairing surprises mid-demo.

The software then handles the remainder in two layers — capture constraints
(`echoCancellation` and `noiseSuppression` on, `autoGainControl` deliberately **off**,
since AGC amplifies the other person during your silence) and a server-side gating
automixer that silences the clearly-quieter track. Details in
[`apps/server/src/call-ingestion/README.md`](../apps/server/src/call-ingestion/README.md).

---

## Configure

Copy `.env.example` to `.env` **in the repo root** and fill in:

```
PUBLIC_BASE_URL=https://<your-tunnel-host>      # no trailing slash
WEBRTC_ROOM_SECRET=<any random string>
DEEPGRAM_API_KEY=<your key>
STT_PROVIDER=deepgram
```

Put comments on their own lines, not after a value.

---

## Test without a second person first

This catches almost everything and needs no tunnel and no earbuds:

```powershell
npm install
npm run dev                                     # terminal 1
npm run fake-call -- --room test --secret <WEBRTC_ROOM_SECRET> `
  --caller fixtures/audio/gift-card-medicare-scam-caller.wav `
  --victim fixtures/audio/gift-card-medicare-scam-victim.wav
```

`scripts/fake-webrtc.ts` opens one socket per participant and speaks the same protocol
the browser does, so everything from the WebSocket inward is the real path — including
the attribution gate. Expect:

```
[webrtc] caller joined room "test" as call 1c42866e-…
[webrtc] call started 1c42866e-…
[FINAL] caller @   0.0s  Hello. Am I speaking with the account holder?
[FINAL] victim @   6.0s  Yes.
```

`LOG_PARTIALS=1 npm run dev` also shows partial transcripts as they stream.

---

## The live call

1. `npm run dev`, and `cloudflared tunnel --url http://localhost:3000` in another
   terminal.
2. Put the tunnel's https URL in `PUBLIC_BASE_URL` and restart the server — it prints a
   ready-made link per role, with the room secret already filled in.
3. Open the **caller** link on one device and the **victim** link on the other.
4. Both people put their earbuds in and allow microphone access when prompted.
5. Talk. The page shows connection state, a mic level meter, and whether your track is
   currently gated.
6. Hang up. The transcript is in `logs/calls/<callId>.txt`.

The caller always creates the WebRTC offer, so the two sides never collide. Because both
devices are on the same network, ICE resolves on local candidates almost immediately —
STUN is configured as a fallback and TURN isn't needed.

---

## Tuning the gate, in the room you'll demo in

The thresholds depend on that room's noise floor, so budget ten minutes on site. Watch
the "Your audio" line on each page while one person talks:

- **The silent person's page never says "gated"** → bleed isn't being caught. Lower
  `WEBRTC_GATE_DOMINANCE_DB` (try 6).
- **A speaker gets gated mid-sentence** → too aggressive. Raise it (try 12), or raise
  `WEBRTC_GATE_HANGOVER_MS`.
- **Room noise alone triggers gating** → raise `WEBRTC_GATE_FLOOR_DBFS` toward -40.
- **Genuine interruptions get swallowed** → that's the gate's real failure mode. Set
  `WEBRTC_GATE=false` and accept some cross-talk instead.

Restart the server after changing these; config is read at boot.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| "getUserMedia needs a secure context" | Page loaded over plain http on a LAN address. Use the tunnel URL |
| Microphone permission denied | Allow it and reload; a denied permission doesn't re-prompt on its own |
| `join rejected (bad_secret)` | The link's `secret` doesn't match `WEBRTC_ROOM_SECRET`. Use the links the server prints |
| `join rejected (room_full)` | Both people opened the same role, or a stale tab still holds it |
| Page says "alone in the room" | The other person hasn't joined, or used a different room name |
| Connection stuck on "connecting" | ICE didn't complete. On one network this is unusual — check the browser console |
| No transcripts, but the call works | Missing or invalid `DEEPGRAM_API_KEY`; the Deepgram socket logs its close code |
| Both transcripts contain both voices | Gate off, thresholds too loose, or someone isn't wearing earbuds |
| Call ends when someone refreshes | Expected: a two-party call ends when either side leaves |
| No audio from the other person | Tap the page once — browsers block autoplay until you interact |

---

## What's done and what isn't

**Done:** signalling and P2P audio, the call page, the mic fork, the three §3.1 events,
the attribution gate, Deepgram streaming with partials and finals, reconnect with audio
buffering, flush on hangup, the transcript sink, 51 unit tests, and the offline harness.

**Not done:** the guardian dashboard (Workstream D) and its `/ws/dashboard` feed, so the
guardian can't yet watch a call or receive a notification. Transcripts currently go to
the terminal and `logs/calls/`.

**Known gap:** a room is protected only by `WEBRTC_ROOM_SECRET`, shared in the URL. Fine
for a hackathon; a real deployment wants per-call tokens.
