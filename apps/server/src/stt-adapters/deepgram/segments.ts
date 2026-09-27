// Turns Deepgram's streaming messages into the TranscriptEvent sequence the rest
// of the system expects: many partials sharing a segmentId, then exactly one
// final that replaces them (docs/module-contracts.md §3.2).
//
// Kept free of any socket so it can be unit-tested against recorded Deepgram JSON.
//
// Deepgram's own guidance is that `speech_final` must not be used alone to
// capture full transcripts: a long utterance arrives as several `is_final`
// results, and with noisy audio `speech_final` may never arrive at all. So we
// buffer `is_final` text and commit on `speech_final` *or* `UtteranceEnd`.

import type { CallId, Speaker, TranscriptEvent } from "@guardian-loop/shared-types";

export interface DeepgramWord {
  word?: string;
  start?: number;
  end?: number;
  confidence?: number;
}

export interface DeepgramResults {
  type: "Results";
  is_final?: boolean;
  speech_final?: boolean;
  from_finalize?: boolean;
  start?: number;
  duration?: number;
  channel?: {
    alternatives?: Array<{
      transcript?: string;
      confidence?: number;
      words?: DeepgramWord[];
    }>;
  };
}

export interface DeepgramUtteranceEnd {
  type: "UtteranceEnd";
  last_word_end?: number;
}

export type DeepgramMessage =
  | DeepgramResults
  | DeepgramUtteranceEnd
  | { type: string; [key: string]: unknown };

export interface SegmentAssemblerOptions {
  callId: CallId;
  speaker: Speaker;
  emit: (event: TranscriptEvent) => void;
  /** Injectable clock so tests get deterministic `ts` values. */
  now?: () => number;
}

export class SegmentAssembler {
  private readonly now: () => number;

  /** Text of each is_final result belonging to the segment being assembled. */
  private chunks: string[] = [];
  private counter = 0;
  private segmentId: string;
  private startMs: number | undefined;
  private endMs = 0;
  private confidence: number | undefined;
  private lastPartialText = "";

  /**
   * Milliseconds of audio sent before the current Deepgram connection opened.
   * Deepgram's timestamps restart at 0 on every new socket, so this is what
   * keeps startMs/endMs call-relative and monotonic across a reconnect.
   */
  private connectionOffsetMs = 0;

  constructor(private readonly opts: SegmentAssemblerOptions) {
    this.now = opts.now ?? Date.now;
    this.segmentId = this.nextSegmentId();
  }

  private nextSegmentId(): string {
    this.counter += 1;
    return `${this.opts.callId}:${this.opts.speaker}:${this.counter}`;
  }

  /** Called on each (re)connect with the total audio already sent. */
  setConnectionOffsetMs(ms: number): void {
    this.connectionOffsetMs = ms;
  }

  handleMessage(msg: DeepgramMessage): void {
    if (msg.type === "Results") {
      this.handleResults(msg as DeepgramResults);
      return;
    }
    if (msg.type === "UtteranceEnd") {
      // Backstop: commit a segment Deepgram finalized but never marked
      // speech_final. Harmless when speech_final already committed it, because
      // an empty buffer commits nothing.
      this.commit();
    }
  }

  private handleResults(msg: DeepgramResults): void {
    const alt = msg.channel?.alternatives?.[0];
    const text = (alt?.transcript ?? "").trim();
    const isFinal = msg.is_final === true;

    if (text !== "") {
      const startMs = this.connectionOffsetMs + (msg.start ?? 0) * 1000;
      const endMs = startMs + (msg.duration ?? 0) * 1000;
      if (this.startMs === undefined) this.startMs = startMs;
      this.endMs = Math.max(this.endMs, endMs);
      if (typeof alt?.confidence === "number") this.confidence = alt.confidence;
    }

    if (isFinal && text !== "") this.chunks.push(text);

    // This message closes the segment, so go straight to the final — emitting a
    // partial first would just duplicate the final's text.
    if (msg.speech_final === true || msg.from_finalize === true) {
      this.commit();
      return;
    }

    // A partial carries the whole utterance so far — everything finalized in
    // this segment plus the live interim tail — because TranscriptEvent.text is
    // defined as the full text of the segment, not a delta.
    const combined = isFinal
      ? this.chunks.join(" ")
      : [...this.chunks, text].filter((t) => t !== "").join(" ");

    if (combined !== "" && combined !== this.lastPartialText) {
      this.lastPartialText = combined;
      this.emit(combined, false);
    }
  }

  /** Emit one final for the assembled segment, then start a new segment. */
  commit(): void {
    const text = this.chunks.join(" ").trim();
    if (text === "") return; // nothing finalized yet; keep the segmentId

    this.emit(text, true);
    this.chunks = [];
    this.startMs = undefined;
    this.endMs = 0;
    this.confidence = undefined;
    this.lastPartialText = "";
    this.segmentId = this.nextSegmentId();
  }

  /** Commit whatever is buffered, e.g. when the call ends. */
  flush(): void {
    this.commit();
  }

  private emit(text: string, isFinal: boolean): void {
    this.opts.emit({
      type: "transcript",
      callId: this.opts.callId,
      speaker: this.opts.speaker,
      segmentId: this.segmentId,
      text,
      isFinal,
      startMs: Math.round(this.startMs ?? 0),
      endMs: Math.round(this.endMs),
      confidence: this.confidence,
      ts: this.now(),
    });
  }
}
