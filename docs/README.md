# Docs

- [`module-contracts.md`](module-contracts.md) — **source of truth.** Every event
  shape, function signature, and "done when" criterion for every module. If code and
  this doc disagree, the doc wins until someone updates both in the same PR.

Add architecture decision records here as `docs/adr-NNNN-short-title.md` when the
team makes a call that isn't obvious from the code (e.g. "why MongoDB and not
Postgres", "why an in-process bus and not a message queue").
