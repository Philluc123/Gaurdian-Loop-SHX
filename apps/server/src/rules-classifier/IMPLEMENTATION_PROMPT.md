# Prompt: implement `rules-classifier`

Paste this whole file as your task prompt in a fresh session (or read it yourself
before starting). It is self-contained — you shouldn't need to ask the user
anything to finish the module.

## Context

Guardian Loop is a real-time scam-call detection pipeline (see the repo root
`README.md` and `docs/module-contracts.md`). You're implementing one isolated,
pure-function module: `apps/server/src/rules-classifier`. Full contract:
`docs/module-contracts.md` §3.4, mirrored in
[`apps/server/src/rules-classifier/README.md`](./README.md).

A test suite already exists at
[`apps/server/src/rules-classifier/rules-classifier.test.ts`](./rules-classifier.test.ts).
It currently fails to even resolve, because `./index.ts` doesn't exist yet.
**Your job is to make every test in that file pass, without editing the test
file**, by creating the implementation files described below. If you genuinely
believe a test encodes the wrong behavior, say so and propose a change rather
than silently editing it.

## What you're building

```ts
function runRules(input: { speaker: Speaker; text: string }): RuleHit[];

interface RuleHit {
  ruleId: string;      // e.g. "payment.gift_card" — see namespace convention below
  signal: Signal;
  weight: number;       // points this hit contributes; see weight scale below
  match: string;        // the matched substring, exactly as it appears in `text`
  start: number;         // character offset into `text` where `match` begins
  end: number;           // character offset into `text` where `match` ends
}
```

`Speaker` (`"caller" | "victim"`) and `Signal` (the 10-value union) already exist
in `@guardian-loop/shared-types` — import them from there, don't redefine them.
`RuleHit` does **not** exist in shared-types yet; define it in this module and
export it from `index.ts` (the test file imports it from `./index`).

This function must be pure: no I/O, no event bus access, no mutation of the
input, no reliance on time or randomness. It runs once per final transcript
segment; the orchestrator calls it and wraps the result in a `RulesHitsEvent` —
that wrapping is *not* this module's job.

## Locked-in design decisions

These were decided with the user already — don't re-litigate them:

1. **Strict per-signal speaker gating.** Every rule belongs to exactly one
   speaker. Caller-side signals (`IMPERSONATION`, `URGENCY`, `SECRECY`,
   `UNTRACEABLE_PAYMENT`, `REMOTE_ACCESS`, `CREDENTIAL_REQUEST`, `THREAT`) only
   ever fire when `input.speaker === "caller"`. Victim-side signals
   (`VICTIM_COMPLIANCE`, `VICTIM_DISCLOSURE`, `VICTIM_RESISTANCE`) only ever
   fire when `input.speaker === "victim"`. If a rule's pattern matches but the
   speaker doesn't match, produce **no hit at all** for that rule — don't emit
   it with a flag, just skip it. See the "speaker scoping" describe block in
   the test file for the exact cases this must satisfy.
2. **Matching is case-insensitive** and tolerant of the specific ASR
   (speech-to-text) transcription errors listed below — these are real
   documented mis-transcriptions, not hypothetical ones.
3. **Offsets are into the original `text` as given**, not into any
   lowercased/normalized copy — `text.slice(hit.start, hit.end)` must equal
   `hit.match` (case-insensitively; the test checks this exactly). Do your
   matching on a lowercased copy if that's easier, but map offsets back to the
   original string before returning.

## Rule taxonomy and `ruleId` namespace convention

One `ruleId` prefix (namespace) per signal, matching what the test file
asserts via `ruleIdPrefix`:

