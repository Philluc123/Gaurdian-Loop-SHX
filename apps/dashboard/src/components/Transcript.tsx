import { useEffect, useRef } from "react";
import type { HighlightSpan } from "@guardian-loop/shared-types";
import { SIGNAL_LABEL, SPEAKER_LABEL, clock, signalTone } from "../format";
import { splitHighlights, type Segment, type SegmentHighlights } from "../state";

interface Props {
  segments: Segment[];
  highlights: Record<string, SegmentHighlights>;
  live: boolean;
}

export function Transcript({ segments, highlights, live }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true); // follow new lines unless the reader has scrolled up

  useEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [segments]);

  const onScroll = () => {
    const el = scroller.current;
    if (el) pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };

  return (
    <section className="card transcript" aria-label="Transcript">
      <header className="card-head">
        <h2>Transcript</h2>
        {live && <span className="live-dot">Live</span>}
      </header>
      <div className="transcript-body" ref={scroller} onScroll={onScroll} aria-live="polite">
        {segments.length === 0 ? (
          <p className="empty">Waiting for the first words…</p>
        ) : (
          segments.map((seg) => (
            <TurnRow key={seg.segmentId} seg={seg} spans={highlights[seg.segmentId]?.spans ?? []} />
          ))
        )}
      </div>
    </section>
  );
}

function TurnRow({ seg, spans }: { seg: Segment; spans: HighlightSpan[] }) {
  return (
    <div className={`turn turn-${seg.speaker}${seg.isFinal ? "" : " turn-partial"}`}>
      <div className="turn-meta">
        <span className="turn-speaker">{SPEAKER_LABEL[seg.speaker]}</span>
        <span className="turn-time">{clock(seg.startMs)}</span>
      </div>
      <p className="turn-text">
        {splitHighlights(seg.text, spans).map((run, i) =>
          run.signal ? (
            <mark key={i} className={`hl hl-${signalTone(run.signal)}`} title={SIGNAL_LABEL[run.signal]}>
              {run.text}
              <span className="hl-tag">{SIGNAL_LABEL[run.signal]}</span>
            </mark>
          ) : (
            <span key={i}>{run.text}</span>
          )
        )}
        {!seg.isFinal && <span className="typing" aria-label="still speaking" />}
      </p>
    </div>
  );
}
