// Routes audio.frame events into one STT session per speaker and republishes the
// resulting TranscriptEvents onto the bus.
//
// docs/module-contracts.md §3.3 assigns this routing to the orchestrator, which
// doesn't exist yet. Keeping it in its own file means Workstream B can absorb it
// by deleting this file and calling openSession from the orchestrator — no
// changes to the adapters or to call ingestion.

import type {
  AudioFrame,
  CallEnded,
  CallId,
  CallStarted,
  Speaker,
  SttAdapter,
  SttSession,
  TranscriptEvent,
} from "@guardian-loop/shared-types";
import type { EventBus } from "../event-bus";

interface CallSessions {
  caller: SttSession | undefined;
  victim: SttSession | undefined;
}

export interface SttBridge {
  /** Live transcription sessions, for diagnostics. */
  readonly activeCalls: ReadonlySet<CallId>;
  /** Close every session (used on shutdown). */
  closeAll(): Promise<void>;
  stop(): void;
}

export function createSttBridge(bus: EventBus, adapter: SttAdapter): SttBridge {
  const sessions = new Map<CallId, CallSessions>();
  const unsubscribes: Array<() => void> = [];

  function sessionFor(callId: CallId, speaker: Speaker): SttSession | undefined {
    let perCall = sessions.get(callId);
    if (!perCall) {
      perCall = { caller: undefined, victim: undefined };
      sessions.set(callId, perCall);
    }
    if (!perCall[speaker]) {
      try {
        perCall[speaker] = adapter.openSession(callId, speaker, (event: TranscriptEvent) =>
          bus.publish(event)
        );
      } catch (err) {
        console.error(`[stt-bridge] could not open ${adapter.name} session for ${speaker}:`, err);
        return undefined;
      }
    }
    return perCall[speaker];
  }

  unsubscribes.push(
    bus.subscribe("call.started", (event: CallStarted) => {
      // Open both sessions up front so the first word of the call isn't spent
      // establishing a connection. The adapters dial out lazily on first audio,
      // so a speaker who never talks costs nothing.
      sessionFor(event.callId, "caller");
      sessionFor(event.callId, "victim");
      console.log(`[stt-bridge] ${adapter.name} sessions open for ${event.callId}`);
    })
  );

  unsubscribes.push(
    bus.subscribe("audio.frame", (frame: AudioFrame) => {
      sessionFor(frame.callId, frame.speaker)?.sendAudio(frame);
    })
  );

  unsubscribes.push(
    bus.subscribe("call.ended", (event: CallEnded) => {
      const perCall = sessions.get(event.callId);
      if (!perCall) return;
      sessions.delete(event.callId);
      // Closing flushes each vendor's tail, so the last words before hangup
      // still arrive as finals. Failures here must not reject into the bus.
      void Promise.allSettled(
        [perCall.caller, perCall.victim].map((s) => s?.close() ?? Promise.resolve())
      ).then(() => console.log(`[stt-bridge] sessions closed for ${event.callId}`));
    })
  );

  return {
    get activeCalls() {
      return new Set(sessions.keys());
    },
    async closeAll() {
      const all = [...sessions.values()].flatMap((s) => [s.caller, s.victim]);
      sessions.clear();
      await Promise.allSettled(all.map((s) => s?.close() ?? Promise.resolve()));
    },
    stop() {
      for (const off of unsubscribes) off();
      unsubscribes.length = 0;
    },
  };
}