| Signal | Speaker | `ruleId` prefix | Example patterns to seed |
|---|---|---|---|
| `IMPERSONATION` | caller | `impersonation.` | claims to be Social Security/Medicare/IRS, a bank, tech support, police, a utility company, a family member in trouble |
| `URGENCY` | caller | `urgency.` | "right now", "today only", "before it's too late", artificial deadlines, "don't hang up" |
| `SECRECY` | caller | `secrecy.` | "don't tell your [family member]", "keep this between us", "confidential" |
| `UNTRACEABLE_PAYMENT` | caller | `payment.` | gift cards (Google Play, Amazon, Steam, Target...), wire transfer, cryptocurrency, Western Union/MoneyGram, cash by mail |
| `REMOTE_ACCESS` | caller | `remote_access.` | AnyDesk, TeamViewer, "let me access/control your computer", "download this app" |
| `CREDENTIAL_REQUEST` | caller | `credential.` | password, PIN, one-time passcode/verification code, full SSN, bank login |
| `THREAT` | caller | `threat.` | arrest, warrant, lawsuit, account frozen, jail, deportation |
| `VICTIM_COMPLIANCE` | victim | `victim_compliance.` | agreeing to go buy/wire/send something the caller demanded, "I'm on my way to the store" |
| `VICTIM_DISCLOSURE` | victim | `victim_disclosure.` | reading out an SSN, card number, PIN, or one-time code |
| `VICTIM_RESISTANCE` | victim | `victim_resistance.` | naming it a scam, refusing, saying they'll verify independently/hang up and call back |

Seed at least 2–3 distinct `ruleId`s per signal (e.g. `payment.gift_card`,
`payment.wire_transfer`, `payment.cryptocurrency` all under `UNTRACEABLE_PAYMENT`).
The test file only asserts on the signal + prefix, so the exact `ruleId`
suffixes are your call — pick descriptive snake_case names.

## Known ASR transcription errors to handle

The test suite bakes these in (they're realistic, not made up for the test):

- "gift card" → "gift cart"
- "Medicare" → "Medicaire"
- "arrested" → "arested"
- "TeamViewer" → "Team Viewer" (split into two words)
- "confidential" → "confidencial"
- "minutes" → "minuts"
- "believe" → "beleive"

Don't hardcode a special case per typo string — build patterns that tolerate
this class of error in general (e.g. an edit-distance-tolerant match, or a
small alternation list of known variants per key term) since more will turn up
as real fixture calls get transcribed. At minimum, the specific variants above
must match.

## Weight scale

There's no fixed scale mandated by the contract — this module owns it. Use
this as the default (documented here so score-engine's combo/threshold logic,
built separately, can calibrate against something known):

- Weak/ambiguous-alone signals (`URGENCY`, `SECRECY`, `VICTIM_RESISTANCE`): **10–15**
- Strong, fairly unambiguous signals (`IMPERSONATION`, `THREAT`,
  `VICTIM_COMPLIANCE`): **20–25**
- High-severity, hard-to-explain-innocently signals (`UNTRACEABLE_PAYMENT`,
  `REMOTE_ACCESS`, `CREDENTIAL_REQUEST`, `VICTIM_DISCLOSURE`): **30–40**

Every `RuleHit.weight` must be a positive number (the test enforces `> 0`).
This module does **not** need to guarantee any particular combined score or
threshold crossing on its own — that arithmetic (combos, decay, floor) belongs
to `score-engine` (§3.6), built separately. Don't try to solve that here.

## Files to create

- `apps/server/src/rules-classifier/index.ts` — exports `runRules` and the
  `RuleHit` interface. This is the only file other modules should import from.
- `apps/server/src/rules-classifier/rules.ts` — the actual rule table (data:
  ruleId, signal, speaker, weight, and however you represent the pattern —
  e.g. a `RegExp` or a small list of literal/variant strings per rule). Keep
  this data-driven so adding a rule is "add a row," not "write new logic."
- Anything else you need (e.g. a small ASR-tolerant matching helper) — keep it
  local to this folder; nothing here should import from other modules under
  `apps/server/src` or touch the event bus.

## Non-goals (do not do these)

- Don't touch the event bus, don't import the orchestrator, don't wrap the
  result in a `RulesHitsEvent` — that's the orchestrator's job.
- Don't add `RuleHit` to `packages/shared-types` — keep it local to this
  module for now (per the TODO at the bottom of
  `packages/shared-types/src/index.ts`, that migration happens later, as a
  separate deliberate step, not as a side effect of this task).
- Don't edit `rules-classifier.test.ts`. Add *new* test cases there as you add
  rules (the README explicitly asks for this — "this suite is also the best
  documentation of what the rules catch") but don't change the existing
  assertions to make them pass.

## How to verify you're done

From `apps/server`:

```
npx vitest run src/rules-classifier
```

All tests in `rules-classifier.test.ts` must pass. Then:

```
npm run typecheck --workspace=@guardian-loop/server
```

must also pass with no errors. When both are green, the module meets the
contract's "Done when" criterion.
