# packages/shared-types/src

`index.ts` holds every exported type. See [`../README.md`](../README.md) for the rule
on changing it (add here + update `docs/module-contracts.md` in the same PR, flag it
to the team). Don't split this into multiple files unless it grows large enough to
need it — right now, one file that's easy to diff and review beats several small ones.
