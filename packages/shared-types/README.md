# @guardian-loop/shared-types

**Owner:** shared across all workstreams — no single person owns this, everyone
maintains it together.

The contracts every other package/app imports: `CallId`, `Speaker`, `Signal`,
`RiskLevel`, `Guardian`, `Turn`, and (as they stabilize) every event interface in
[`docs/module-contracts.md`](../../docs/module-contracts.md) section 2–3.

## The one rule

**Nobody redefines these types locally.** If your module needs a new field or a new
event shape:

1. Add it here first.
2. Update `docs/module-contracts.md` to match, in the same PR.
3. Say so in the team channel before other people build on it — this package is the
   one place a silent change breaks everyone at once.

## Using it

From `apps/server` or `apps/dashboard`:

```ts
import type { CallId, Signal, RiskLevel, Turn } from "@guardian-loop/shared-types";
```

## Done when

There is no `interface`/`type` declaration anywhere else in the repo that duplicates
something defined here. If you find one, replace it with an import.
