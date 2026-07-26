# Testing Notes

## Which gates a change needs

Default for code changes: `pnpm check:affected --base origin/main --run`. It derives the gate set
from repository sources of truth, so prefer it over interpreting the table below by hand. GitHub CI
stays authoritative.

The mapping it encodes, for when you need to run a gate directly or reason about coverage:

| Change | Gate |
| --- | --- |
| Any TypeScript | `pnpm typecheck` or `pnpm check:quick` |
| Daemon handler / shared module | `pnpm check:unit` |
| Tooling/config (`package.json`, `tsconfig*.json`, `.oxlintrc.json`, `.oxfmtrc.json`) | `pnpm check:tooling` |
| Platform/device response — anything emitting `platform`/`appleOs` on the wire, or shaping a daemon response | `pnpm test:integration:provider` **and** `pnpm test:coverage` |
| Cross-platform behavior | `pnpm test:integration` |
| iOS runner / Swift | `pnpm build:xcuitest` |
| CLI help/guidance (`src/cli/parser/cli-help.ts`, `src/cli-schema/`) | `pnpm exec vitest run src/cli/parser/__tests__ src/cli-schema/command-schema-guards.test.ts scripts/__tests__` — the `scripts/__tests__` gates enforce help-topic benchmark coverage and pin the bench's quoted CLI samples to the real renderers |
| Help benchmark cases (`scripts/help-conformance-*.mjs`) | `pnpm exec vitest run scripts/__tests__` (deterministic gates); model-backed: `pnpm bench:help-conformance` (paid LLM calls, local only) |
| SkillGym prompts/assertions | `pnpm test:skillgym:case <case-id>` (broad: `pnpm test:skillgym`, filter with `-- --tag fixture-smoke` or `-- --tag skill-guidance`) — agentic routing + local-help-consumption proof only; command-planning knowledge checks belong in the help bench |
| Anything in `src/`, `test/`, `skills/` | `pnpm format` |

Two traps worth naming:

- The platform/device-response row is the one agents miss. `pnpm check:unit` does **not** exercise the
  `provider-integration` project, and that project holds the apple-platform-output leak guard.
  Internal `apple` must never reach a command response — project through `publicPlatformString`.
- Fallow CI failures reproduce with `pnpm check:fallow --base origin/main`. Do not estimate
  complexity or dead-code impact by hand.

Docs/skills-only and non-TS changes with no behavior impact need no tests. Test-only DI seam CI
failures are enforced by the workflow — do not add optional `typeof` DI params to production code to
satisfy a test.

## Shared test utilities

Before writing a new test, inspect `src/__tests__/test-utils/index.ts`:
`rg -n "export .*make|export .*DEVICE|withMocked" src/__tests__/test-utils`. Import through the
barrel and prefer named shared fixtures over inlining new `DeviceInfo`, `SessionState`, snapshot,
store, or mocked-binary objects. If a helper is missing, add it near the concept it serves and export
it through the barrel.

Keep tests behavioral. Do not assert shapes or cases TypeScript already proves.

Test through public interfaces where practical, and do not add unrelated production exports solely
to make a test easier — widening the public surface for a test is a product change, and the exports
outlive the test that motivated them. If a seam is genuinely missing, add it as a real one rather
than as a test affordance (the workflow separately forbids test-only `typeof` DI params).

## Affected-check selector (`pnpm check:affected`)

`pnpm check:affected --base <ref>` derives which local checks a diff needs, so
agents stop interpreting the testing matrix by hand. It is a **fail-open
advisory**: existing GitHub CI stays authoritative and required, and this only
narrows the *local* feedback loop.

```sh
pnpm check:affected --base origin/main --run     # default agent loop: plan + run
pnpm check:affected --base origin/main           # human-readable plan only
pnpm check:affected --base origin/main --json    # machine-readable plan only
```

The selection is derived from repository sources of truth rather than a
hand-maintained path map:

