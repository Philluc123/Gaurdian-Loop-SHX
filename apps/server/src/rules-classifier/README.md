# rules-classifier

**Workstream:** B. Core
**Contract:** [`docs/module-contracts.md`](../../../../docs/module-contracts.md) §3.4

## Owns

The pattern list, weights, and speaker scoping for rule-based signal detection.

## Interface (pure function — no side effects, no bus access)

```ts
function runRules(input: {
  speaker: Speaker;
  text: string;
  previousText?: string;   // same speaker's previous line; phrases split across the two still match
}): RuleHit[];

interface RuleHit {
  ruleId: string;      // e.g. "payment.gift_card"
  signal: Signal;
  weight: number;
  match: string;
  start: number;       // character offsets into `text`, used for dashboard highlighting
  end: number;
}
```

The orchestrator calls `runRules` and publishes the result as a `RulesHitsEvent` —
this module does not touch the event bus itself.

## Why pure

Because it's a pure function, you can build and fully test this module with nothing
else running: no server, no bus, no other module.

## Done when

A unit test suite of scam and legitimate sentences passes, including common
transcription errors (e.g. "gift cart" for "gift card"). Add new test sentences as
you add rules — this suite is also the best documentation of what the rules catch.
