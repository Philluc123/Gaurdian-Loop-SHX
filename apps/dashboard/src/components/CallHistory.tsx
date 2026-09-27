import type { AlertTriggered, CallRecord, CallSummary, TranscriptEvent } from "@guardian-loop/shared-types";
import { fetchCall, fetchCalls, useLoad } from "../api";
import { LEVEL_LABEL, SPEAKER_LABEL, clock, dateTime, timeOfDay } from "../format";
import { Link } from "../router";
import { LevelIcon } from "./Icon";

export function CallHistory({ selected }: { selected?: string }) {
  const list = useLoad(fetchCalls, "calls", 5000);

  return (
    <div className="history">
      <section className="card history-list" aria-label="Past calls">
        <header className="card-head">
          <h2>Call history</h2>
        </header>
        {list.status === "loading" && <p className="empty">Loading calls…</p>}
        {list.status === "error" && <p className="empty error">Couldn't load calls: {list.error}</p>}
        {list.status === "ok" && list.data.length === 0 && <p className="empty">No calls recorded yet.</p>}
        {list.status === "ok" && list.data.length > 0 && (
          <ul>
            {list.data.map((c) => (
              <CallRow key={c.callId} call={c} active={c.callId === selected} />
            ))}
          </ul>
        )}
      </section>
      {selected ? <CallDetail callId={selected} /> : <p className="card empty history-hint">Select a call to see its record.</p>}
    </div>
  );
}

function CallRow({ call, active }: { call: CallSummary; active: boolean }) {
  return (
    <li>
      <Link to={`/history/${encodeURIComponent(call.callId)}`} className={`call-row${active ? " active" : ""}`}>
        <span className={`level-badge level-${call.finalLevel}`}>
          <LevelIcon level={call.finalLevel} size={14} /> {call.maxScore}
        </span>
        <span className="call-row-main">
          <span className="call-row-title">{call.from ?? "Unknown caller"}</span>
          <span className="call-row-sub">
            {dateTime(call.startedAt)} · {call.endedAt ? clock(call.endedAt - call.startedAt) : "live now"}
          </span>
        </span>
        {call.alertCount > 0 && <span className="call-row-alerts">{call.alertCount} alert{call.alertCount > 1 ? "s" : ""}</span>}
      </Link>
    </li>
  );
}

function CallDetail({ callId }: { callId: string }) {
  const rec = useLoad(() => fetchCall(callId), callId);
  if (rec.status === "loading") return <section className="card empty">Loading call…</section>;
  if (rec.status === "error") return <section className="card empty error">{rec.error}</section>;
  return <CallRecordView record={rec.data} />;
}

function CallRecordView({ record }: { record: CallRecord }) {
  const { call, events } = record;
  const turns = events.filter((e) => e.type === "transcript").map((e) => e.payload as TranscriptEvent);
  const alerts = events.filter((e) => e.type === "alert.triggered").map((e) => e.payload as AlertTriggered);

  return (
    <section className="card history-detail" aria-label="Call record">
      <header className="card-head">
        <h2>{call.from ?? "Unknown caller"}</h2>
        <Link to={`/call/${encodeURIComponent(call.callId)}`} className="btn">
          {call.endedAt ? "Replay view" : "Open live view"}
        </Link>
      </header>

      <dl className="facts">
        <div>
          <dt>Peak risk</dt>
          <dd>
            <span className={`level-badge level-${call.finalLevel}`}>
              <LevelIcon level={call.finalLevel} size={14} /> {call.maxScore} · {LEVEL_LABEL[call.finalLevel]}
            </span>
          </dd>
        </div>
        <div>
          <dt>Started</dt>
          <dd>{dateTime(call.startedAt)}</dd>
        </div>
        <div>
          <dt>Duration</dt>
          <dd>{call.endedAt ? clock(call.endedAt - call.startedAt) : "Still live"}</dd>
        </div>
        <div>
          <dt>Guardian</dt>
          <dd>{call.guardian.name}</dd>
        </div>
      </dl>

      {alerts.length > 0 && (
        <>
          <h3>Alerts</h3>
          <ul className="record-alerts">
            {alerts.map((a) => (
              <li key={a.alertId}>
                <strong>Risk {a.score}</strong> at {timeOfDay(a.ts)} — {a.reason}
              </li>
            ))}
          </ul>
        </>
      )}

      <h3>Transcript</h3>
      {turns.length === 0 ? (
        <p className="empty">No transcript recorded.</p>
      ) : (
        <ol className="record-transcript">
          {turns.map((t) => (
            <li key={t.segmentId} className={`turn-${t.speaker}`}>
              <span className="turn-time">{clock(t.startMs)}</span>
              <span className="turn-speaker">{SPEAKER_LABEL[t.speaker]}</span>
              <span>{t.text}</span>
            </li>
          ))}
        </ol>
      )}

      <details className="record-events">
        <summary>All {events.length} events</summary>
        <ol>
          {events.map((e, i) => (
            <li key={i}>
              <code>{timeOfDay(e.ts)}</code> {e.type}
            </li>
          ))}
        </ol>
      </details>
    </section>
  );
}
