import { useEffect, useId, useState, type PointerEvent } from "react";
import { clock } from "../format";
import type { CallView, ScorePoint } from "../state";

/** Call facts plus how the risk moved. Bookkeeping only — every number comes from the server. */
export function CallSummary({ call }: { call: CallView }) {
  const live = call.endedAt === undefined;
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [live]);

  // Highest score this dashboard has seen for the call (the snapshot seeds history).
  const peak = Math.max(call.score, ...call.history.map((p) => p.score));
  const exchanges = call.segments.filter((s) => s.isFinal).length;

  return (
    <section className="summary" aria-labelledby="summary-title">
      <h2 id="summary-title" className="section-title">
        Summary
      </h2>
      <div className="panel">
        <dl className="facts">
          <div>
            <dt>Status</dt>
            <dd className={live ? "status-live" : undefined}>{live ? "In progress" : "Call ended"}</dd>
          </div>
          <div>
            <dt>Duration</dt>
            <dd className="num">{clock((call.endedAt ?? now) - call.startedAt)}</dd>
          </div>
          <div>
            <dt>Peak risk</dt>
            <dd className="num">{peak}</dd>
          </div>
          <div>
            <dt>Exchanges</dt>
            <dd className="num">{exchanges}</dd>
          </div>
        </dl>

        <RiskTrend history={call.history} startedAt={call.startedAt} />

        <p className="call-id">
          Call <span className="mono">{call.callId}</span>
        </p>
      </div>
    </section>
  );
}

const W = 320;
const H = 112;
const PAD = { top: 10, right: 10, bottom: 20, left: 32 };

/**
 * Band edges from the contract (low 0-39, elevated 40-69, high 70-100). Scores are
 * whole numbers, so the color changes halfway between 69 and 70, and 39 and 40.
 */
const EDGE_HIGH = 69.5;
const EDGE_ELEVATED = 39.5;

type Tone = "low" | "elevated" | "high";
const toneOf = (score: number): Tone => (score >= 70 ? "high" : score >= 40 ? "elevated" : "low");

/**
 * Risk over the call, in the ring's colors: the line is teal while low, amber while
 * elevated, red while high. One vertical gradient with hard stops at the band edges
 * does it, so a jump from 30 to 80 changes color exactly where it crosses 40 and 70.
 */
function RiskTrend({ history, startedAt }: { history: ScorePoint[]; startedAt: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const uid = useId().replace(/:/g, "");
  if (history.length < 2) {
    return <p className="trend-empty">The risk trend appears once the score starts moving.</p>;
  }

  const t0 = Math.min(startedAt, history[0].ts);
  const t1 = Math.max(history[history.length - 1].ts, t0 + 30_000);
  const x = (ts: number) => PAD.left + ((ts - t0) / (t1 - t0)) * (W - PAD.left - PAD.right);
  const y = (v: number) => PAD.top + (1 - v / 100) * (H - PAD.top - PAD.bottom);
  const top = y(100);
  const bottom = y(0);
  const at = (v: number) => (y(v) - top) / (bottom - top); // gradient offset for a score

  // Step line: a score holds its value until the next update.
  let line = `M${x(history[0].ts)},${y(history[0].score)}`;
  for (let i = 1; i < history.length; i++) line += `H${x(history[i].ts)}V${y(history[i].score)}`;
  const last = history[history.length - 1];
  const area = `${line}H${x(last.ts)}V${bottom}H${x(history[0].ts)}Z`;

  const hovered = hover === null ? null : history[hover];

  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    let best = 0;
    for (let i = 0; i < history.length; i++) if (x(history[i].ts) <= px) best = i;
    setHover(best);
  };

  // Hard stops: each band is a solid run of its color, no blending between bands.
  const stops = (
    <>
      <stop offset={0} className="stop-high" />
      <stop offset={at(EDGE_HIGH)} className="stop-high" />
      <stop offset={at(EDGE_HIGH)} className="stop-elevated" />
      <stop offset={at(EDGE_ELEVATED)} className="stop-elevated" />
      <stop offset={at(EDGE_ELEVATED)} className="stop-low" />
      <stop offset={1} className="stop-low" />
    </>
  );

  return (
    <figure className="trend">
      <figcaption>Risk over the call</figcaption>
      <div className="trend-wrap">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label={`Risk over the call, now ${last.score}, peak ${Math.max(...history.map((p) => p.score))}`}
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
        >
          <defs>
            <linearGradient id={`trend-stroke-${uid}`} gradientUnits="userSpaceOnUse" x1={0} x2={0} y1={top} y2={bottom}>
              {stops}
            </linearGradient>
            <linearGradient id={`trend-fill-${uid}`} gradientUnits="userSpaceOnUse" x1={0} x2={0} y1={top} y2={bottom}>
              {stops}
            </linearGradient>
          </defs>

          <line className="trend-grid" x1={PAD.left} x2={W - PAD.right} y1={top} y2={top} />
          <line className="trend-grid" x1={PAD.left} x2={W - PAD.right} y1={bottom} y2={bottom} />
          <line className="trend-threshold trend-threshold-high" x1={PAD.left} x2={W - PAD.right} y1={y(70)} y2={y(70)} />
          <line className="trend-threshold trend-threshold-elevated" x1={PAD.left} x2={W - PAD.right} y1={y(40)} y2={y(40)} />
          {[0, 40, 70, 100].map((v) => (
            <text key={v} className="trend-axis" x={PAD.left - 6} y={y(v) + 4} textAnchor="end">
              {v}
            </text>
          ))}
          <text className="trend-axis" x={PAD.left} y={H - 4}>
            {clock(0)}
          </text>
          <text className="trend-axis" x={W - PAD.right} y={H - 4} textAnchor="end">
            {clock(t1 - t0)}
          </text>

          <path className="trend-area" d={area} fill={`url(#trend-fill-${uid})`} />
          <path className="trend-line" d={line} stroke={`url(#trend-stroke-${uid})`} />
          <circle className={`trend-dot trend-dot-${toneOf(last.score)}`} cx={x(last.ts)} cy={y(last.score)} r={4.5} />
          {hovered && (
            <g>
              <line className="trend-cross" x1={x(hovered.ts)} x2={x(hovered.ts)} y1={top} y2={bottom} />
              <circle className={`trend-dot trend-dot-${toneOf(hovered.score)}`} cx={x(hovered.ts)} cy={y(hovered.score)} r={4.5} />
            </g>
          )}
        </svg>
        {hovered && (
          <div className="trend-tip" style={{ left: `${(x(hovered.ts) / W) * 100}%` }}>
            <strong>{hovered.score}</strong> at {clock(hovered.ts - t0)}
          </div>
        )}
      </div>
    </figure>
  );
}
