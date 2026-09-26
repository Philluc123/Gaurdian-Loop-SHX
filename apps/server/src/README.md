# apps/server/src

`index.ts` is the composition root (wires modules together, starts listeners). Every
other folder here is one module, each owned by the workstream in the table in
[`../README.md`](../README.md). Full contracts for each are in
[`docs/module-contracts.md`](../../../docs/module-contracts.md).

Don't add code directly in this folder besides `index.ts` — everything else belongs in
a module subfolder, and cross-module communication goes through `event-bus/`, never
direct imports between module folders.
