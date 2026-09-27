import type { RiskLevel, Signal } from "@guardian-loop/shared-types";
import { LEVEL_LABEL, SIGNAL_LABEL, signalTone } from "../format";
import { LevelIcon } from "./Icon";

interface Props {
  score: number;
  level: RiskLevel;
  reason: string;
  signals: Signal[];
  /** No call to show yet: an empty ring that explains what will appear. */
  idle?: boolean;
  idleTitle?: string;
  idleText?: string;
}

// Geometry in viewBox units. The arc starts at 12 o'clock and runs clockwise.
const SIZE = 232;
const R = 92;
const STROKE = 16;
const C = 2 * Math.PI * R;

/** Level bands from the contract (low 0-39, elevated 40-69, high 70-100), drawn as notches. */
const BANDS = [40, 70];

/** A tick just outside the ring, so the band edges show without breaking the arc. */
function notch(pct: number) {
  const angle = (pct / 100) * 2 * Math.PI - Math.PI / 2;
  const inner = R + STROKE / 2 + 3;
  const outer = R + STROKE / 2 + 10;
  const c = SIZE / 2;
  return {
    x1: c + inner * Math.cos(angle),
    y1: c + inner * Math.sin(angle),
    x2: c + outer * Math.cos(angle),
    y2: c + outer * Math.sin(angle),
  };
}

/** Reasons arrive lowercase ("impersonation + ..."); a headline line starts with a capital. */
function sentence(text: string): string {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

export function RiskHero({ score, level, reason, signals, idle, idleTitle, idleText }: Props) {
  const shown = idle ? 0 : Math.max(0, Math.min(100, score));
  const offset = C * (1 - shown / 100);

  return (
    <section className={`hero level-${idle ? "idle" : level}`} aria-labelledby="hero-title">
      <h1 id="hero-title" className="hero-title">
        Scam risk
      </h1>

      <div
        className="ring"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={shown}
        aria-valuetext={idle ? "No call in progress" : `${shown} out of 100, ${LEVEL_LABEL[level]}`}
      >
        <svg viewBox={`0 0 ${SIZE} ${SIZE}`} aria-hidden="true">
          <circle className="ring-track" cx={SIZE / 2} cy={SIZE / 2} r={R} strokeWidth={STROKE} />
          <circle
            className="ring-arc"
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={R}
            strokeWidth={STROKE}
            strokeDasharray={C}
            strokeDashoffset={offset}
            transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
          />
          {BANDS.map((b) => (
            <line key={b} className="ring-notch" {...notch(b)} />
          ))}
        </svg>
        <div className="ring-center">
          {idle ? (
            <span className="ring-idle">No call</span>
          ) : (
            <>
              <span className="ring-score">{shown}</span>
              <span className="ring-of">out of 100</span>
            </>
          )}
        </div>
      </div>

      {idle ? (
        <div className="hero-copy">
          <p className="hero-level hero-level-idle">{idleTitle}</p>
          <p className="hero-reason">{idleText}</p>
        </div>
      ) : (
        <div className="hero-copy">
          <p className="hero-level">
            <LevelIcon level={level} size={22} />
            {LEVEL_LABEL[level]}
          </p>
          <p className="hero-reason">{sentence(reason) || "No warning signs so far."}</p>
          {signals.length > 0 && (
            <ul className="signals" aria-label="Warning signs detected">
              {signals.map((s) => (
                <li key={s} className={`signal signal-${signalTone(s)}`}>
                  {SIGNAL_LABEL[s]}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
