import { useState, type PointerEvent } from "react";
import type { RiskLevel, Signal } from "@guardian-loop/shared-types";
import { LEVEL_ICON, LEVEL_LABEL, SIGNAL_LABEL, clock, signalTone } from "../format";
import type { ScorePoint } from "../state";

interface Props {
  score: number;
  level: RiskLevel;
  reason: string;
  signals: Signal[];
  history: ScorePoint[];
  startedAt: number;
}

// Level bands from the contract (RiskLevel: 0-39, 40-69, 70-100); drawn, not computed.
const BANDS = [40, 70];

export function ScoreGauge({ score, level, reason, signals, history, startedAt }: Props) {
  return (
    <section className={`card gauge level-${level}`} aria-label="Scam risk">
      <header className="card-head">
        <h2>Scam risk</h2>
        <span className={`level-badge level-${level}`}>
          <span aria-hidden="true">{LEVEL_ICON[level]}</span> {LEVEL_LABEL[level]}
        </span>
      </header>

      <div className="gauge-hero">
        <span className="hero-figure">{score}</span>
        <span className="hero-unit">/ 100</span>
      </div>

      <div
        className="meter"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={score}
        aria-label="Risk score"
      >
        <div className="meter-fill" style={{ width: `${score}%` }} />
        {BANDS.map((b) => (
          <div key={b} className="meter-band" style={{ left: `${b}%` }} />
        ))}
      </div>
      <div className="meter-scale" aria-hidden="true">
        <span>0</span>
        <span style={{ left: "40%" }}>40</span>
        <span style={{ left: "70%" }}>70</span>
        <span>100</span>
      </div>

      <p className="gauge-reason">{reason || "No warning signs yet."}</p>

      {signals.length > 0 && (
        <ul className="signal-list" aria-label="Signals detected">
          {signals.map((s) => (
            <li key={s} className={`chip chip-${signalTone(s)}`}>
              {SIGNAL_LABEL[s]}
            </li>
          ))}
        </ul>
      )}

      <Sparkline history={history} startedAt={startedAt} />
    </section>
  );
}

const W = 320;
const H = 88;
const PAD = { top: 6, right: 6, bottom: 16, left: 22 };

function Sparkline({ history, startedAt }: { history: ScorePoint[]; startedAt: number }) {
  const [hover, setHover] = useState<number | null>(null);
  if (history.length < 2) return null;

  const t0 = Math.min(startedAt, history[0].ts);
  const t1 = Math.max(history[history.length - 1].ts, t0 + 30_000);
  const x = (ts: number) => PAD.left + ((ts - t0) / (t1 - t0)) * (W - PAD.left - PAD.right);
  const y = (v: number) => PAD.top + (1 - v / 100) * (H - PAD.top - PAD.bottom);

  // Step line: a score holds its value until the next update.
  let d = `M${x(history[0].ts)},${y(history[0].score)}`;
  for (let i = 1; i < history.length; i++) d += `H${x(history[i].ts)}V${y(history[i].score)}`;

  const last = history[history.length - 1];
  const hovered = hover === null ? null : history[hover];

  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    let best = 0;
    for (let i = 0; i < history.length; i++) if (x(history[i].ts) <= px) best = i;
    setHover(best);
  };

  return (
    <figure className="spark">
      <figcaption>Score over the call</figcaption>
      <div className="spark-wrap">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label={`Score history, now ${last.score}`}
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
        >
          {[0, ...BANDS, 100].map((v) => (
            <g key={v}>
              <line className={v === 70 ? "spark-threshold" : "spark-grid"} x1={PAD.left} x2={W - PAD.right} y1={y(v)} y2={y(v)} />
              <text className="spark-axis" x={PAD.left - 4} y={y(v) + 3} textAnchor="end">
                {v}
              </text>
            </g>
          ))}
          <text className="spark-axis" x={PAD.left} y={H - 3}>
            {clock(0)}
          </text>
          <text className="spark-axis" x={W - PAD.right} y={H - 3} textAnchor="end">
            {clock(t1 - t0)}
          </text>
          <path className="spark-line" d={d} />
          <circle className="spark-dot" cx={x(last.ts)} cy={y(last.score)} r={4} />
          {hovered && (
            <g>
              <line className="spark-cross" x1={x(hovered.ts)} x2={x(hovered.ts)} y1={PAD.top} y2={H - PAD.bottom} />
              <circle className="spark-dot" cx={x(hovered.ts)} cy={y(hovered.score)} r={4} />
            </g>
          )}
        </svg>
        {hovered && (
          <div className="spark-tip" style={{ left: `${(x(hovered.ts) / W) * 100}%` }}>
            <strong>{hovered.score}</strong> at {clock(hovered.ts - t0)}
          </div>
        )}
      </div>
    </figure>
  );
}
