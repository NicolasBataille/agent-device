# Acquire/present split — divergence model harness

Supporting material for the Snapshot Engine Contracts design:

- iOS conformance + canonical contract statements (C1–C6): #1797
- Android conformance audit + combined before/after architecture: #1832

`divergence-proof.ts` is the executable **model** behind the evidence numbers quoted in #1797.
It transcribes the two `-i`/hittable interpretation policies shipped at HEAD (3020195) and the
amended single-presentation design, then checks these model obligations over a realistic
checkout screen and 1,000 randomized trees (including zero-frame and one-axis-degenerate
frames, per CGRect emptiness semantics):

- **P1** — the shipped policies diverge on identical raw input (interpretation-caused).
- **P2** — the single regular projection cannot diverge on identical input; `interactive ⊆ raw`
  holds; the raw projection is unpruned; every daemon-centered hit point lands inside the
  emitted (effective) rect; the cumulative-clip invariant holds; no evidence field is
  serialized.
- **P2b** — fact-availability neutrality (C1): the same tree with and without native hit-test
  facts yields identical membership and derived fields.
- **P3** — with deliberately different raw trees (an AX-only merged-card leaf, a tree-only nav
  button, asymmetric hit-test facts) and with randomized single-node mutations, every presented
  delta is attributable to an owning raw-input delta; interpretation contributes zero
  unattributed differences.

The script prints a **contract coverage table** stating exactly which contracts it exercises
and which it cannot (C2 hint conservatism and C5 deadline/whole-tier discard need real
adapters and the capture-plan loop). Its verdict is labeled `MODEL OBLIGATIONS PASS`
deliberately: this is executable design evidence, not a proof of the production path. The live
acceptance test is the fixture/nightly differential described in #1797's migration step 4.

Membership modeled here is `interactive-type OR content` (external review pass 3, finding 3):
geometric actionability feeds only the emitted `hittable` field, never membership. This is an
intentional delta vs the shipped tree policy's "hittable-non-other" branch, reviewed as part
of migration step 3.

Run:

```sh
node --experimental-strip-types docs/design/acquire-present/divergence-proof.ts
```
