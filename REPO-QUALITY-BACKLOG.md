# Repo-quality backlog (flagged during audit/execution, not scheduled)

1. **Reviewer bot deletes PR head branches mid-review** — #1940's remote branch was deleted while
   review was in flight, auto-closing the PR; the follow-up fix had to land as a new PR (#1951).
   Consider a branch-protection rule preventing head-branch deletion on open PRs.
2. **Merged-with-known-P1 window** — #1940 merged 5 minutes after review, before the scoped fix
   landed; the trailing-value bug lived in main until #1951. If review comments are blocking,
   consider a "changes requested" gate or a fast-follow label discipline.
3. **AGENTS.md prose owned by gates** — the over-budget file list rots (apps.ts went stale). A
   structural lint/gate should own the 300/500/1000 thresholds and emit the list; AGENTS.md links
   to it instead of copying it (docs-ownership rule).
4. **Stale provenance comments in `src/core/command-descriptor/registry.ts`** (~130-133, 214-220)
   narrate deleted tables ("copied VERBATIM from daemon-command-registry") and migration phases;
   replace with one-line ADR pointers.
5. **`test:unit` wall time ~6 min** — fine for now; if tier-5 B5 lands, re-measure startup closure
   and consider sharding the unit bundle.
6. **Agent-tooling hazard (external)**: file-write tools can silently overwrite existing files
   without read-first enforcement — caused the #1939 P0 (deleted test suite caught only by review).
   Not repo-fixable, but worth a repo-level guard: a CI check that test-file count per source module
   never decreases (the ratchet pins sizes but not existence).
7. **`createTtlMemo` lazy-expiry footgun** — default accumulates stale keys in long-lived daemons;
   every new memo must remember `scheduleExpiry: true`. Consider making scheduled expiry the default
   or linting call sites.
