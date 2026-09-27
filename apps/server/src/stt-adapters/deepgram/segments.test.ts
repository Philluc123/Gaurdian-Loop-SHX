import { describe, expect, it } from "vitest";
import type { TranscriptEvent } from "@guardian-loop/shared-types";
import { SegmentAssembler, type DeepgramMessage } from "./segments";
import { buildQuery } from "./index";

function makeAssembler() {
  const events: TranscriptEvent[] = [];
  const assembler = new SegmentAssembler({
    callId: "CA1",
    speaker: "caller",
    emit: (e) => events.push(e),
    now: () => 1_700_000_000_000,
  });
  return { assembler, events };
}

/** Results message shaped like Deepgram's streaming API. */
function results(opts: {
  transcript: string;
  isFinal?: boolean;
  speechFinal?: boolean;
  start?: number;
  duration?: number;
  confidence?: number;
}): DeepgramMessage {
  return {
    type: "Results",
    is_final: opts.isFinal ?? false,
    speech_final: opts.speechFinal ?? false,
    start: opts.start ?? 0,
    duration: opts.duration ?? 1,
    channel: {
      alternatives: [{ transcript: opts.transcript, confidence: opts.confidence ?? 0.9 }],
    },
  };
}

const finals = (events: TranscriptEvent[]) => events.filter((e) => e.isFinal);
const partials = (events: TranscriptEvent[]) => events.filter((e) => !e.isFinal);

