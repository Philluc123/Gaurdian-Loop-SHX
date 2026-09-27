# fixtures/dialogues

Plain-text two-speaker scripts that [`scripts/make-fixture-audio.ts`](../../scripts/README.md)
renders into the per-speaker mu-law wavs in [`../audio/`](../audio/README.md).

This is how you get test audio without booking a recording session or burning a real
phone call on every experiment.

## Format

```
caller: Your Medicare account has been suspended.
victim: Oh my goodness, I haven't done anything wrong.
pause: 600
caller: Buy four gift cards and read me the numbers.
```

- `caller:` — the scammer's track.
- `victim:` — the person being called.
- `pause: <ms>` — silence on both tracks.
- `#` starts a comment; blank lines are ignored.

Each turn is rendered with a different Windows TTS voice, and the other speaker gets
exactly as much silence, so the two tracks line up like a real call. A 500ms gap is
added after every turn to give Deepgram's endpointing something to detect.

## Usage

```bash
npm run make-audio -- fixtures/dialogues/gift-card-medicare-scam.txt
```

Writes `fixtures/audio/<scenario>-caller.wav`, `-victim.wav`, and
`<scenario>.expected.txt` — the ground-truth transcript, useful for judging STT
accuracy and for writing the matching `fixtures/calls/*.jsonl`.

## Requirements

Windows, using the TTS voices already installed (`System.Speech`). On a machine with
only one voice both speakers sound the same, which is fine — the speaker labels come
from the participant's role, not from the audio. On macOS or Linux, use the committed wavs in
`../audio/` rather than regenerating.

## Writing good scenarios

Cover what the rules classifier and score engine need to be exercised against: a
range of scam types, genuinely legitimate calls to catch false positives, and a couple
of ambiguous ones. Synthetic TTS audio transcribes more cleanly than real speech, so
it proves the pipeline works — it does not prove the rules survive real-world
transcription noise. Keep at least one real recorded call for that.
