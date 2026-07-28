import { expect, test } from 'vitest';
import { changedCoverageFixture, snapshotFixture } from './fixtures.ts';
import { computeQualityDelta, NO_DELTAS_LINE, renderComment, renderJobSummary } from './model.ts';
import { MAX_COMMENT_LINES, type DeltaSources } from './thresholds.ts';

const CONTEXT = { linkBase: 'https://github.com/o/r/blob/head', summaryUrl: 'https://run/1' };

function sources(overrides: Partial<DeltaSources> = {}): DeltaSources {
  return {
    head: snapshotFixture({ commit: 'b'.repeat(40) }),
    base: snapshotFixture(),
    baseExact: true,
    changedCoverage: null,
    slowTest: null,
    ...overrides,
  };
}

function commentOf(overrides: Partial<DeltaSources> = {}): string {
  return renderComment(computeQualityDelta(sources(overrides)), CONTEXT);
}

function summaryOf(overrides: Partial<DeltaSources> = {}): string {
  return renderJobSummary(computeQualityDelta(sources(overrides)), CONTEXT);
}

test('an unchanged tree collapses the whole comment to one line', () => {
  expect(commentOf()).toBe(`${NO_DELTAS_LINE}\n`);
});

test('a size move under its threshold stays silent', () => {
  const head = snapshotFixture({ jsGzipBytes: 800_000 + 4_000 });
  expect(commentOf({ head })).toBe(`${NO_DELTAS_LINE}\n`);
});

test('a size move over its threshold earns one row naming its gate and fix command', () => {
  const head = snapshotFixture({ jsGzipBytes: 800_000 + 20_000 });
  const comment = commentOf({ head });
  expect(comment).toContain('| JS gzip | 800.0 kB | 820.0 kB | +20.0 kB |');
  expect(comment).toContain(
    '[Size / Bundle Size](https://github.com/o/r/blob/head/.github/workflows/size.yml)',
  );
  expect(comment).toContain('`pnpm size`');
  // Quiet by default: the other metrics did not move, so they contribute nothing.
  expect(comment).not.toContain('npm tarball');
});

test('a ratchet improvement is shown, but a removed suppression is not', () => {
  const better = commentOf({ head: snapshotFixture({ typeInversionTotal: 5 }) });
  expect(better).toContain('| R6 type inversions | 7 | 5 | -2 |');

  // fallowSuppressions is worseOnly: shrinking it is good news the Fallow job already reports.
  expect(commentOf({ head: snapshotFixture({ suppressions: 17 }) })).toBe(`${NO_DELTAS_LINE}\n`);
  expect(commentOf({ head: snapshotFixture({ suppressions: 21 }) })).toContain(
    '| Fallow suppressions | 19 | 21 | +2 |',
  );
});

test('a metric read from a stale artifact is marked rather than silently attributed to head', () => {
  const head = snapshotFixture({ jsGzipBytes: 900_000, sizeStale: true });
  expect(commentOf({ head })).toContain('| JS gzip (stale artifact) |');
});

test('an unproven (`unknown`) artifact caveats the job summary, not every row', () => {
  // #1423 reports `unknown` for every artifact whose producer stamps no commit, i.e. all of them
  // today; marking each row would caveat size and coverage forever.
  const head = snapshotFixture({ jsGzipBytes: 900_000 });
  const sizeReport = head.provenance.inputs.sizeReport!;
  const unknown = {
    ...head,
    provenance: {
      ...head.provenance,
      inputs: {
        ...head.provenance.inputs,
        sizeReport: { ...sizeReport, producerCommit: null, status: 'unknown' as const },
      },
    },
  };
  const comment = commentOf({ head: unknown });
  expect(comment).toContain('| JS gzip |');
  expect(comment).not.toContain('stale artifact');
  expect(summaryOf({ head: unknown })).toContain('freshness as `unknown`');
});

test('PR-local coverage rows are scored against a bound, not a baseline', () => {
  // 95% is comfortably above the gate threshold + margin, so it earns no row.
  expect(commentOf({ changedCoverage: changedCoverageFixture() })).toBe(`${NO_DELTAS_LINE}\n`);

  const weak = changedCoverageFixture({ pct: 61.5, coveredLines: 61, passed: false });
  const comment = commentOf({ changedCoverage: weak });
  expect(comment).toContain('| Changed-line coverage | — | 61.50% | < 80.00% |');
  expect(comment).toContain('`pnpm check:coverage-changed`');
});

