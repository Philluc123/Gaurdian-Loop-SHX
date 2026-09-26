# packages

Shared library code consumed by more than one app, as npm workspaces:

- [`shared-types/`](shared-types/README.md) — the event/type contracts every app and
  module imports. Currently the only package; add more here only if code needs to be
  shared across `apps/server` and `apps/dashboard` (or across server modules) without
  duplicating it.
