// Renders a two-speaker dialogue into the per-speaker 8kHz mu-law wav files that
// fixtures/audio expects, using the TTS voices already on Windows. No recording
// session and no vendor account needed.
//
//   npm run make-audio -- fixtures/dialogues/gift-card-medicare-scam.txt
//
// Produces fixtures/audio/<scenario>-caller.wav and -victim.wav, aligned so that
// each speaker is silent while the other talks — which is what a real call's two
// per-speaker tracks look like.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  encodeMulawWav,
  mulawDurationMs,
  mulawSilence,
  parseWav,
  toMulaw8k,
} from "./lib/audio";

type Speaker = "caller" | "victim";

interface Line {
  kind: "speech";
  speaker: Speaker;
  text: string;
}
interface Pause {
  kind: "pause";
  ms: number;
}
type Entry = Line | Pause;

/** Silence inserted after each turn, so endpointing has a gap to detect. */
const TURN_GAP_MS = 500;

/** Voice index per speaker, resolved against whatever is installed. */
const VOICE_INDEX: Record<Speaker, number> = { caller: 0, victim: 1 };

/** Speech rate (-10..10). Slightly slow reads transcribe more cleanly at 8kHz. */
const RATE: Record<Speaker, number> = { caller: 0, victim: -1 };

function parseDialogue(file: string): Entry[] {
  const entries: Entry[] = [];
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);

  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;

    const match = /^(caller|victim|pause)\s*:\s*(.+)$/i.exec(line);
    if (!match) {
      throw new Error(
        `${file}:${index + 1}: expected "caller: text", "victim: text" or "pause: <ms>", got "${line}"`
      );
    }

    const kind = match[1].toLowerCase();
    if (kind === "pause") {
      const ms = Number.parseInt(match[2], 10);
      if (!Number.isFinite(ms)) throw new Error(`${file}:${index + 1}: pause needs a number of ms`);
      entries.push({ kind: "pause", ms });
    } else {
      entries.push({ kind: "speech", speaker: kind as Speaker, text: match[2] });
    }
  }

  if (entries.every((e) => e.kind !== "speech")) throw new Error(`${file} has no spoken lines`);
  return entries;
}

const POWERSHELL_SCRIPT = `param([string]$Manifest)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$items = Get-Content -Raw -Path $Manifest | ConvertFrom-Json
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$voices = @($synth.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { $_.VoiceInfo.Name })
if ($voices.Count -eq 0) { Write-Error 'No TTS voices are installed.'; exit 1 }
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(8000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
foreach ($item in $items) {
  $synth.SelectVoice($voices[[int]$item.voiceIndex % $voices.Count])
  $synth.Rate = [int]$item.rate
  $synth.SetOutputToWaveFile($item.path, $fmt)
  $synth.Speak([string]$item.text)
}
$synth.SetOutputToNull()
$synth.Dispose()
Write-Output ('voices: ' + ($voices -join ' | '))
`;

/** Render every spoken line to its own 8kHz PCM wav in one PowerShell process. */
function renderSpeech(entries: Entry[], tmpDir: string): Map<number, string> {
  const manifest: Array<{ path: string; text: string; voiceIndex: number; rate: number }> = [];
  const byEntry = new Map<number, string>();

  entries.forEach((entry, i) => {
    if (entry.kind !== "speech") return;
    const wavPath = path.join(tmpDir, `line-${String(i).padStart(3, "0")}.wav`);
    byEntry.set(i, wavPath);
    manifest.push({
      path: wavPath,
      text: entry.text,
      voiceIndex: VOICE_INDEX[entry.speaker],
      rate: RATE[entry.speaker],
    });
  });

  const manifestPath = path.join(tmpDir, "manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest), "utf8");
  const scriptPath = path.join(tmpDir, "render.ps1");
  fs.writeFileSync(scriptPath, POWERSHELL_SCRIPT, "utf8");

  console.log(`[make-audio] rendering ${manifest.length} lines with Windows TTS...`);
  const result = spawnSync(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, "-Manifest", manifestPath],
    { encoding: "utf8" }
  );

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`PowerShell TTS failed (exit ${result.status}):\n${result.stderr || result.stdout}`);
  }
  if (result.stdout.trim()) console.log(`[make-audio] ${result.stdout.trim()}`);

  return byEntry;
}

function main(): void {
  const input = process.argv[2];
  if (!input) {
    console.error("usage: npm run make-audio -- <dialogue file> [output dir]");
    process.exit(1);
  }
  const outDir = process.argv[3] ?? path.join("fixtures", "audio");
  const scenario = path.basename(input).replace(/\.[^.]+$/, "");

  const entries = parseDialogue(input);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "guardian-tts-"));

  try {
    const rendered = renderSpeech(entries, tmpDir);

    // Build both tracks in lockstep: whoever is speaking contributes audio, the
    // other contributes exactly as much silence.
    const tracks: Record<Speaker, Buffer[]> = { caller: [], victim: [] };
    const transcript: string[] = [];
    let elapsedMs = 0;

    for (const [i, entry] of entries.entries()) {
      if (entry.kind === "pause") {
        const gap = mulawSilence(entry.ms);
        tracks.caller.push(gap);
        tracks.victim.push(gap);
        elapsedMs += entry.ms;
        continue;
      }

      const wavPath = rendered.get(i);
      if (!wavPath || !fs.existsSync(wavPath)) {
        throw new Error(`TTS produced no audio for line ${i + 1}: "${entry.text}"`);
      }
      const audio = toMulaw8k(parseWav(wavPath));
      const other: Speaker = entry.speaker === "caller" ? "victim" : "caller";
      const durationMs = mulawDurationMs(audio.length);

      tracks[entry.speaker].push(audio);
      tracks[other].push(mulawSilence(durationMs));
      transcript.push(
        `${(elapsedMs / 1000).toFixed(1)}s ${entry.speaker.padEnd(6)} ${entry.text}`
      );
      elapsedMs += durationMs;

      const gap = mulawSilence(TURN_GAP_MS);
      tracks.caller.push(gap);
      tracks.victim.push(gap);
      elapsedMs += TURN_GAP_MS;
    }

    fs.mkdirSync(outDir, { recursive: true });
    for (const speaker of ["caller", "victim"] as Speaker[]) {
      const mulaw = Buffer.concat(tracks[speaker]);
      const outPath = path.join(outDir, `${scenario}-${speaker}.wav`);
      fs.writeFileSync(outPath, encodeMulawWav(mulaw));
      console.log(
        `[make-audio] wrote ${outPath} (${(mulawDurationMs(mulaw.length) / 1000).toFixed(1)}s, 8kHz mu-law)`
      );
    }

    // The expected transcript doubles as the yardstick for STT accuracy.
    const transcriptPath = path.join(outDir, `${scenario}.expected.txt`);
    fs.writeFileSync(transcriptPath, `${transcript.join("\n")}\n`, "utf8");
    console.log(`[make-audio] wrote ${transcriptPath}`);
    console.log("");
    console.log("These are 8kHz mu-law (telephony format). Once the WebRTC call");
    console.log("ingestion lands, scripts/fake-webrtc.ts will stream them in for you.");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main();
