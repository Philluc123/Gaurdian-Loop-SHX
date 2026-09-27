// STT session routing (§3.3): one session per speaker per call, audio routed by
// `speaker`, transcripts handed back to the caller to publish.
//
// Takes the adapter as an argument rather than importing stt-adapters, so the
// orchestrator depends only on the SttAdapter contract and tests can pass a fake.

import type { AudioFrame, CallId, Speaker, SttAdapter, SttSession, TranscriptEvent } from "@guardian-loop/shared-types";

export interface SttSessions {
  /** Opens both speakers' sessions up front, so the first word isn't spent connecting. */
  open(callId: CallId): void;
  send(frame: AudioFrame): void;
  /** Flushes and closes a call's sessions. Never rejects. */
  close(callId: CallId): Promise<void>;
  closeAll(): Promise<void>;
}

type CallSessions = Partial<Record<Speaker, SttSession>>;

export function createSttSessions(
  adapter: SttAdapter,
  onTranscript: (event: TranscriptEvent) => void
): SttSessions {
  const sessions = new Map<CallId, CallSessions>();

  function sessionFor(callId: CallId, speaker: Speaker): SttSession | undefined {
    let perCall = sessions.get(callId);
    if (!perCall) {
      perCall = {};
      sessions.set(callId, perCall);
    }
    if (!perCall[speaker]) {
      try {
        perCall[speaker] = adapter.openSession(callId, speaker, onTranscript);
      } catch (err) {
        console.error(`[orchestrator] could not open ${adapter.name} session for ${speaker}:`, err);
        return undefined;
      }
    }
    return perCall[speaker];
  }

  async function closeSessions(perCall: CallSessions): Promise<void> {
    await Promise.allSettled(Object.values(perCall).map((s) => s.close()));
  }

  return {
    open(callId) {
      // The adapter dials out lazily on first audio, so a speaker who never
      // talks costs nothing.
      sessionFor(callId, "caller");
      sessionFor(callId, "victim");
      console.log(`[orchestrator] ${adapter.name} sessions open for ${callId}`);
    },
    send(frame) {
      sessionFor(frame.callId, frame.speaker)?.sendAudio(frame);
    },
    async close(callId) {
      const perCall = sessions.get(callId);
      if (!perCall) return;
      sessions.delete(callId);
      // Closing flushes the vendor's tail, so the last words before hangup
      // still arrive as finals.
      await closeSessions(perCall);
      console.log(`[orchestrator] sessions closed for ${callId}`);
    },
    async closeAll() {
      const all = [...sessions.values()];
      sessions.clear();
      await Promise.allSettled(all.map(closeSessions));
    },
  };
}
