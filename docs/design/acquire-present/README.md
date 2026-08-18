# Acquire/present split — divergence proof harness

Supporting material for the Snapshot Engine Contracts design:

- iOS conformance + canonical contract statements (C1–C6): #1797
- Android conformance audit + combined before/after architecture: #1832

`divergence-proof.ts` is the executable model behind the evidence numbers quoted in #1797.
It transcribes the two `-i`/hittable interpretation policies shipped at HEAD (3020195) and the
amended single-presentation design (v5), then checks, over a realistic checkout screen and
1,000 randomized trees:

- **P1** — the shipped policies diverge on identical raw input (interpretation-caused).
- **P2** — the single presentation cannot diverge on identical input; `interactive ⊆ raw`
  holds; the raw projection is unpruned; every daemon-centered hit point lands inside the
  emitted (effective) rect; the cumulative-clip invariant holds.
- **P2b** — fact-availability neutrality: the same tree with and without native hit-test
  facts yields identical membership and derived fields.
- **P3** — with genuinely different raw trees, every output difference attributes 1:1 to a
  raw input difference; interpretation contributes zero.

Run:

```sh
node --experimental-strip-types docs/design/acquire-present/divergence-proof.ts
```

This is a model of the design, not the production code path; the live acceptance test is the
fixture/nightly differential described in #1797's migration step 4.