- **Affected Vitest tests** are delegated to `vitest related --run`, using
  Vitest's own project configuration and static module graph. The selector
  passes its complete changed-file set instead of reproducing Vitest globs or
  import ownership. Dynamic-import relationships remain outside Vitest's
  analysis; GitHub's authoritative full suites still cover that boundary.
- **Non-Vitest suites** retain explicit ownership. Root
  `test/integration/*.ts` files use the Node integration lane, SkillGym owns its
  harness and skill guidance, and platform/build tools keep their native gates.
- **Always-on gates** (`lint`, `typecheck`, `layering`, `fallow`, `format`) fire
  for their input categories and are never silently skipped. Platform source
  also selects the provider-integration and coverage gates required by the
  Testing Matrix.
- **Commands** are resolved from real `package.json` scripts, so a renamed
  script fails loudly instead of dropping a gate.
- A **small explicit build-ownership layer** covers the paths whose owning build
  cannot be derived: Swift runner, Android helpers, macOS helper, MCP metadata,
  and the public package surface (itself derived from `package.json` `exports`).
- **SkillGym ownership** covers skill guidance (`skills/`) and the SkillGym
  harness (`test/skillgym/`) — those changes select the (local-only) SkillGym
  suite, and their Markdown is treated as skill/harness input, not inert docs.

Changed-file discovery folds working-tree state into the local plan: in the
default local mode (`--head HEAD`) it unions the committed `base..HEAD` diff with
staged, unstaged, and untracked files, and disables rename detection so **both**
sides of a rename are classified (a moved file cannot look docs-only by its
destination alone).

Anything the selector cannot classify — unknown, ambiguous, workflow/tooling, or
a change to the selector's own sources — **fails open to the full check set**.
That includes this file: the Testing Matrix above is the prose the ownership
rules mirror, so `docs/agents/testing.md` is selector-owning
(`SELECTOR_OWNING_DOCS` in `scripts/check-affected/model.ts`) and outranks the
docs-only short-circuit its path would otherwise take. If the matrix moves
again, move that entry with it.
The plan documents the rule and changed path behind every selected check.

Model and catalog live under `scripts/check-affected/`; the derivation is guarded
by `pnpm check:affected:test` (the `Affected-check Selector` CI job).

## Live web smoke

The live web platform smoke runs the public built CLI against a local fixture page through the managed web backend:

```bash
AGENT_DEVICE_WEB_E2E=1 pnpm test:smoke:web
```

The test is skipped unless `AGENT_DEVICE_WEB_E2E=1` is set. The test runs `agent-device web setup` and `agent-device web doctor` with an isolated state directory before opening the fixture URL, so it verifies the public managed-backend setup path instead of relying on a global `agent-browser`. CI runs the lane on Node 24 because the managed backend requires Node >= 24. Failure artifacts, daemon state, and browser config are written under `test/artifacts/web/`.

## Live iOS simulator coverage

The iOS lane combines three evidence layers instead of treating a catalog mention as E2E proof:

- pull requests run a short JSON-asserting fixture smoke against the real built CLI, daemon, XCTest
  runner, and simulator;
- the scheduled/manual nightly workflow adds device lifecycle, system UI, recording/trace, and
  fixture replay scenarios without putting those slower operations on the pull-request merge gate;
- command-contract, workflow-live, and capability-denial rows explicitly own functionality that
  requires remote sources, unavailable host permissions, or CI setup outside the app session.

`test/integration/ios-simulator-e2e/coverage-manifest.ts` is the executable ownership source. A new
public command fails the always-running Node contract until it has one primary owner and an
observable assertion. Live scenario claims are credited only after the scenario runs every claimed
command and records command-specific app/device/artifact evidence. Replay and test run inside the
same full harness, so its coverage report cannot turn green before their semantic fixture canaries
and JUnit output pass.

Command ownership guarantees at least one semantic path for every public command; it does not imply
that every optional collector or backend mode runs nightly. The complementary
`behavior-coverage.ts` matrix guards the cross-command mobile patterns from #320: cold deep-link
navigation, keyboard lifecycle, background resume, modal presentation, permission denial/reset/
acceptance, interrupted Home/app-switcher recovery, long-list rediscovery, and host-focus
preservation. Existing focused command contracts remain the evidence for additional expensive or
host-permission-dependent modes.

