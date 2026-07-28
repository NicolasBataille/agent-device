// The ONE config block for the quiet quality-delta comment (#1424, Track C of #1412).
//
// Every metric the PR comment can show is declared here, with the threshold that decides whether
// it is worth a line and the gate that owns the fix. Nothing else in this directory hard-codes a
// number or a gate name: model.ts compares, run.ts does I/O.
//
// The hard maintainer requirement is "do not drown people in information". A metric earns a row
// only when it crosses its own threshold, so raising the bar for one metric is a one-line edit
// here — and `MAX_COMMENT_LINES` caps the whole comment regardless of how many crossed.
//
// Thresholds are deliberately coarse: they are noise filters, not gates. Nothing here fails a
// build. Every gating number in this repo still lives with its own gate (the changed-line
// threshold in scripts/coverage-changed/model.ts, the ratchets in scripts/layering/check.ts, the
// budgets in scripts/vitest-slow-test-budgets.ts), and the specs below only reference them.

import {
  CHANGED_LINE_COVERAGE_THRESHOLD,
  type ChangedCoverageResult,
} from '../coverage-changed/model.ts';
import type { RepoHealthSnapshot } from '../repo-health/model.ts';
import type { SlowTestReport } from '../vitest-slow-test-budgets.ts';

/**
 * Hard cap on the rendered comment, marker line included. Rows past the cap are dropped from the
 * comment (lowest severity first) and summarized as "+N more, see the job summary"; the job
 * summary always carries every row.
 */
export const MAX_COMMENT_LINES = 20;

/** Inputs a row can be derived from. Each is optional except the head snapshot. */
export type DeltaSources = {
  head: RepoHealthSnapshot;
  /** The main-branch baseline for `head`, read from the JSONL history. */
  base: RepoHealthSnapshot | null;
  /** This PR's changed-line coverage report (#1418), which has no main baseline by construction. */
  changedCoverage: ChangedCoverageResult | null;
  /** Slow-test offenders recorded by the vitest reporter during the coverage run. */
  slowTest: SlowTestReport | null;
};

export type MetricFormat = 'bytes' | 'count' | 'pct';
export type MetricDirection = 'lower-is-better' | 'higher-is-better';

/** Where a reader goes to act on a row: the gate that owns the number, and the command that fixes it. */
export type MetricOwner = {
  /** CI job name, so the row points at the check whose failure it predicts. */
  gate: string;
  /** Repo-relative file that owns the number (linked in the comment). */
  path: string;
  /** Command a contributor runs locally to reproduce or fix it. */
  fix: string;
};

type CommonSpec = {
  key: string;
  label: string;
  format: MetricFormat;
  direction: MetricDirection;
  owner: MetricOwner;
  /**
   * The repo-health read artifact this metric comes from, when it is one the snapshot did not
   * produce itself. Its `stale` provenance flag then marks the row instead of the row silently
   * claiming to describe the head commit.
   */
  staleInput?: 'sizeReport' | 'coverageSummary';
};

/** A metric compared against the main baseline; shown when |delta| reaches `minAbsDelta`. */
export type DeltaMetricSpec = CommonSpec & {
  kind: 'delta';
  minAbsDelta: number;
  /** Ratchet-style metrics where only movement in the bad direction is notable. */
  worseOnly?: boolean;
  read: (snapshot: RepoHealthSnapshot) => number | null;
};

/**
 * A PR-local metric with no main baseline (changed-line coverage is defined against the diff, not
 * against a commit). Shown when the value is worse than `bound`.
 */
export type AbsoluteMetricSpec = CommonSpec & {
  kind: 'absolute';
  bound: number;
  read: (sources: DeltaSources) => number | null;
};

export type MetricSpec = DeltaMetricSpec | AbsoluteMetricSpec;

const SIZE_OWNER: MetricOwner = {
  gate: 'Size / Bundle Size',
  path: '.github/workflows/size.yml',
  fix: 'pnpm size',
};

const COVERAGE_OWNER: MetricOwner = {
  gate: 'CI / Coverage',
  path: 'scripts/coverage-changed/model.ts',
  fix: 'pnpm check:coverage-changed',
};

const LAYERING_OWNER: MetricOwner = {
  gate: 'CI / Layering Guard',
  path: 'scripts/layering/check.ts',
  fix: 'pnpm check:layering',
};

/**
 * Coverage rows use the gate's own threshold plus a margin, so a PR that is merely *approaching*
 * the gate gets one quiet line instead of a surprise failure on the next commit.
 */
const CHANGED_LINE_WARN_MARGIN_PCT = 10;

