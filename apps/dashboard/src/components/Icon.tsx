// One drawn icon set: 24px grid, 1.75 stroke, round caps and joins. Replaces every
// emoji and unicode glyph the dashboard used to show, so icons share one weight.

import type { RiskLevel } from "@guardian-loop/shared-types";

const PATHS = {
  checkCircle: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM8.5 12.5l2.5 2.5 4.5-5",
  alertCircle: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM12 7.5v5.25M12 16.25v.25",
  alertTriangle: "M10.3 4.2 2.6 17.5A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0ZM12 9.5v4.25M12 17v.25",
  bell: "M6 9.5a6 6 0 0 1 12 0c0 5 2 6.5 2 6.5H4s2-1.5 2-6.5ZM10 19.5a2.2 2.2 0 0 0 4 0",
  bellOff: "M6 9.5c0 5-2 6.5-2 6.5h12.5M18 13.5c-.02-1.2-.02-2.5 0-4a6 6 0 0 0-9.7-4.7M10 19.5a2.2 2.2 0 0 0 4 0M3 3l18 18",
  sun: "M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM12 2.5v2M12 19.5v2M4.6 4.6 6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4",
  moon: "M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z",
  monitor: "M3.5 5.5h17a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-17a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1ZM9 21h6M12 17.5V21",
  phone: "M5 3.5h3l1.5 4.5-2 1.5a11 11 0 0 0 5 5l1.5-2 4.5 1.5v3a2 2 0 0 1-2.2 2A16.5 16.5 0 0 1 3 5.7 2 2 0 0 1 5 3.5Z",
  arrowRight: "M5 12h14M13 6l6 6-6 6",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 20, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      className={className ? `icon ${className}` : "icon"}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}

/** Each risk level gets its own shape, so level never depends on color alone. */
const LEVEL_ICON: Record<RiskLevel, IconName> = {
  low: "checkCircle",
  elevated: "alertCircle",
  high: "alertTriangle",
};

export function LevelIcon({ level, size }: { level: RiskLevel; size?: number }) {
  return <Icon name={LEVEL_ICON[level]} size={size} />;
}