CI retrieves the Release fixture through `.github/actions/setup-fixture-app` with `install: false`;
the smoke then exercises the public `install` command. The artifact is keyed by the Expo native
fingerprint and repacked with current JavaScript, so screen and replay changes reuse the native
binary and do not need Metro. Both iOS workflows need `permissions.actions: read`; without it the
action deliberately falls back to an expensive inline native build. The pull-request consumer
polls a cold fingerprint while the producer workflow builds it, preventing two concurrent native
builds; hits proceed immediately. The pull-request lane also pins Finder as the frontmost host app
and proves simulator automation does not steal macOS focus.

Run the static contract and documented live skip locally:

```bash
node --test test/integration/smoke-ios-simulator-coverage.test.ts
```

Run a live tier after booting a simulator and obtaining a current Release `.app`:

```bash
pnpm build
pnpm clean:daemon
AGENT_DEVICE_IOS_E2E=1 \
AGENT_DEVICE_IOS_E2E_TIER=smoke \
AGENT_DEVICE_IOS_UDID=<simulator-udid> \
AGENT_DEVICE_FIXTURE_APP_PATH=<fixture.app> \
AGENT_DEVICE_FIXTURE_APP_ID=com.callstack.agentdevicelab \
AGENT_DEVICE_IOS_APP_EVENT_URL_TEMPLATE='agent-device-test-app:///automation?event={event}&payload={payload}' \
node --test test/integration/smoke-ios-simulator-coverage.test.ts test/integration/smoke-ios-simulator.test.ts
```

Use `AGENT_DEVICE_IOS_E2E_TIER=full` for the nightly subset. Step history, coverage reports,
screenshots, recordings, traces, and failure context are written below
`test/artifacts/ios-simulator/` and uploaded by the existing shared artifact action. The six
Settings replays remain additive OS-chrome coverage and are not modified by this suite.

## Speed rules (experiment-backed, 2026-07-04)

Measured on the full unit suite (340 files, 3,210 tests, 48s wall at ~7x parallelism):

- **Wall clock equals the slowest file.** The 44.6s android monolith bounded the whole 48s run
  (Amdahl at file granularity: vitest parallelizes per file). Splitting monolith test files is a
  wall-clock optimization, not just a navigation one — see the AGENTS.md test-topology mirror rule.
- **Unit tests must not wait real time.** The suite's worst tests slept through production budgets:
  10.8s to prove "times out" by waiting out the full constant, 8s emulator-boot polls at 1Hz, real
  retry backoffs. Conversion patterns, in preference order (tracking issue #1098):
  1. *Budget-derived cadence* (production-legit): poll intervals scale with the caller's timeout —
     this took `devices.test.ts` from 25.6s to 2.8s (9x) while making short-budget production calls
     more responsive.
  2. *Budget-wiring assertion*: don't re-prove the exec layer's timeout per call site; mock the tool
     layer and assert the right `timeoutMs` constant is passed. Exec-layer timeout semantics are
     proven once, in exec's own tests.
  3. *Fake clocks* where the code accepts an injected clock.

  Never add a test-only DI seam for this — the CI gate forbids it; patterns 1–2 are production
  improvements and test restructurings respectively.
- **The slow-test ratchet** (`scripts/vitest-slow-test-reporter.ts`) enforces this: unit budget
  2.5s, integration 15s, failure at 2x budget (the band between reports without failing — host
  load legitimately stretches borderline tests, and a flaky gate trains people to ignore it).
  The pin list only shrinks, or grows in the same PR with a justification.
- **Isolation stays ON; pool stays forks — both measured.** `--no-isolate`: 205s wall vs 48s
  (module state — timers, memos, singletons — thrashes across files sharing a worker).
  `--pool=threads`: no change (50.4s). The ~100s aggregate import overhead is the price of
  isolation and is paid in parallel; reduce it per file by importing the module under test, not
  platform barrels.
