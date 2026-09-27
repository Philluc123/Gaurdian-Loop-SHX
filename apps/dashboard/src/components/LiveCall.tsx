import { useState } from "react";
import type { CallView } from "../state";
import { CallSummary } from "./CallSummary";
import { Reports } from "./Reports";
import { RiskHero } from "./RiskHero";
import { Transcript } from "./Transcript";

interface Props {
  call: CallView | null;
  following: boolean; // subscribed to "latest" rather than a specific call
  onAck: (alertId: string) => void;
}

/** Top to bottom: the risk (the answer), then reports and summary, then the transcript (the evidence). */
export function LiveCall({ call, following, onAck }: Props) {
  // Acks are a client action with no server echo in the contract, so they live here.
  const [acked, setAcked] = useState<ReadonlySet<string>>(new Set());
  const ack = (alertId: string) => {
    setAcked((s) => new Set(s).add(alertId));
    onAck(alertId);
  };

  if (!call) {
    return (
      <RiskHero
        idle
        score={0}
        level="low"
        reason=""
        signals={[]}
        idleTitle={following ? "No call right now" : "Waiting for this call"}
        idleText={
          following
            ? "When the protected person is on a call, its risk appears here the moment it starts."
            : "Connecting to this call's live feed."
        }
      />
    );
  }

  return (
    <>
      <RiskHero score={call.score} level={call.level} reason={call.reason} signals={call.signals} />
      <div className="middle">
        <Reports alerts={call.alerts} acked={acked} onAck={ack} />
        <CallSummary call={call} />
      </div>
      <Transcript segments={call.segments} highlights={call.highlights} live={call.endedAt === undefined} />
    </>
  );
}