export const QUALITY_DELTA_METRICS: readonly MetricSpec[] = [
  {
    kind: 'delta',
    key: 'jsGzipBytes',
    label: 'JS gzip',
    format: 'bytes',
    direction: 'lower-is-better',
    // ~4 kB gzip is roughly a new module's worth of emitted code; below that the number is build
    // noise. Raw bytes stay in the Size job summary rather than earning a second row here.
    minAbsDelta: 4_096,
    owner: SIZE_OWNER,
    staleInput: 'sizeReport',
    read: (snapshot) => snapshot.metrics.size.jsGzipBytes ?? null,
  },
  {
    kind: 'delta',
    key: 'npmTarballBytes',
    label: 'npm tarball',
    format: 'bytes',
    direction: 'lower-is-better',
    minAbsDelta: 10_240,
    owner: SIZE_OWNER,
    staleInput: 'sizeReport',
    read: (snapshot) => snapshot.metrics.size.npmTarballBytes ?? null,
  },
  {
    kind: 'delta',
    key: 'typeInversionTotal',
    label: 'R6 type inversions',
    format: 'count',
    direction: 'lower-is-better',
    // A ratchet: one pair moving either way is worth a line (it may only shrink, and shrinking is
    // the standing direction in CONTEXT.md).
    minAbsDelta: 1,
    owner: LAYERING_OWNER,
    read: (snapshot) => snapshot.metrics.layering.typeInversionTotal,
  },
  {
    kind: 'delta',
    key: 'typeCycleBaseline',
    label: 'R9 largest type cycle',
    format: 'count',
    direction: 'lower-is-better',
    minAbsDelta: 1,
    owner: LAYERING_OWNER,
    read: (snapshot) => snapshot.metrics.layering.typeCycleBaseline,
  },
  {
    kind: 'delta',
    key: 'fallowSuppressions',
    label: 'Fallow suppressions',
    format: 'count',
    direction: 'lower-is-better',
    minAbsDelta: 1,
    // New suppressions are the signal; removing one is good news the Fallow job already shows.
    worseOnly: true,
    owner: {
      gate: 'CI / Fallow Code Quality',
      path: '.fallowrc.json',
      fix: 'pnpm check:fallow',
    },
    read: (snapshot) => snapshot.metrics.fallow.suppressions.total,
  },
  {
    kind: 'delta',
    key: 'redundantEdges',
    label: 'Redundant graph edges',
    format: 'count',
    direction: 'lower-is-better',
    // Reachability, not removability (scripts/depgraph/README.md): only a sizeable jump says the
    // import graph's shape changed, so the threshold sits well above per-PR churn.
    minAbsDelta: 25,
    owner: {
      gate: 'CI / Layering Guard',
      path: 'scripts/depgraph/README.md',
      fix: 'pnpm depgraph',
    },
    read: (snapshot) => snapshot.metrics.depgraph.redundantEdges,
  },
  {
    kind: 'absolute',
    key: 'changedLineCoveragePct',
    label: 'Changed-line coverage',
    format: 'pct',
    direction: 'higher-is-better',
    bound: CHANGED_LINE_COVERAGE_THRESHOLD + CHANGED_LINE_WARN_MARGIN_PCT,
    owner: COVERAGE_OWNER,
    read: (sources) => sources.changedCoverage?.pct ?? null,
  },
  {
    kind: 'absolute',
    key: 'changedBranchCoveragePct',
    label: 'Changed-branch coverage',
    format: 'pct',
    direction: 'higher-is-better',
    // Non-gating by #1418's amendment, so the bar is low: only badly uncovered new branching.
    bound: 50,
    owner: COVERAGE_OWNER,
    read: (sources) => sources.changedCoverage?.branch.pct ?? null,
  },
  {
    kind: 'absolute',
    key: 'changedLinesExcluded',
    label: 'Changed lines excluded from coverage',
    format: 'count',
    direction: 'lower-is-better',
    // Exclusions absorbing new logic (#1418 amendment). A handful is normal; a pile is a choice.
    bound: 10,
    owner: COVERAGE_OWNER,
    read: (sources) => sources.changedCoverage?.excluded.totalLines ?? null,
  },
  {
    kind: 'absolute',
    key: 'slowTestBreaches',
    label: 'Slow-test budget breaches',
    format: 'count',
    direction: 'lower-is-better',
    // Any test over its wall-clock budget is worth a line, including the ones inside the 2x
    // load-variance band that the gate reports without failing.
    bound: 0,
    owner: {
      gate: 'CI / Coverage',
      path: 'scripts/vitest-slow-test-budgets.ts',
      fix: 'pnpm test:unit',
    },
    read: (sources) => sources.slowTest?.offenders.length ?? null,
  },
];
