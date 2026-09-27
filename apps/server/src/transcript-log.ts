// Dev-only transcript sink: writes each call to a file so you can read it back
// after hanging up.
//
// This is deliberately NOT the event store (docs/module-contracts.md §3.9), which
// is Workstream E's MongoDB module plus the /api/calls endpoints. This exists
// because Workstream A needed somewhere to see a call's output before that lands,
// and it should be deleted once the event store is writing.
//
// Only final transcripts are written, matching the event store's rule that
// partials are never persisted.

import fs from "node:fs";
import path from "node:path";
import type { CallId } from "@guardian-loop/shared-types";
import type { EventBus } from "./event-bus";

export interface TranscriptLogOptions {
  /** Directory for per-call files. Created on demand. */
  dir: string;
}

interface OpenCall {
  startedAt: number;
  jsonlPath: string;
  textPath: string;
  turns: number;
  closeTimer?: NodeJS.Timeout;
}

/**
 * call.ended fires when the socket stops, but the STT adapters then flush their
 * vendor's closing results — so the last words of a call arrive *after* it. Keep
 * the file open briefly to catch them, or every call would lose its ending.
 */
const FLUSH_GRACE_MS = 3_500;

/** Windows-safe: CallSids are alphanumeric, but fake/manual ids may not be. */
function safeName(callId: CallId): string {
  return callId.replace(/[^A-Za-z0-9._-]/g, "_");
}

function stamp(startedAt: number, ts: number): string {
  const seconds = Math.max(0, (ts - startedAt) / 1000);
  const mm = String(Math.floor(seconds / 60)).padStart(2, "0");
  const ss = String(Math.floor(seconds % 60)).padStart(2, "0");
  return `${mm}:${ss}`;
}

export function createTranscriptLog(bus: EventBus, opts: TranscriptLogOptions): { stop(): void } {
  const calls = new Map<CallId, OpenCall>();
  const offs: Array<() => void> = [];

  offs.push(
    bus.subscribe("call.started", (event) => {
      fs.mkdirSync(opts.dir, { recursive: true });
      const base = path.join(opts.dir, `${safeName(event.callId)}`);
      const call: OpenCall = {
        startedAt: event.ts,
        jsonlPath: `${base}.jsonl`,
        textPath: `${base}.txt`,
        turns: 0,
      };
      calls.set(event.callId, call);

      const started = new Date(event.ts).toISOString();
      fs.writeFileSync(
        call.textPath,
        [
          `Guardian Loop call transcript`,
          `callId:   ${event.callId}`,
          `source:   ${event.source}`,
          `from:     ${event.from ?? "unknown"}`,
          `to:       ${event.to ?? "unknown"}`,
          `guardian: ${event.guardian.name} <${event.guardian.phone || "no phone"}>`,
          `started:  ${started}`,
          "",
        ].join("\n"),
        "utf8"
      );
      fs.writeFileSync(call.jsonlPath, `${JSON.stringify(event)}\n`, "utf8");
      console.log(`[transcript-log] writing ${call.textPath}`);
    })
  );

  offs.push(
    bus.subscribe("transcript", (event) => {
      if (!event.isFinal) return; // partials are never persisted
      const call = calls.get(event.callId);
      if (!call) return;
      call.turns += 1;
      fs.appendFileSync(
        call.textPath,
        `[${stamp(call.startedAt, event.ts)}] ${event.speaker.padEnd(6)} ${event.text}\n`,
        "utf8"
      );
      fs.appendFileSync(call.jsonlPath, `${JSON.stringify(event)}\n`, "utf8");
    })
  );

  offs.push(
    bus.subscribe("call.ended", (event) => {
      const call = calls.get(event.callId);
      if (!call || call.closeTimer) return;
      fs.appendFileSync(call.jsonlPath, `${JSON.stringify(event)}
`, "utf8");

      // Wait for the adapters' final flush before writing the footer.
      call.closeTimer = setTimeout(() => finish(event.callId, event.reason, event.ts), FLUSH_GRACE_MS);
      call.closeTimer.unref();
    })
  );

  function finish(callId: CallId, reason: string, endedAt: number): void {
    const call = calls.get(callId);
    if (!call) return;
    calls.delete(callId);
    if (call.closeTimer) clearTimeout(call.closeTimer);

    const durationSec = ((endedAt - call.startedAt) / 1000).toFixed(1);
    fs.appendFileSync(
      call.textPath,
      `
ended: ${reason} after ${durationSec}s, ${call.turns} final turns
`,
      "utf8"
    );
    console.log(`[transcript-log] ${call.textPath} — ${call.turns} turns, ${durationSec}s`);
  }

  return {
    stop() {
      for (const off of offs) off();
      offs.length = 0;
      // Don't leave a half-written file behind on shutdown.
      for (const callId of [...calls.keys()]) finish(callId, "manual", Date.now());
    },
  };
}
