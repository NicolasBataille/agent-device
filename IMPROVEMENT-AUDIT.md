# Codebase Audit — VERIFIED edition (v2)

Worktree: `../agent-device-improve` (branch `improve/codebase-audit`, HEAD `07023eb20`).
v1 findings from 5 parallel explorations; **every claim then adversarially verified by 8 independent agents against code at the same HEAD plus live GitHub state**. This version incorporates all verification verdicts: confirmed items keep their evidence, refuted/dangerous proposals are marked as such and not repeated as recommendations. Do not implement anything marked ✗ or ⚠ without re-reading the cited constraint.

---

## Verified, act on these

### V1. Android fill/scroll pay cold instrumentation lifecycles — wire the scope that already exists
Fill runs 4 full instrumentation lifecycles (7 on retry) because `fill-verification.ts` never passes `helperSessionScope`, while daemon-session helper scoping **already exists** (`src/core/interactors/android.ts:89-91`, PR #862). Scroll similarly falls back to one-shot instrumentation (`touch-helper.ts:108-136, 55-106`). Warm captures are ~100–400ms vs 10–25s cold.
- **Fix:** pass the existing daemon-session scope through fill/scroll's capture path. Release on session close via the existing retirement/quarantine machinery.
- ⚠ Handle abnormal daemon termination (crash/SIGKILL) explicitly: a warm session that never receives a close event is exactly the UiAutomation-squatting exposure the quarantine machinery exists for — happy-path release-on-close alone widens it.
- ⚠ **Do NOT share the captured hierarchy across the 0/150/350ms verification samples** — the samples exist to observe settling; share the warm session, not the captured data.
- ⚠ Skip `force-stop` only when `graceful.acknowledged && graceful.exited` (confirmed exit, not mere acknowledgement) or you reintroduce UiAutomation squatting.

### V2. Android tap-readiness dumpsys storm — confirmed, understated
No-dialog common case runs both dumpsys variants per phase = 4 spawns/tap (`interaction-touch-android-readiness.ts:37-63`, `app-lifecycle.ts:126-133`); the `requireNoBlockingDialog` wait-loop variant reaches ~78 adb spawns (`android-system-dialog.ts:368-387`).
- **Fix:** parse one dump for focus + dialog together; cache the post-check ~1s; alternate probes in wait loops. Preserve incident-derived parse order (#1832).

### V3. O(n²·d) descendant collection on every iOS snapshot — cleanest quick win
`noise.ts:305-321` rebuilds a full index Map per candidate via `collectDescendantsByParentIndex` (`tree.ts:38-53`); the WeakMap-cached `getDescendantEndPositions` primitive (`tree.ts:84-105`) is a semantically safe drop-in. Safe to land standalone — `noise.ts` is TS post-processing downstream of the Swift presentation arc (#1929 merged at this HEAD).

### V4. Find ranking = unimplemented #1690 — strongest confirmed structural item
Per-candidate `Map`/viewport rebuilds fire on any ≥2 raw matches (`find-match-resolution.ts:113-137` → `interaction-targeting.ts:128-193`). Issue #1690 describes the exact fix; its executor-plan excerpts have drifted past #1876's split — re-verify before executing.
- Citation corrections: `snapshot-visibility.ts` is not on find's path (second rebuild is local `resolveRootViewportRect`); **do not delete `listSelectorChainMatches`** (legitimate callers exist) — only the redundant call in replay's `resolveRecordedTarget` (`packages/selectors/src/internal/replay.ts:100-139`) goes.

### V5. Daemon code-signature walk — confirmed, mis-scoped fix
Measured: 801 files, ~40–50ms, every invocation even on healthy reuse, double on takeover (`daemon-client-lifecycle.ts:215,643`; `code-signature.ts:26-63`) — but **only on the dev-from-source path**; dist is 1–5ms.
- ⚠ v1's three fixes all miss the cost center: health fields don't change on source edits; build-time emission has no build to hook. **Right fix:** keep dist check as-is; give source mode a cheaper fingerprint (path:size list, no contents) or accept it.
- PR #1771 already fixed #1545's signature-regex root cause; #1545 remains open only for the orphan-daemon defect.

### V6. Web backend process-per-command — confirmed empirically, fix needs upstream
~205ms measured per CLI call; click = 3, fill = 5, paced scroll up to 20; N+1 `get box @ref` (`agent-browser-provider.ts:168-195`, `agent-browser-snapshot.ts:21,39-50`). The pinned agent-browser CLI has **no serve/batch mode**, so a long-lived child isn't buildable from agent-device alone.
- **Action:** upstream feature request (batch composite commands / serve mode), or version-pinned socket-protocol work.

### V7. Confirmed small wins
- **A4 deep-link memo:** plutil spawn per installed app, serial, uncached (`app-resolution.ts:181-196,315-340`); `createTtlMemo` pattern ready to reuse.
- **A11:** diagnostics double-redaction/per-event sort/sync append (`diagnostics.ts:140,214,241`); stale-bundle uninstalls → `Promise.allSettled` (sibling precedent) (`runner-session.ts:362-374`); `openIosDevice` booted-memo bypass is a one-line simplification corroborated by the code's own "~0.7s per spawn" comment (`app-launch.ts:157-166`); HarmonyOS per-scroll viewport dump cache (`harmonyos/snapshot.ts:46-56`) needs invalidation for split-screen/multi-window changes and for device rotation not routed through the `setOrientation` interactor — neither hits the proposed orientation/open hooks.
- **B4.4 ownerFiles standalone table:** sibling precedent `src/daemon/route-owner-files.ts` proves totality survives outside the row spreads.
- **B4.5 row factories:** 14 local-cli rows (not 12); `<const T>` generics preserve literal-name inference (proven by `buildOwnerFiles`).
- **B4.1 capability bolt-on:** genuine late addition from #1683; replace throw guard with completeness test.
- **B6 adb transport injection:** feasible; only ~4 direct `runCmd('adb')` sites remain.
- **B9 http-server split:** confirmed; if anything v1 undercounted the jobs.
- **B12 partial:** `containsPoint` ×2 and the two byte-identical `rectArea` copies (`screenshot-diff-overlay-matches.ts`, `screenshot-overlay-rects.ts`) are safe to merge into kernel. Leave the two defensive-null variants (`rect?.width ?? 0`) and `find-match-resolution.ts`'s `POSITIVE_INFINITY` missing-rect sentinel alone — different semantics, not dupes.
- **AGENTS.md stale `apps.ts` claim:** apps.ts is a 15-line barrel; update the doc.

---

## Dropped or heavily corrected — do not implement as written

| Item | Verdict |
| --- | --- |
| **A8 chunk enlargement** | ✗ The 8-char chunking IS the fix for #531's on-device truncation. Right lever: promote the existing IME-helper batch broadcast (whole string in one `am broadcast`), currently gated behind `--test-ime`. |
| **B10 flatten-to-score** | ✗ Stages 2/4 are emptiness-guarded fallbacks that ARE the fix for the #1318 empty-refs bug. Keep only: #1255 red-first test + `truncated` emission + single `isForeignOverlayDismissTarget` evaluation. |
| **B7 replay return-values refactor** | ✗ The three-method shape is the published `AdReplayStepRuntime` contract in `packages/ad-replay`, deliberately settled by the #1555 review which removed response-bag returns. Cross-package API renegotiation, not cleanup. |
| **B3 deferred-outcome rewrite** | ✗ The "unused generics" are a documented dependency-inversion device avoiding the R9 type cycle; 67 incident-derived tests (#1542/#1569/#1600/#1601) guard the cluster. High risk, low value. |
| **B2 teardown directive** | Corrected to near-nothing: one 9-line sniffing site; `repairSessionHeld`/`sessionActive` are typed, ADR-0016-documented fields **already released in v0.20.10** (v1's "unreleased API" caveat was backwards). Fix = import existing `ReplayDivergenceResume` type client-side. |
| **A7 status-bar normalization** | Downgraded: opt-in for plain `screenshot` (default-on only for `diff screenshot`); memo already drops steady-state to 2 spawns; session-scoped overrides = frozen fake status bar between commands (product call). |
| **A6 settle baseline-as-sample** | Mechanically coherent but iOS/XCTest-only and repurposes a protective baseline; bench-gated or drop. |
| **B12 paced-scroll merge** | The two steppers encode different pacing philosophies (pixel-derived vs duration-derived) — deliberate, not copy-paste. |
| **B1 RequestContext collapse** | Reframed: overlaps ADR-0019's actively staged request-bound-runtime migration (same seam, commits landing this month). Contribute to that governed arc; don't rival it. Note: wrapper claim was 3-of-4 — the replay wrapper contains real fallback logic. |
| **B4.2 settle four-declaration map** | Stale — grammar/MCP settle surfaces already derive from the descriptor (test-pinned). Accurate map lives in #1652 (6 of 10 surfaces don't derive + 2 live bugs). Redirect work there. |
| **B4.3 config-flag tri-state** | Fine ONLY as required no-default field — the `cli-config-trust` suite guards reporter-RCE/token-smuggling paths. Fail closed. |
| **B5 CLI lazy startup** | `--version` framing refuted (`runVersionFastPath` imports nothing heavy) but the problem is 3x worse than v1 claimed: eager closure ≈ 383 modules / ~62k lines (not 121/19.5k). Sound refactor, touches ~120 facet files; must keep eager grammar aggregation for `--help` + config validation. Staged only. |
| **B8 Chrome fleet** | "Kills developer Chrome" refuted — matcher only reaches isolated Chrome-for-Testing installs. Real missed hazard: **two concurrent daemons share the global state dir and can reap each other's >5-min-idle browsers.** PID-file + doctor move still right; scope the fix to cross-daemon ownership. |

### Bonus live bug found during verification
**Every web snapshot node has `enabled`/`focused` silently undefined**: JSON refs carry only role+name (verified against pinned binary) and nothing extracts the `[disabled]` bracket annotation from the text tree. File an issue; small fix in `agent-browser-snapshot.ts`.

---

## C. Issue/ADR cross-check (corrected)

| Item | Verified status |
| --- | --- |
| #1690 find index-once | Not implemented; plan drifted past #1876's split — re-verify excerpts first. Execute (V4). |
| #1652 settle surfaces | The accurate settle map (6 of 10 underived + 2 bugs). Absorbs v1's B4.2. |
| #1832 Android conformance | Sequence V1/V2 with it. |
| #1545 | Root cause fixed by PR #1771; open remainder is orphan-daemon defect only. |
| #1370 breaking cleanups | Still pending; fold into next-major. Confirmed. |
| ADR dangling item | It is **ADR-0016 consequences item 6** (not 0015); blocks #1336 whose `ready-for-agent` label covers only the spike. Track or descope. |
| #1626 / #1635 / #1797 | Already resolved in-session: #1626 kept open w/ CaptureHint-seam comment; #1635 closed as superseded (draft PR #1930 executes sequencing); #1797 migration underway (#1845→#1931 landed). |

---

## D. Corrected action order

1. **DONE (tier 1):** V3 → #1938 · A4 memo → #1939 (merged) · web enabled/focused → #1940 (merged) + scope follow-up #1951 · AGENTS.md apps.ts fix → #1954 · B12 safe dedups → #1953. Remaining A11 items (diagnostics, Promise.allSettled uninstalls, booted-memo guard, HarmonyOS viewport cache) not yet filed.
2. **Android campaign:** V1 (wire existing `helperSessionScope`) + V2 (dumpsys dedup) + A8-as-IME-batch-promotion.
3. **V4 = execute #1690** with citation fixes.
4. **V5** source-mode-scoped fingerprint; **B2** shrinks to a type import.
5. **Registry:** B4.1/B4.4/B4.5 as written; settle → #1652; B4.3 fail-closed only; **B5** staged.
6. **Deliberate tier:** B6, B9 stand; B1 folds into ADR-0019; B3/B7/B10-rewrite dropped absent explicit appetite; B8 scoped to cross-daemon browser ownership.
