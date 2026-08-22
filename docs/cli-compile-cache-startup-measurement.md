# #1961 measurement: `module.enableCompileCache()` on the CLI bin entry

Decision: **not shipped.** The issue's bar was a warm-run improvement of >=50 ms.

On a warm compile cache the change is a **small but statistically real improvement** on the heavier
routes — -3.6 ms on `--help` and -5.1 ms on the `open` route's CLI-side path — and indistinguishable
from zero on `--version`. That is roughly ten times too small to reach the bar. On a **cold** cache
it is a **regression** of +11 ms (`--help`) to +16 ms (the `open` CLI-side path), the cost of
writing the cache. Every measured interval lies far above the -50 ms ship threshold.

This measurement covers only the **warm OS-page-cache** leg; the cold-page-cache leg the issue also
asked for could not be run here (see "Unmeasured leg" below), which is why this record is *part of*
#1961 rather than closing it.

This doc records the investigation so the question doesn't get re-asked without new information —
see "Why the result differs from the issue's prior micro-benchmark" before re-attempting.

## What was tried

`module.enableCompileCache()` was added as the first statement in `bin/agent-device.mjs`, before
the `node:fs`/`node:path`/`node:url` imports and the dynamic `await import(...)` of the dist bundle:

```js
#!/usr/bin/env node
import { enableCompileCache } from 'node:module';
enableCompileCache();

import { existsSync } from 'node:fs';
// ...
await import(pathToFileURL(distPath).href);
```

