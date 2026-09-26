// rules-classifier (docs/module-contracts.md §3.4).
//
// Pure function: no I/O, no event bus access, no mutation of the input, no
// reliance on time or randomness. The orchestrator calls `runRules` once per
// final transcript segment and wraps the result in a `RulesHitsEvent` —
// that wrapping is not this module's job.

import type { RuleHit, Speaker } from "@guardian-loop/shared-types";
import { findPatternMatches, tokenize } from "./matcher";
import { RULES } from "./rules";

export type { RuleHit } from "@guardian-loop/shared-types";

export function runRules(input: { speaker: Speaker; text: string }): RuleHit[] {
  const tokens = tokenize(input.text);
  const hits: RuleHit[] = [];
  const seen = new Set<string>();

  for (const rule of RULES) {
    if (rule.speaker !== input.speaker) continue;

    for (const pattern of rule.patterns) {
      for (const span of findPatternMatches(tokens, pattern)) {
        const key = `${rule.id}:${span.start}:${span.end}`;
        if (seen.has(key)) continue;
        seen.add(key);

        hits.push({
          ruleId: rule.id,
          signal: rule.signal,
          weight: rule.weight,
          match: input.text.slice(span.start, span.end),
          start: span.start,
          end: span.end,
        });
      }
    }
  }

  return hits;
}