describe("SegmentAssembler", () => {
  it("emits partials as the interim text grows, then one final per segment", () => {
    const { assembler, events } = makeAssembler();
    assembler.handleMessage(results({ transcript: "buy" }));
    assembler.handleMessage(results({ transcript: "buy a gift" }));
    assembler.handleMessage(results({ transcript: "buy a gift card", isFinal: true, speechFinal: true }));

    expect(partials(events).map((e) => e.text)).toEqual(["buy", "buy a gift"]);
    expect(finals(events)).toHaveLength(1);
    expect(finals(events)[0]).toMatchObject({
      type: "transcript",
      callId: "CA1",
      speaker: "caller",
      text: "buy a gift card",
      isFinal: true,
    });
  });

  it("joins several is_final chunks into one final, which speech_final alone would split", () => {
    // Deepgram's docs are explicit that speech_final must not be used alone:
    // a long utterance arrives as multiple is_final results.
    const { assembler, events } = makeAssembler();
    assembler.handleMessage(results({ transcript: "I am calling from Medicare", isFinal: true }));
    assembler.handleMessage(results({ transcript: "and your account" }));
    assembler.handleMessage(
      results({ transcript: "and your account is suspended", isFinal: true, speechFinal: true })
    );

    expect(finals(events).map((e) => e.text)).toEqual([
      "I am calling from Medicare and your account is suspended",
    ]);
  });

  it("shows the whole utterance in partials, not just the interim tail", () => {
    const { assembler, events } = makeAssembler();
    assembler.handleMessage(results({ transcript: "don't tell", isFinal: true }));
    assembler.handleMessage(results({ transcript: "your daughter" }));

    expect(partials(events).at(-1)?.text).toBe("don't tell your daughter");
  });

  it("commits on UtteranceEnd when speech_final never arrives", () => {
    const { assembler, events } = makeAssembler();
    assembler.handleMessage(results({ transcript: "wire the money today", isFinal: true }));
    expect(finals(events)).toHaveLength(0);

    assembler.handleMessage({ type: "UtteranceEnd", last_word_end: 2.5 });
    expect(finals(events).map((e) => e.text)).toEqual(["wire the money today"]);
  });

  it("does not double-commit when UtteranceEnd follows speech_final", () => {
    const { assembler, events } = makeAssembler();
    assembler.handleMessage(results({ transcript: "hello there", isFinal: true, speechFinal: true }));
    assembler.handleMessage({ type: "UtteranceEnd", last_word_end: 1.2 });

    expect(finals(events)).toHaveLength(1);
  });

  it("gives partials of one segment a shared segmentId, and the next segment a new one", () => {
    const { assembler, events } = makeAssembler();
    assembler.handleMessage(results({ transcript: "first" }));
    assembler.handleMessage(results({ transcript: "first one", isFinal: true, speechFinal: true }));
    assembler.handleMessage(results({ transcript: "second" }));
    assembler.handleMessage(results({ transcript: "second one", isFinal: true, speechFinal: true }));

    const [p1, f1, p2, f2] = events;
    expect(p1.segmentId).toBe(f1.segmentId);
    expect(p2.segmentId).toBe(f2.segmentId);
    expect(f1.segmentId).not.toBe(f2.segmentId);
  });

  it("reports call-relative start and end times in milliseconds", () => {
    const { assembler, events } = makeAssembler();
    assembler.handleMessage(results({ transcript: "hi", start: 4.2, duration: 0.8 }));
    assembler.handleMessage(
      results({ transcript: "hi there", isFinal: true, speechFinal: true, start: 4.2, duration: 1.3 })
    );

    expect(finals(events)[0]).toMatchObject({ startMs: 4200, endMs: 5500 });
  });

  it("keeps timestamps continuous across a reconnect, whose Deepgram clock restarts at 0", () => {
    const { assembler, events } = makeAssembler();
    assembler.handleMessage(results({ transcript: "before", isFinal: true, speechFinal: true, start: 1 }));

    // 30s of audio had been sent when the socket dropped and reconnected.
    assembler.setConnectionOffsetMs(30_000);
    assembler.handleMessage(
      results({ transcript: "after", isFinal: true, speechFinal: true, start: 0.5, duration: 1 })
    );

    expect(finals(events).map((e) => e.startMs)).toEqual([1000, 30_500]);
  });

  it("carries the vendor confidence through", () => {
    const { assembler, events } = makeAssembler();
    assembler.handleMessage(
      results({ transcript: "gift cart", isFinal: true, speechFinal: true, confidence: 0.62 })
    );
    expect(finals(events)[0]?.confidence).toBeCloseTo(0.62);
  });

  it("ignores empty transcripts, which Deepgram sends during silence", () => {
    const { assembler, events } = makeAssembler();
    assembler.handleMessage(results({ transcript: "" }));
    assembler.handleMessage(results({ transcript: "   ", isFinal: true }));
    assembler.handleMessage({ type: "UtteranceEnd" });
    assembler.handleMessage({ type: "SpeechStarted", timestamp: 1 });
    assembler.handleMessage({ type: "Metadata", request_id: "x" });

    expect(events).toHaveLength(0);
  });

  it("does not repeat an unchanged partial", () => {
    const { assembler, events } = makeAssembler();
    assembler.handleMessage(results({ transcript: "same" }));
    assembler.handleMessage(results({ transcript: "same" }));

    expect(partials(events)).toHaveLength(1);
  });

  it("flush commits a pending segment, so a hangup doesn't lose the last words", () => {
    const { assembler, events } = makeAssembler();
    assembler.handleMessage(results({ transcript: "last words", isFinal: true }));
    assembler.flush();

    expect(finals(events).map((e) => e.text)).toEqual(["last words"]);
  });

  it("flush on an empty buffer emits nothing", () => {
    const { assembler, events } = makeAssembler();
    assembler.flush();
    expect(events).toHaveLength(0);
  });
});

describe("buildQuery", () => {
  const cfg = { apiKey: "k", model: "nova-3" };

  it("passes mu-law through without transcoding", () => {
    const q = new URLSearchParams(buildQuery(cfg, "mulaw", 8000));
    expect(q.get("encoding")).toBe("mulaw");
    expect(q.get("sample_rate")).toBe("8000");
    expect(q.get("model")).toBe("nova-3");
  });

  it("enables interim results, which utterance_end_ms depends on", () => {
    const q = new URLSearchParams(buildQuery(cfg, "mulaw", 8000));
    expect(q.get("interim_results")).toBe("true");
    // Deepgram sends interim results about once a second, so anything under
    // 1000ms would buy nothing.
    expect(Number(q.get("utterance_end_ms"))).toBeGreaterThanOrEqual(1000);
    expect(Number(q.get("endpointing"))).toBeGreaterThan(0);
  });

  it("maps pcm16 to Deepgram's linear16", () => {
    const q = new URLSearchParams(buildQuery(cfg, "pcm16", 16000));
    expect(q.get("encoding")).toBe("linear16");
    expect(q.get("sample_rate")).toBe("16000");
  });
});