The idea (per ADR 0019's "CLI cold-start laziness" goal): `bin/agent-device.mjs` loads `dist/`
through the real Node module loader, unlike Vitest's vite-node evaluation or the layering lane
(where measurement previously showed zero effect — see the issue for that prior finding). V8's
disk compile cache should let repeat invocations skip re-parsing/re-compiling the dist JS.

### API status

`module.enableCompileCache()` was **added in Node v22.8.0** and is **Stability 1.1 – Active
Development** on the v22.x line this repo's `engines` field targets (`node: >=22.12`). It is not
"stable" at the repo minimum. On current Node it has since progressed to Stability 1.2 – Release
candidate (v25.4.0 marked it no longer experimental), but the supported floor is what governs a
shipped change here. With no argument it caches to
`path.join(os.tmpdir(), 'node-compile-cache')`, overridable via the `NODE_COMPILE_CACHE`
environment variable. The cache is disposable and keyed per Node/V8 version and architecture
(observed: `v26.1.0-arm64-<hash>-<uid>/`), so it self-invalidates across Node upgrades.

Verified the cache actually engages, and how much each route writes (wipe the cache, run once,
count entries):

| Route | cache entries written | size |
|---|---:|---:|
| `--version` | 1 | 4 kB |
| `--help` | 51 | 664 kB |
| `open … --platform bogus` (CLI-side path) | 83 | 848 kB |

## Methodology

Node v26.1.0 (repo requires `>=22.12`). The change touches `bin/agent-device.mjs` only, which ships
as source and is not part of the `dist/` bundle, so both arms load a byte-identical `dist/`.
Measured on the rebased branch (dist rebuilt on `03c398406`).

**Metric: elapsed wall-clock.** An earlier revision of this measurement used child CPU time
(`getrusage(RUSAGE_CHILDREN)`) to dodge host-load noise. That was the wrong quantity: the compile
cache trades CPU (parse/compile) against filesystem work (reading and writing cache entries), and
`RUSAGE_CHILDREN` excludes I/O wait, so a CPU-time delta is not comparable to an elapsed-time bar.
All numbers below are elapsed.

Notably, the two metrics now agree on the warm case: the CPU method measured about -3.4 ms on
`--help`, and quiet-host elapsed measurement shows -3.6 ms. An intermediate revision of this doc
measured +0.1 ms elapsed on a busier host and concluded from that pair that the compile cache
"gives all of its CPU saving back as filesystem wait." That conclusion was wrong — it was reading a
noise-masked measurement as a mechanism. Where the two metrics genuinely diverge is the **cold**
case, which CPU time cannot see at all: writing the cache is mostly I/O, and it costs +11 to +16 ms.

**Design.** Both arms are separate copies of the bin entry pointed at the same unchanged `dist/`,
sampled in one interleaved loop with the arm order flipped every iteration. Reported as median plus
a bootstrap 95% CI on the median difference (20,000 resamples), so each conclusion carries an
explicit uncertainty bound instead of a bare point estimate.

**What interleaving does and does not buy.** Alternating arms and flipping their order each
iteration removes *order* bias — neither arm systematically occupies the earlier or later slot, so
a monotonic drift in host load cannot masquerade as an arm difference. It does **not** show that
contention was absorbed: a loaded host still inflates both arms and widens the interval, and
nothing here proves the two arms met identical instantaneous contention. Load is therefore reported
per route rather than as one global claim, and it matters most for the end-to-end `ad open` numbers,
which ran at the highest load and carry by far the widest interval. This host is shared with other
concurrent sessions, so load was not controllable, only observed and recorded.

**Reproducing this.** The harness is retained at `scripts/perf/compile-cache-ab.mjs` and the raw
per-sample elapsed times at `docs/cli-compile-cache-startup-samples.json`, so every median and
bootstrap interval below can be recomputed without re-running anything:

```
node scripts/perf/compile-cache-ab.mjs stats --in docs/cli-compile-cache-startup-samples.json
```

The bootstrap uses a fixed seed, so a recompute reproduces the published intervals exactly. Re-measuring
from scratch is `… bench --runs 120 --mode warm --routes "--version|--help"`. The harness builds
both arms itself from the committed `bin/agent-device.mjs`, so it stays correct if that file changes.

The repo's own convention,
`node scripts/size-report.mjs --startup-runs N` (`pnpm size`, what `.github/workflows/size.yml`
runs base-vs-head on every PR, and the methodology behind ADR-0019's retained startup medians),
measures each build in a separate sequential phase. That is correct on CI's dedicated runners but
could not produce a trustworthy number on this shared dev host: two independent 50-run pairs on the
*same* pair of builds disagreed in sign for `--version` (+8.7 ms one pass, +45.2 ms another) purely
from load drift between the base phase and the current phase. Interleaving within one loop is what
made the difference; it is the same interleaved-A/B shape PR #1681 used for the last CLI startup
change.

### Cache states

- **Warm** — cache pre-populated, steady-state repeat invocation. This is the state the issue's
  ">=50 ms warm-run delta" bar refers to.
- **Cold** — compile cache wiped before *both* arms' samples, so filesystem state is symmetric and
  the compile-cache arm pays first-run compile plus the cache write.

### Unmeasured leg: cold OS page cache

The issue asked for both cold and warm OS-file-cache measurements. **Only the warm-page-cache leg
was measured.** `sudo purge` requires a password that isn't available non-interactively in this
environment, so a cold OS file cache could not be simulated; every number below is warm-page-cache.
This is a separate axis from the cold/warm *compile cache* above, which is fully controlled.

That leg is genuinely open, not a formality: which way it moves is untested. The compile-cache arm
reads and writes 664–848 kB that the baseline never touches, so one plausible expectation is that a
cold page cache costs it more — but that is a hypothesis, not a finding, and the warm-cache numbers
below cannot settle it. Settling it needs the same interleaved A/B re-run on a host where `purge`
(or an equivalent page-cache eviction) can run between samples, which would also change the
baseline arm's cost and could move the comparison either way.

### Routes

The issue names `ad --help` and `ad open`. Both were measured, plus `--version` because
ADR-0019/CI already track it:

- `--help`, `--version` — measured directly end to end.
- `ad open` — measured **two ways**: end to end against a real iOS simulator, and via its CLI-side
  path in isolation. `open Settings --platform bogus` fails argument validation after loading the
  full CLI + `open` command module graph but before any daemon or device work, which isolates
  exactly the portion of `open` a compile cache can affect (83 cache entries, the largest of any
  route measured). It is reported as a component of `open`, not as a substitute for it.

An earlier revision of this doc substituted `session list` for `open`. That was not a valid stand-in
and has been dropped.

## Numbers

### Warm compile cache (the issue's bar)

n=120 per arm, interleaved/order-flipped. Load is the 1-minute average at the start and end of each
route's block:

| Route | load | baseline median | compile-cache median | delta | bootstrap 95% CI | verdict |
|---|---|---:|---:|---:|---:|---|
| `--version` | 6.4→7.1 | 30.4 ms | 30.3 ms | -0.1 ms | [-0.5, +0.5] | no significant difference |
| `--help` | 7.1→7.7 | 49.3 ms | 45.7 ms | **-3.6 ms** | [-4.3, -2.9] | faster |
| `open` CLI-side path | 7.7→7.4 | 59.9 ms | 54.8 ms | **-5.1 ms** | [-5.6, -4.5] | faster |

On the two heavier routes this is a **small but statistically real improvement** — the intervals sit
entirely below zero. It is still roughly ten times too small to reach the 50 ms bar, and every
interval lies far above the -50 ms ship threshold.

An earlier revision of this doc reported these same routes as "indistinguishable from zero"
(+0.1 ms and +0.6 ms, intervals spanning zero). Those runs were taken at a higher and less stable
load; re-running the identical harness on a quieter host resolved a ~3–5 ms gain that the noise had
been hiding. The direction of the conclusion is unchanged, but "no effect" was an artifact of
measurement conditions and is corrected here.

### Cold compile cache (first-run cost)

n=60 per arm, both arms wiped identically before each sample:

| Route | load | baseline median | compile-cache median | delta | bootstrap 95% CI | verdict |
|---|---|---:|---:|---:|---:|---|
| `--help` | 8.2→8.3 | 51.3 ms | 62.6 ms | **+11.3 ms** | [+10.3, +12.4] | slower |
| `open` CLI-side path | 8.3→8.3 | 62.3 ms | 78.7 ms | **+16.4 ms** | [+15.9, +18.0] | slower |

Writing the cache costs real time on the first invocation after any cache miss — and cache misses
are not rare in practice: the cache is keyed per Node version, lives in `os.tmpdir()`, and is
subject to tmp reaping.

### `ad open` end to end (real iOS simulator)

Measured against a dedicated throwaway simulator created for this run (iPhone 17 / iOS 26.2,
deleted afterwards). Every already-booted simulator on this host was claimed by another concurrent
session and agent-device's device-claim guard correctly refused them, so a private device was
created rather than disturbing that work. Warm compile cache, hot runner and session,
interleaved/order-flipped, invoked from a fixed working directory (session identity is cwd-derived;
varying it creates a second session that cannot claim the device — an early pilot was invalidated
this way and discarded).

n=150 per arm, load 7.7→5.7:

| Route | load | baseline median | compile-cache median | delta | bootstrap 95% CI | verdict |
|---|---|---:|---:|---:|---:|---|
| `ad open Settings` (iOS sim) | 7.7→5.7 | 1232.9 ms | 1226.5 ms | **-6.4 ms** | [-10.0, -3.8] | faster |

The interval lies far above the -50 ms ship threshold, so a >=50 ms improvement on `ad open` is
excluded rather than merely unproven — on the variability actually observed, not an assumed model.

This number is also a coherence check on the whole measurement. The end-to-end gain (-6.4 ms) is
about the same size as the `open` route's CLI-side gain (-5.1 ms), which is what should happen if
the compile cache affects only CLI process startup and nothing about the device work that dominates
the remaining ~1.2 s. Two independent measurements of the same underlying effect agree.

A first attempt at this run was discarded rather than reported: it was launched while the
newly-created simulator was still doing first-boot work and Spotlight was indexing it, driving the
1-minute load average to 120 on 12 cores. The run above was restarted after that settled.

## Ship/no-ship decision

**No-ship**, on evidence in the units the bar is stated in:

- The bar was a warm-run improvement of **>=50 ms**. The warm gain is real but an order of
  magnitude short: -3.6 ms on `--help`, -5.1 ms on the `open` CLI-side path, nothing on
  `--version`, and no significant difference end to end on `ad open`. Every interval lies far above
  the -50 ms ship threshold, so each directly excludes it.
- Cold-cache runs are measurably **slower** (+11 to +16 ms). Shipping trades a first-run regression
  for a warm gain ~3x smaller, and cache misses are routine: the cache is keyed per Node version,
  lives in `os.tmpdir()`, and is subject to tmp reaping.
- The API is Stability 1.1 – Active Development at the repo's supported Node floor.

The code change was reverted (`bin/agent-device.mjs` is unchanged from `main`); this document, the
retained harness and samples, and the PR description are the record, per the issue's own "measure
first, ship only if it's a real win" instruction.

This does not close #1961: the cold-OS-page-cache leg the issue asked for is unmeasured. If that
leg is ever run and the warm/cold-page-cache picture changes materially, the trade above is what
should be re-examined.

## Why the result differs from the issue's prior micro-benchmark

The issue cites a prior finding that importing `daemon-runtime.ts` under plain `node` went
0.69s -> 0.32s warm with the compile cache, and flags the risk up front: "that was source, not dist
— the dist bundle is fewer, larger modules, so the win may be smaller." That is exactly what
happened, and the mechanism is visible in the numbers above.

Compiling many small TypeScript-sourced files under type-stripping is expensive per file, and the
compile cache removes most of that. The `dist/` bundle `bin/agent-device.mjs` actually loads is
already a small number of large, minified, tree-shaken chunks: `--help` compiles only the 51
modules its cache-entry count reports, out of a ~300-file `dist/src` tree. There is simply far less
parse work available to eliminate, so the saving lands at 3–5 ms rather than the hundreds of
milliseconds the source-tree benchmark saw — the same mechanism, two orders of magnitude smaller
because the input is already bundled.

The cache's own overhead is what turns that small win negative on a miss: reading and validating
source hashes is cheap, but writing back 664–848 kB is not, and it costs more than the parse it
will later save.

## If revisited

Do not re-attempt this change speculatively. Re-measure only if `dist/` bundling changes shape so
that the eager closure becomes many more or much larger chunks, or if Node's compile-cache
read/write overhead drops materially. Re-run with `scripts/perf/compile-cache-ab.mjs` rather than
building something new: interleaved, order-flipped **elapsed** sampling with a reported CI, not
sequential phases and not CPU time, and cover the cold compile-cache state too, since that is where
this change costs rather than saves.

Two traps this investigation hit, both of which produced confident wrong answers:

- **Host load silently changes the verdict.** The same harness on the same binaries reported "no
  significant difference" on a busy host and a real -3.6 ms gain on a quiet one. Record the load
  with every run and re-run anything measured above roughly half the core count.
- **Cold-cache runs must wipe the cache before *both* arms.** Wiping before only the compile-cache
  arm leaves asymmetric filesystem state and inflated the `open` cold penalty to +52.8 ms, well
  over double the symmetric figure. The retained harness wipes both.
