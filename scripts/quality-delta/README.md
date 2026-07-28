# Quality delta (quiet PR comment + main metric history)

```sh
pnpm repo-health --out .tmp/repo-health.json          # the snapshot this consumes (#1423)
pnpm quality-delta --head .tmp/repo-health.json \
  --history-dir .tmp/history-ref --base-sha <sha> \
  --changed-coverage .tmp/changed-coverage.json \
  --slow-test .tmp/slow-tests.json \
  --markdown .tmp/quality-delta.md                    # comment body + job summary

pnpm repo-health:history --snapshot .tmp/repo-health.json --history-dir <history ref checkout>
```

Issue #1424 (Track C of #1412). Two halves:

1. **History on main** — every push to main appends one repo-health snapshot to a JSONL store.
2. **One quiet PR comment** — the sticky comment `scripts/size-report.mjs` already owned, evolved to
   show only metrics whose delta against that main baseline crosses a threshold.

The maintainer requirement is the design constraint: **do not drown people in information.** A PR
where nothing crossed gets exactly one line — `No notable quality deltas.` — and no table at all.

## What earns a row

Every candidate metric, its threshold, and the gate that owns it live in one config block,
[`thresholds.ts`](./thresholds.ts). Nothing else hard-codes a number: `model.ts` compares and
renders, `run.ts` does I/O. Two kinds of metric:

- **Delta metrics** (size bytes, R6/R9 ratchets, fallow suppressions, redundant graph edges) are
  compared against the main baseline and shown when `|delta| >= minAbsDelta`. Ratchet-style metrics
  can be `worseOnly`, so removing a suppression stays silent.
- **PR-local metrics** (changed-line and changed-branch coverage, changed lines excluded from
  coverage, slow-test budget breaches) have no baseline by construction — they are defined against
  the diff or the run — so they are scored against a bound. The coverage bound is the gate's own
  threshold (`CHANGED_LINE_COVERAGE_THRESHOLD`) plus a margin, so approaching the gate costs one
  quiet line instead of a surprise failure next commit.

Every row links the file that owns the number and names the command that reproduces it
(`Gate · fix`). `thresholds.test.ts` enumerates the config and fails if a row's path does not exist
or its fix is not a real package script — a dead link in a PR comment is worse than no comment.

Nothing here gates. The comment is a report; the gates it points at keep their own thresholds.

## The line budget

`MAX_COMMENT_LINES` (20, marker line included) is a hard cap. When more rows cross than fit, the
least severe are dropped from the comment — severity is how many multiples of its own threshold a
row crossed by — and replaced with `+N more, see the job summary`. The job summary always carries
every row plus the notes for inputs that were unavailable.

## Refusals and honesty

- **Schema versions are not diffed.** The snapshot's field names are the delta contract (#1423
  amendment). If the baseline's `schemaVersion` differs from head's, every baseline-derived row is
  dropped and the comment says so; PR-local rows still show. To resume diffing, add a migration note
  under "Schema migrations" below and bump the reader accordingly.
- **Stale inputs are labelled, not laundered.** repo-health proves a read artifact's freshness
  (`provenance.inputs.*.status`) only from a producing commit the artifact stamps in its own bytes.
  A row whose artifact is `stale` renders as `JS gzip (stale artifact)` rather than silently claiming
  to describe the head commit. `unknown` — today's honest answer for every artifact, since no
  producer stamps a commit — gets one job-summary note instead of a caveat on every size and coverage
  row, which is the comment fatigue this comment exists to remove.
- **Missing inputs cost rows, not runs.** No baseline, no size artifact, no coverage JSON — each
  costs the rows it would have produced plus a job-summary note. Fork PRs (read-only token, no
  secrets) therefore degrade to job-summary output: the comment step is skipped, never failed.

## Where the history lives, and why

The store is a **dedicated orphan ref, `metrics/repo-health`**, holding `history/YYYY-MM.jsonl` —
one compact snapshot per line, one file per month.

- *Not an artifact chain*: artifacts expire (90 days, less with retention policy) and are keyed by
  run, not commit, so "what did this metric look like at sha X" becomes an API crawl.
- *Not gh-pages*: that branch is the published website's deploy target; mixing a machine-read data
  store into it couples this to the docs deploy and invites conflicts.
- *An orphan ref* keeps the data out of main's history (no source diff noise, no rebuild triggers),
  is permanent, is fetchable shallowly (`--depth 1`), and is queryable by sha with plain git.

