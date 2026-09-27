import { SPEAKER_LABEL, timeOfDay } from "../format";
import type { AlertView } from "../state";

interface Props {
  alerts: AlertView[];
  acked: ReadonlySet<string>;
  onAck: (alertId: string) => void;
}

const DELIVERY_TEXT = {
  sent: "Notification sent to guardian",
  failed: "Notification failed to send",
  pending: "Sending notification…",
};

/** The newest unacknowledged alert, full width; acknowledged ones collapse to a list. */
export function AlertBanner({ alerts, acked, onAck }: Props) {
  const open = alerts.filter((a) => !acked.has(a.event.alertId));
  const current = open[open.length - 1];
  const past = alerts.filter((a) => a !== current);

  return (
    <>
      {current && (
        <section className="alert-banner" role="alert">
          <div className="alert-icon" aria-hidden="true">⚠</div>
          <div className="alert-body">
            <h2>
              Possible scam call <span className="alert-score">risk {current.event.score}</span>
            </h2>
            <p className="alert-reason">{current.event.reason}</p>
            <blockquote className="alert-snippet">
              {current.event.snippet.map((line, i) => (
                <p key={i}>
                  <span className="snippet-speaker">{SPEAKER_LABEL[line.speaker]}:</span> “{line.text}”
                </p>
              ))}
            </blockquote>
            <p className={`alert-delivery delivery-${current.delivery ?? "pending"}`}>
              {DELIVERY_TEXT[current.delivery ?? "pending"]} · {timeOfDay(current.event.ts)}
              {open.length > 1 && ` · ${open.length - 1} more unacknowledged`}
            </p>
          </div>
          <button className="btn btn-primary" onClick={() => onAck(current.event.alertId)}>
            Acknowledge
          </button>
        </section>
      )}
      {past.length > 0 && (
        <details className="alert-log">
          <summary>
            {past.length} earlier alert{past.length === 1 ? "" : "s"}
          </summary>
          <ul>
            {past.map((a) => (
              <li key={a.event.alertId}>
                {timeOfDay(a.event.ts)} · risk {a.event.score} · {a.event.reason}
                {acked.has(a.event.alertId) ? " · acknowledged" : ""}
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}
