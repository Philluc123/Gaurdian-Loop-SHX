// Gemini response schema and defensive parsing.
//
// The response schema makes Gemini emit the raw JSON shape from
// docs/module-contracts.md §3.5, but we still validate everything: the model
// can be wrong, and the transcript it reads is attacker-controlled. Parsing
// never throws — it returns null and the caller falls back to `llm_error`.

import type { Signal } from "@guardian-loop/shared-types";

export const SIGNALS: readonly Signal[] = [
  "IMPERSONATION",
  "URGENCY",
  "SECRECY",
  "UNTRACEABLE_PAYMENT",
  "REMOTE_ACCESS",
  "CREDENTIAL_REQUEST",
  "THREAT",
  "VICTIM_COMPLIANCE",
  "VICTIM_DISCLOSURE",
  "VICTIM_RESISTANCE",
];

const SIGNAL_SET = new Set<string>(SIGNALS);

export const MAX_REASON_CHARS = 120;
export const MAX_CARRY_CHARS = 160;

// Passed to Gemini as `responseJsonSchema`.
export const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    signals: {
      type: "array",
      items: { type: "string", enum: [...SIGNALS] },
      description: "Scam signals present in the transcript window. Empty if none.",
    },
    score: {
      type: "integer",
      minimum: 0,
      maximum: 100,
      description: "Overall likelihood (0-100) that this call is a scam.",
    },
    benign_context: {
      type: "boolean",
      description: "True if context indicates a legitimate call.",
    },
    reason: {
      type: "string",
      description: "One line, max 15 words, explaining the score.",
    },
    carry_context: {
      type: "string",
      description: "One-line factual memory of the call so far for the next evaluation.",
    },
  },
  required: ["signals", "score", "benign_context", "reason", "carry_context"],
  propertyOrdering: ["signals", "score", "benign_context", "reason", "carry_context"],
} as const;

export interface ParsedLLMOutput {
  signals: Signal[];
  score: number;
  benignContext: boolean;
  reason: string;
  carryContext: string;
}

export function parseLLMOutput(raw: string | undefined): ParsedLLMOutput | null {
  if (!raw) return null;

  let data: unknown;
  try {
    data = JSON.parse(stripCodeFence(raw));
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const o = data as Record<string, unknown>;

  if (!Array.isArray(o.signals)) return null;
  if (typeof o.score !== "number" || !Number.isFinite(o.score)) return null;
  if (typeof o.benign_context !== "boolean") return null;
  if (typeof o.reason !== "string") return null;
  if (typeof o.carry_context !== "string") return null;

  // Unknown signals are dropped rather than failing the whole result.
  const signals = [
    ...new Set(o.signals.filter((s): s is Signal => typeof s === "string" && SIGNAL_SET.has(s))),
  ];

  return {
    signals,
    score: Math.round(Math.min(100, Math.max(0, o.score))),
    benignContext: o.benign_context,
    reason: oneLine(o.reason, MAX_REASON_CHARS),
    carryContext: oneLine(o.carry_context, MAX_CARRY_CHARS),
  };
}

function stripCodeFence(s: string): string {
  const m = s.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return m ? m[1] : s;
}

function oneLine(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1).trimEnd() + "…" : flat;
}