test('slow-test breaches show as a row with the budget file as the fix target', () => {
  const slowTest = {
    offenders: [{ key: 'src/a.test.ts :: waits', durationMs: 6000, budgetMs: 2500, enforce: true }],
  };
  const comment = commentOf({ slowTest });
  expect(comment).toContain('| Slow-test budget breaches | — | 1 | > 0 |');
  expect(comment).toContain('scripts/vitest-slow-test-budgets.ts');
});

test('differing schemaVersions are refused instead of diffed, PR-local rows survive', () => {
  const report = computeQualityDelta(
    sources({
      base: snapshotFixture({ schemaVersion: 1 }),
      head: snapshotFixture({ schemaVersion: 2, jsGzipBytes: 900_000 }),
      changedCoverage: changedCoverageFixture({ pct: 40 }),
    }),
  );
  expect(report.schemaMismatch).toEqual({ base: 1, head: 2 });
  const comment = renderComment(report, CONTEXT);
  expect(comment).toContain('Refusing to diff snapshot schemaVersion 1 against 2');
  expect(comment).toContain('migration note');
  expect(comment).not.toContain('JS gzip');
  expect(comment).toContain('Changed-line coverage');
});

test('a baseline that is not the PR base is labelled as the nearest stored snapshot', () => {
  const head = snapshotFixture({ commit: 'b'.repeat(40), typeInversionTotal: 20 });
  const report = computeQualityDelta(sources({ head, baseExact: false }));
  const comment = renderComment(report, CONTEXT);
  // Otherwise main-side movement since the PR's base gets attributed to the PR.
  expect(comment).toContain('vs nearest main@`aaaaaaa` (PR base not in history yet)');
  expect(report.base?.exact).toBe(false);
  expect(renderJobSummary(report, CONTEXT)).toContain(
    'Deltas may include main-side changes this PR did not make.',
  );

  const exact = renderComment(computeQualityDelta(sources({ head })), CONTEXT);
  expect(exact).toContain('vs main@`aaaaaaa`');
  expect(exact).not.toContain('nearest');
});

test('without a baseline the comment says so in one line and notes it in the summary', () => {
  const report = computeQualityDelta(sources({ base: null, baseExact: false }));
  const comment = renderComment(report, CONTEXT);
  expect(comment.trim().split('\n')).toHaveLength(1);
  expect(comment).toContain('no main baseline');
  expect(renderJobSummary(report, CONTEXT)).toContain('The history job appends one snapshot');
});

test('the comment never exceeds the line budget and summarizes the overflow', () => {
  const head = snapshotFixture({
    jsGzipBytes: 900_000,
    npmTarballBytes: 1_400_000,
    typeInversionTotal: 20,
    typeCycleBaseline: 150,
    suppressions: 40,
    redundantEdges: 1900,
  });
  const report = computeQualityDelta(
    sources({
      head,
      changedCoverage: changedCoverageFixture({
        pct: 10,
        branch: { covered: 1, total: 20, pct: 5 },
        excluded: { files: [], totalLines: 80 },
      }),
      slowTest: { offenders: [{ key: 'a', durationMs: 9000, budgetMs: 2500, enforce: true }] },
    }),
  );
  // Every configured metric crossed, so this is the worst case the cap has to survive.
  expect(report.rows).toHaveLength(10);

  const comment = renderComment(report, { ...CONTEXT, maxLines: 10 });
  const lines = comment.trimEnd().split('\n');
  // maxLines counts the marker line run.ts prepends, which renderComment does not emit.
  expect(lines.length).toBe(9);
  expect(lines.at(-1)).toBe('+6 more, see the [job summary](https://run/1).');
  // The dropped rows are the least severe ones, and the summary still carries all ten.
  const summaryRows = renderJobSummary(report, CONTEXT)
    .split('\n')
    .filter((line) => line.startsWith('| '));
  expect(summaryRows).toHaveLength(12);
});

test('the default cap leaves room for every configured metric plus its header', () => {
  const report = computeQualityDelta(
    sources({
      head: snapshotFixture({ jsGzipBytes: 900_000 }),
      changedCoverage: changedCoverageFixture({ pct: 10 }),
    }),
  );
  expect(renderComment(report, CONTEXT).trimEnd().split('\n').length).toBeLessThanOrEqual(
    MAX_COMMENT_LINES - 1,
  );
});
