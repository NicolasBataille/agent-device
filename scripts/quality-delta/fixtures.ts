// Shared fixtures for the quality-delta tests: a repo-health snapshot with plausible numbers, and
// the two PR-local reports the comment can consume. Named exports in a sibling module rather than
// literals repeated per test (AGENTS.md "shared fixtures").

import type { ChangedCoverageResult } from '../coverage-changed/model.ts';
import type { RepoHealthSnapshot } from '../repo-health/model.ts';

export type SnapshotOverrides = {
  commit?: string;
  schemaVersion?: number;
  generatedAt?: string;
  sizeStale?: boolean;
  jsGzipBytes?: number;
  npmTarballBytes?: number;
  typeInversionTotal?: number;
  typeCycleBaseline?: number;
  suppressions?: number;
  redundantEdges?: number;
};

/** A snapshot whose every metric sits on the baseline values, so a test moves exactly one number. */
export function snapshotFixture(overrides: SnapshotOverrides = {}): RepoHealthSnapshot {
  const commit = overrides.commit ?? 'a'.repeat(40);
  const generatedAt = overrides.generatedAt ?? '2026-07-20T10:00:00.000Z';
  const schemaVersion = overrides.schemaVersion ?? 1;
  return {
    schemaVersion,
    provenance: {
      schemaVersion,
      commit,
      ref: 'main',
      node: 'v22.14.0',
      generatedAt,
      tool: { depgraph: 'abc123456789', layering: 'def123456789' },
      inputs: {
        sourceFiles: 900,
        lockfile: { path: 'pnpm-lock.yaml', sha256: '0123456789ab' },
        coverageSummary: {
          path: 'coverage/coverage-summary.json',
          sha256: 'cccccccccccc',
          producerCommit: commit,
          status: 'fresh',
        },
        sizeReport: {
          path: '.tmp/size-report.json',
          sha256: 'ssssssssssss',
          producerCommit: overrides.sizeStale === true ? 'f'.repeat(40) : commit,
          status: overrides.sizeStale === true ? 'stale' : 'fresh',
        },
      },
    },
    metrics: {
      depgraph: {
        files: 900,
        edges: 4700,
        valueCycles: 0,
        typeCycles: 7,
        dynamicCycles: 1,
        redundantEdges: overrides.redundantEdges ?? 1300,
        backEdges: 0,
        typeInversionEdges: overrides.typeInversionTotal ?? 7,
      },
      layering: {
        typeInversionBaseline: { 'commands -> client': overrides.typeInversionTotal ?? 7 },
        typeInversionTotal: overrides.typeInversionTotal ?? 7,
        typeCycleBaseline: overrides.typeCycleBaseline ?? 102,
      },
      coverage: {
        available: true,
        lines: { total: 1000, covered: 830, pct: 83 },
        statements: { total: 1000, covered: 800, pct: 80 },
        functions: { total: 200, covered: 170, pct: 85 },
        branches: { total: 400, covered: 300, pct: 75 },
      },
      size: {
        available: true,
        jsRawBytes: 3_000_000,
        jsGzipBytes: overrides.jsGzipBytes ?? 800_000,
        npmTarballBytes: overrides.npmTarballBytes ?? 1_200_000,
        npmUnpackedBytes: 4_000_000,
      },
      fallow: {
        deadCodeFindings: 0,
        healthFindings: 161,
        suppressions: {
          ignoredExports: overrides.suppressions ?? 19,
          ignoredDependencies: 0,
          total: overrides.suppressions ?? 19,
        },
      },
      slowTest: { unitBudgetMs: 2500, integrationBudgetMs: 15000, enforceFactor: 2 },
      bench: { cases: 19, topics: 10 },
      skillgym: { cases: 5 },
      components: { byZone: [] },
      mainSequence: { concreteHighFanIn: [] },
    },
    consistency: { r6: { ok: true, expected: {}, actual: {} } },
  };
}

export function changedCoverageFixture(
  overrides: Partial<ChangedCoverageResult> = {},
): ChangedCoverageResult {
  return {
    threshold: 70,
    coveredLines: 95,
    totalLines: 100,
    pct: 95,
    waived: false,
    passed: true,
    offenders: [],
    branch: { covered: 18, total: 20, pct: 90 },
    excluded: { files: [], totalLines: 0 },
    ...overrides,
  };
}