Monthly shards keep a lookup a bounded read: a snapshot serializes to ~11 kB, so a busy month is
about 1 MB rather than an ever-growing single file.

Query one commit:

```sh
git fetch --depth 1 origin +refs/heads/metrics/repo-health:refs/remotes/origin/metrics/repo-health
git show origin/metrics/repo-health:history/2026-07.jsonl | grep "$(git rev-parse HEAD)" | jq .metrics
```

A PR whose exact base sha is not in the store yet falls back to the newest entry — a near baseline
states a real delta; no baseline states nothing — but it is **labelled**: the comment heading reads
`vs nearest main@<sha> (PR base not in history yet)` and the job summary says deltas may include
main-side changes the PR did not make. Only an exact base-sha hit renders as a plain `vs main@<sha>`.

### Serializing concurrent writes

Two merges landing seconds apart must not lose an entry, so the history job uses both mechanisms:

1. A workflow-level `concurrency: { group: repo-health-history, cancel-in-progress: false }` — runs
   queue instead of racing, and a queued run is never cancelled.
2. **Compare-and-swap with one retry** on the ref itself: clone the tip, append, push. A push
   rejected because the ref moved re-runs the whole append against the new tip. Appending is keyed
   by commit sha and is a no-op for a commit already stored, so a retry can never double-write.

## Wiring

| Where | What it does |
| --- | --- |
| `.github/workflows/repo-health-history.yml` | push-to-main: build → `pnpm size:markdown` → snapshot → append to `metrics/repo-health`. Main only; not on the PR gate. |
| `.github/workflows/ci.yml` (Coverage job) | PR: writes the changed-line coverage JSON and slow-test report and uploads them as `quality-delta-inputs`. Does not render or comment. |
| `.github/workflows/size.yml` | still measures base vs head into the job summary, and publishes `size-report-json` instead of posting its own comment. |
| `.github/workflows/quality-delta.yml` | `workflow_run` on **CI and Size**: renders and posts the one sticky comment, after both producers finished. |

### Why rendering is its own workflow

The rows come from two workflows that run **concurrently** on the same head sha. Rendering inside
either one is a race whose loser is permanent: the comment is written once, so a size report that
lands a minute later never reaches it. So the render runs on `workflow_run` for both producers and
[`producers.ts`](./producers.ts) decides readiness — the **last** producer to complete renders, and
earlier firings exit cleanly because the later completion fires the trigger again. A re-run of one
producer supersedes its earlier run.

The same gate answers the other half of "may this run post": the sha must still be the **current head
of an open PR** (`selectRenderTarget`). Workflow concurrency is keyed by head sha and therefore cannot
cancel across heads, so a producer run for an older head could otherwise complete late and replace the
comment with obsolete metrics. A superseded head renders nothing, and the PR number the comment is
posted to comes from that same verified lookup.

A push can also land *after* that gate, while setup, artifact download, and rendering run. So the
write path re-reads the head itself and **fails closed**:

```
node scripts/size-report.mjs --post-comment .tmp/quality-delta.md --expect-head <rendered sha>
```

If the PR's head is no longer that commit — or the lookup does not answer — nothing is written and
the existing comment keeps its newer metrics.

`producers.test.ts` owns both policies, including the assertion that no other workflow contains
`--post-comment`.

Fork PRs are skipped there deliberately: `workflow_run` carries a **write token in the base repo**,
so checking out and installing fork code in it would be a pwn-request. Fork PRs keep the producers'
job summaries, which is the documented degradation.

### One comment, not one bot per metric

The comment reuses `scripts/size-report.mjs --post-comment` and its marker machinery, so a PR keeps
exactly one marker-tracked comment updated in place — size is now one row family inside it, which is
why the marker is `<!-- agent-device-quality-delta -->` rather than the size-specific one it grew out
of. The old marker stays in `LEGACY_COMMENT_MARKERS` so comments posted before the rename are updated
instead of duplicated. `run.test.ts` fails if the marker in `run.ts` and the ones in
`size-report.mjs` drift apart.

## Schema migrations

None yet. `schemaVersion` 1 is the only version the reader has seen. When #1423's schema bumps, add
an entry here saying what moved and how a v1 baseline maps onto it, then teach `model.ts` the
mapping — until then it refuses to diff across versions on purpose.
