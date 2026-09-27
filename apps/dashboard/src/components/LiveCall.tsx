import { useEffect, useState } from "react";
import { clock } from "../format";
import type { CallView } from "../state";
import { AlertBanner } from "./AlertBanner";
import { ScoreGauge } from "./ScoreGauge";
import { Transcript } from "./Transcript";

interface Props {
  call: CallView | null;
  following: boolean; // subscribed to "latest" rather than a specific call
  onAck: (alertId: string) => void;
}

export function LiveCall({ call, following, onAck }: Props) {
  // Acks are a client action with no server echo in the contract, so they live here.
  const [acked, setAcked] = useState<ReadonlySet<string>>(new Set());
  const ack = (alertId: string) => {
    setAcked((s) => new Set(s).add(alertId));
    onAck(alertId);
  };

  if (!call) {
    return (
      <div className="card empty waiting">
        <h2>{following ? "No active call" : "Waiting for this call…"}</h2>
        <p>{following ? "The dashboard will switch to a call as soon as one starts." : "Connecting to the call's live feed."}</p>
      </div>
    );
  }

  const live = call.endedAt === undefined;
  return (
    <>
      <AlertBanner alerts={call.alerts} acked={acked} onAck={ack} />
      <div className="live-grid">
        <Transcript segments={call.segments} highlights={call.highlights} live={live} />
        <aside className="side">
          <ScoreGauge
            score={call.score}
            level={call.level}
            reason={call.reason}
            signals={call.signals}
            history={call.history}
            startedAt={call.startedAt}
          />
          <CallInfo call={call} live={live} />
        </aside>
      </div>
    </>
  );
}

function CallInfo({ call, live }: { call: CallView; live: boolean }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [live]);

  return (
    <section className="card call-info" aria-label="Call details">
      <dl className="facts">
        <div>
          <dt>Status</dt>
          <dd>{live ? "In progress" : "Call ended"}</dd>
        </div>
        <div>
          <dt>Duration</dt>
          <dd>{clock((call.endedAt ?? now) - call.startedAt)}</dd>
        </div>
        <div className="fact-wide">
          <dt>Call ID</dt>
          <dd className="mono">{call.callId}</dd>
        </div>
      </dl>
    </section>
  );
}
