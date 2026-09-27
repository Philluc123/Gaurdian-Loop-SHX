import { SPEAKER_LABEL, timeOfDay } from "../format";
import type { AlertView } from "../state";
import { Icon } from "./Icon";

interface Props {
  alerts: AlertView[];
  acked: ReadonlySet<string>;
  onAck: (alertId: string) => void;
}

const DELIVERY_TEXT = {
  sent: "You were notified",
  failed: "Notification couldn't be delivered",
  pending: "Notifying you…",
};

/**
 * Alert reports: the newest unacknowledged alert leads, full size; acknowledged and
 * older ones fold into a short list below it.
 */
export function Reports({ alerts, acked, onAck }: Props) {
  const open = alerts.filter((a) => !acked.has(a.event.alertId));
  const current = open[open.length - 1];
  const past = alerts.filter((a) => a !== current);

  return (
    <section className="reports" aria-labelledby="reports-title">
      <h2 id="reports-title" className="section-title">
        Reports
      </h2>

      {!current && past.length === 0 && (
        <div className="panel reports-empty">
          <Icon name="bell" size={22} />
          <p>
            Nothing to report. If this call starts to look like a scam, a report appears here and you get a
            notification.
          </p>
        </div>
      )}

      {current && (
        <article className="report" role="alert" aria-label={`Alert, risk ${current.event.score}`}>
          <header className="report-head">
            <span className="report-icon">
              <Icon name="alertTriangle" size={24} />
            </span>
            <div className="report-heading">
              <h3>Possible scam call</h3>
              <p className="report-when">{timeOfDay(current.event.ts)}</p>
            </div>
            <span className="report-score">Risk {current.event.score}</span>
          </header>

          <p className="report-reason">{current.event.reason.charAt(0).toUpperCase() + current.event.reason.slice(1)}</p>

          {current.event.snippet.length > 0 && (
            <figure className="report-quote">
              {current.event.snippet.map((line, i) => (
                <blockquote key={i} className={`quote-line quote-${line.speaker}`}>
                  <span className="quote-speaker">{SPEAKER_LABEL[line.speaker]}</span>
                  <p>“{line.text}”</p>
                </blockquote>
              ))}
            </figure>
          )}

          <footer className="report-foot">
            <p className={`report-delivery delivery-${current.delivery ?? "pending"}`}>
              {DELIVERY_TEXT[current.delivery ?? "pending"]}
              {open.length > 1 && ` · ${open.length - 1} more to review`}
            </p>
            <button type="button" className="btn btn-primary" onClick={() => onAck(current.event.alertId)}>
              Acknowledge
            </button>
          </footer>
        </article>
      )}

      {past.length > 0 && (
        <details className="panel report-log">
          <summary>
            {past.length} earlier report{past.length === 1 ? "" : "s"}
          </summary>
          <ul>
            {past.map((a) => (
              <li key={a.event.alertId}>
                <span className="report-log-score">Risk {a.event.score}</span>
                <span className="report-log-text">
                  {timeOfDay(a.event.ts)} · {a.event.reason}
                  {acked.has(a.event.alertId) ? " · acknowledged" : ""}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
