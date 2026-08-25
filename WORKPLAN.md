# Tier Work Plan — chief-of-staff tracker

Owner: improve-worktree session. Source of truth for scope: `IMPROVEMENT-AUDIT.md` (verified v2).
Rule: max 2 workers in parallel; each worker gets its own git worktree + brief; workers commit but
never push — chief reviews, runs `claude -p` adversarial review, then pushes + opens PR.

## Worker waves

| Wave | Worker | Scope (audit ref) | Worktree | Status |
| --- | --- | --- | --- | --- |
| A | A1 | V1 Android helper-session wiring (+ force-stop exit gate) | /Users/thymikee/Developer/agent-device/.worktrees/opencode/worker-android | BLOCKED: claude OAuth expired — needs interactive re-login; worktrees ready at .worktrees/opencode/ |
| A | A2 | V4 find index-once (#1690) | /Users/thymikee/Developer/agent-device/.worktrees/opencode/worker-find | BLOCKED: claude OAuth expired — needs interactive re-login; worktrees ready at .worktrees/opencode/ |
| B | B1 | V2 dumpsys dedup + A8 IME batch promotion | /Users/thymikee/Developer/agent-device/.worktrees/opencode/worker-android2 | pending |
| B | B2 | V5 source-mode fingerprint + B2 ReplayDivergenceResume type import | .worktrees/opencode/worker-daemon-client | **PR #2004 MERGED** (absent-paths cache soundness, lazy closure, pin 365) |
| C | C1 | A11 leftovers batch (diagnostics dedup, Promise.allSettled uninstalls, openIosDevice booted-memo guard, HarmonyOS viewport cache) | ../agent-device-worker-a11 | pending |
| C | C2 | B6 adb transport injection (~4 call sites) | ../agent-device-worker-adb | pending |
| D | D1 | B9 http-server split (route table + install-source schema) | ../agent-device-worker-http | pending |
| D | D2 | B4 registry cells (capability bolt-on, ownerFiles table, row factories) | ../agent-device-worker-registry | pending |
| E | E1 | B8 scoped cross-daemon browser ownership (PID file + doctor) | ../agent-device-worker-web-lifecycle | pending |
| E | E2 | #1652 settle surfaces (6 underived + 2 bugs named in issue) | ../agent-device-worker-settle | pending |
| — | — | selector/replay split (#1978) → **PR #1988 MERGED**; tier-1 sweep: #1938/#1939/#1940/#1951/#1953/#1954/#1971/#1974 all MERGED; wave B: #2003/#2004 both MERGED. 12/12 PRs merged, 0 open. | — | — |
| F | F1 | B5 staged CLI lazy startup (grammar data vs executables) | ../agent-device-worker-cli-lazy | pending — largest; needs its own wave |

Not scheduled (dropped by verification): B3, B7, B10-rewrite. B1 RequestContext = contribute to
ADR-0019 arc, not a standalone worker (needs maintainer coordination). V6 web upstream ask = file
issue only, chief does it directly.

## Gate for every worker

- Red-first for behavior changes (observed red vs pre-fix code).
- Targeted vitest + `pnpm check:affected --run` green before commit.
- `pnpm format`; conventional commit; tests mirror source topology; no compat shapes.
- Device-facing changes: live evidence per `docs/agents/device-verification.md` or stated residual risk.

## Repo-quality backlog (flagged, save for later)

See `REPO-QUALITY-BACKLOG.md`.


## Babysitting rota (standing)

- Chief polls all open PRs each cycle; CI fixers dispatched from `BABYSIT-BRIEF.md`.
- #1953, #1954, #1938: MERGED.
- #1971: smoke failure was a flake (green on rerun); 0 failing checks; awaiting review.
- #1974: ratchet banked via extraction shrink (pin 1658→1495); pushed `9e047ca08`; 0 failing checks.
- Rule: babysitters take freed worker slots; implementation waves keep priority when both compete.


## Merge ledger (all chief-dispatched PRs)

| # | Title | Tier |
| --- | --- | --- |
| #1938 | perf(ios): suppression child index once per pass | 1 |
| #1939 | perf(ios): memoize url-scheme probes per bundle mtime | 1 |
| #1940 + #1951 | fix(web): enabled=false from [disabled] annotation (+ scope follow-up) | 1 |
| #1953 | refactor: kernel rect helper dedups | 1 |
| #1954 | docs: stale apps.ts warning removed | 1 |
| #1971 | perf(find): index topology once per ranking pass (#1690) | 3 |
| #1988 | perf(selectors): replay target in one matching pass (#1978) | 3 |
| #1974 | perf(android): warm helper session across fill/scroll | 2 |
| #2003 | perf(android): one dumpsys read; IME batch text entry | 2 |
| #2004 | perf(daemon): stat-revalidated source code-signature cache | 4 |
| #2012* | web daemon-shutdown session close (maintainer-authored) | — |

Next: wave C — A11 leftovers batch + B6 adb transport injection.
