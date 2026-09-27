// rules-classifier (docs/module-contracts.md §3.4).
//
// Pure function: no I/O, no event bus access, no mutation of the input, no
// reliance on time or randomness. The orchestrator calls `runRules` once per
// transcript segment and wraps the result in a `RulesHitsEvent` — that
// wrapping is not this module's job.
//
// `previousText` is the same speaker's previous line. Speech-to-text splits
// sentences at pauses ("…hand me your" | "Social Security number"), so a phrase
// can straddle two segments. Matches that do are reported on this segment, with
// offsets clipped to its text; matches wholly inside the previous line were
// already reported when it arrived.

import type { RuleHit, Speaker } from "@guardian-loop/shared-types";
import { findPatternMatches, tokenize } from "./matcher";
import { RULES, type Rule } from "./rules";

export type { RuleHit } from "@guardian-loop/shared-types";

export function runRules(input: { speaker: Speaker; text: string; previousText?: string }): RuleHit[] {
  const hits: RuleHit[] = [];
  const seen = new Set<string>();
  const add = (rule: Rule, start: number, end: number) => {
    const key = `${rule.id}:${start}:${end}`;
    if (seen.has(key)) return;
    seen.add(key);
    hits.push({
      ruleId: rule.id,
      signal: rule.signal,
      weight: rule.weight,
      match: input.text.slice(start, end),
      start,
      end,
    });
  };

  const tokens = tokenize(input.text);
  const prev = input.previousText?.trim();
  // The previous line is joined with a newline; its length is where this line starts.
  const offset = prev ? prev.length + 1 : 0;
  const joinedTokens = prev ? tokenize(`${prev}\n${input.text}`) : [];

  for (const rule of RULES) {
    if (rule.speaker !== input.speaker) continue;

    for (const pattern of rule.patterns) {
      for (const span of findPatternMatches(tokens, pattern)) add(rule, span.start, span.end);
      if (!prev) continue;
      for (const span of findPatternMatches(joinedTokens, pattern)) {
        if (span.start < offset && span.end > offset) add(rule, 0, span.end - offset);
      }
    }
  }

  return hits;
}
