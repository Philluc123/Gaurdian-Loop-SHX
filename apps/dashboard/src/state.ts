// Folds ServerMsgs into the view model the components render.
//
// This is bookkeeping only — merging partials into finals, keeping the latest
// highlight spans per segment, remembering score history for the sparkline. Every
// number and signal shown comes straight from the server; nothing here scores.

import type {
  AlertSent,
  AlertTriggered,
  CallId,
  HighlightSpan,
  RiskLevel,
  ServerMsg,
  Signal,
  Speaker,
} from "@guardian-loop/shared-types";

export interface Segment {
  segmentId: string;
  speaker: Speaker;
  text: string;
  isFinal: boolean;
  startMs: number;
  endMs: number;
}

export interface SegmentHighlights {
  isFinal: boolean;
  spans: HighlightSpan[];
}

export interface AlertView {
  event: AlertTriggered;
  delivery?: AlertSent["status"];
}

export interface ScorePoint {
  ts: number;
  score: number;
}

export interface CallView {
  callId: CallId;
  startedAt: number;
  segments: Segment[]; // ordered by startMs; finals plus any in-progress partials
  highlights: Record<string, SegmentHighlights>;
  score: number;
  level: RiskLevel;
  signals: Signal[];
  reason: string;
  history: ScorePoint[];
  alerts: AlertView[];
  endedAt?: number;
}

export type DashboardState = { call: CallView | null };

export const initialState: DashboardState = { call: null };

const MAX_HISTORY = 900; // ~15 min of per-second decay updates

export function reduce(state: DashboardState, msg: ServerMsg, now: number): DashboardState {
  if (msg.type === "snapshot") return { call: fromSnapshot(msg.call, now) };

  const call = state.call;
  if (!call) return state; // nothing to apply incremental updates to until a snapshot arrives

  switch (msg.type) {
    case "transcript": {
      const ev = msg.event;
      if (ev.callId !== call.callId) return state;
      const existing = call.segments.find((s) => s.segmentId === ev.segmentId);
      if (existing?.isFinal && !ev.isFinal) return state; // late partial after its final
      const seg: Segment = {
        segmentId: ev.segmentId,
        speaker: ev.speaker,
        text: ev.text,
        isFinal: ev.isFinal,
        startMs: ev.startMs,
        endMs: ev.endMs,
      };
      const segments = existing
        ? call.segments.map((s) => (s.segmentId === ev.segmentId ? seg : s))
        : insertByStart(call.segments, seg);
      return { call: { ...call, segments } };
    }

    case "highlights": {
      const prev = call.highlights[msg.segmentId];
      if (prev?.isFinal && !msg.isFinal) return state;
      const highlights = { ...call.highlights, [msg.segmentId]: { isFinal: msg.isFinal, spans: msg.spans } };
      return { call: { ...call, highlights } };
    }

    case "score": {
      const ev = msg.event;
      if (ev.callId !== call.callId) return state;
      const history = [...call.history, { ts: ev.ts, score: ev.score }].slice(-MAX_HISTORY);
      return {
        call: { ...call, score: ev.score, level: ev.level, signals: ev.signals, reason: ev.reason, history },
      };
    }

    case "alert": {
      const ev = msg.event;
      if (ev.callId !== call.callId) return state;
      const i = call.alerts.findIndex((a) => a.event.alertId === ev.alertId);
      const alerts =
        i < 0
          ? [...call.alerts, { event: ev, delivery: msg.delivery }]
          : call.alerts.map((a, j) => (j === i ? { event: ev, delivery: msg.delivery ?? a.delivery } : a));
      return { call: { ...call, alerts } };
    }

    case "call_ended":
      if (msg.callId !== call.callId) return state;
      return { call: { ...call, endedAt: msg.ts } };

    case "notification":
      // A one-off action, not view state: notifications.ts raises it. The alert it
      // announces arrives separately as an `alert` message, which the banner shows.
      return state;
  }
}

function fromSnapshot(s: Extract<ServerMsg, { type: "snapshot" }>["call"], now: number): CallView {
  const highlights: Record<string, SegmentHighlights> = {};
  for (const { segmentId, start, end, signal } of s.highlights) {
    (highlights[segmentId] ??= { isFinal: true, spans: [] }).spans.push({ start, end, signal });
  }
  const lastAlert = s.alerts[s.alerts.length - 1];
  return {
    callId: s.callId,
    startedAt: s.startedAt,
    segments: s.turns.map((t) => ({ ...t, isFinal: true })).sort((a, b) => a.startMs - b.startMs),
    highlights,
    score: s.score,
    level: s.level,
    signals: s.signals,
    reason: lastAlert?.reason ?? "",
    history: [{ ts: now, score: s.score }],
    alerts: s.alerts.map((event) => ({ event })),
  };
}

function insertByStart(segments: Segment[], seg: Segment): Segment[] {
  const i = segments.findIndex((s) => s.startMs > seg.startMs);
  return i < 0 ? [...segments, seg] : [...segments.slice(0, i), seg, ...segments.slice(i)];
}

/**
 * Splits a segment's text into plain and highlighted runs. Spans are clamped to the
 * text (a partial's spans can briefly outlive the text they were computed on) and
 * overlaps are resolved by keeping the earlier span.
 */
export function splitHighlights(
  text: string,
  spans: HighlightSpan[]
): Array<{ text: string; signal?: Signal }> {
  const sorted = spans
    .map((s) => ({ ...s, start: Math.max(0, s.start), end: Math.min(text.length, s.end) }))
    .filter((s) => s.end > s.start)
    .sort((a, b) => a.start - b.start || b.end - a.end);

  const runs: Array<{ text: string; signal?: Signal }> = [];
  let pos = 0;
  for (const s of sorted) {
    if (s.start < pos) continue;
    if (s.start > pos) runs.push({ text: text.slice(pos, s.start) });
    runs.push({ text: text.slice(s.start, s.end), signal: s.signal });
    pos = s.end;
  }
  if (pos < text.length) runs.push({ text: text.slice(pos) });
  return runs;
}
