// Pure model for the quiet quality-delta PR comment (#1424, Track C of #1412).
//
// It takes a head repo-health snapshot (#1423), the main-branch baseline for it (read from the
// JSONL history in history.ts), and the two PR-local reports that have no baseline by construction
// (changed-line coverage #1418, slow-test offenders), and answers one question per metric: is this
// worth a line? Only metrics that cross their own threshold in thresholds.ts become rows. When
// nothing crosses, the comment is exactly one line — the maintainer requirement is "do not drown
// people in information", so silence is the default output, not a fallback.
//
// Two refusals are deliberate:
//   - schemaVersion mismatch between baseline and head: the snapshot's field names are the delta
//     contract, so a version bump means the numbers may not mean the same thing. The comment says
//     so and drops every baseline-derived row instead of diffing across versions.
//   - a head metric read from a STALE artifact (repo-health provenance flags coverage/size when a
//     source file is newer than the artifact): the row is kept but marked, never silently paired
//     with the head commit.
//
// And one label: a baseline that is NOT the PR's own base commit (the history has no entry for it
// yet) renders as the nearest stored main snapshot, because such a delta can include main-side
// movement the PR did not cause.
//
// All I/O — reading files, resolving links, posting the comment — belongs to run.ts.

import type { ArtifactStatus, RepoHealthSnapshot } from '../repo-health/model.ts';
import {
  MAX_COMMENT_LINES,
  QUALITY_DELTA_METRICS,
  type DeltaSources,
  type MetricFormat,
  type MetricOwner,
  type MetricSpec,
} from './thresholds.ts';

const COMMENT_HEADING = 'Quality delta';
export const NO_DELTAS_LINE = 'No notable quality deltas.';

export type QualityDeltaRow = {
  key: string;
  label: string;
  format: MetricFormat;
  owner: MetricOwner;
  /** null for PR-local metrics, which are scored against a bound rather than a baseline. */
  base: number | null;
  head: number;
  delta: number | null;
  /** The bound or |delta| threshold the value crossed, for the "why is this here" column. */
  crossed: string;
  /** How many multiples of its threshold the row crossed by — the overflow drop order. */
  severity: number;
  /** The head value came from a read artifact that is older than the tree (repo-health provenance). */
  stale: boolean;
};

export type QualityDeltaReport = {
  rows: readonly QualityDeltaRow[];
  head: { commit: string; schemaVersion: number };
  base: { commit: string; schemaVersion: number; exact: boolean } | null;
  /** Baseline and head disagree on schemaVersion, so baseline-derived rows are refused. */
  schemaMismatch: { base: number; head: number } | null;
  /** Quiet degradations (missing inputs, absent baseline). Job summary only. */
  notes: readonly string[];
};

function formatValue(value: number, format: MetricFormat): string {
  if (format === 'pct') return `${value.toFixed(2)}%`;
  if (format === 'count') return String(value);
  const absolute = Math.abs(value);
  if (absolute < 1000) return `${value} B`;
  if (absolute < 1_000_000) return `${(value / 1000).toFixed(1)} kB`;
  return `${(value / 1_000_000).toFixed(2)} MB`;
}

function formatSigned(value: number, format: MetricFormat): string {
  const sign = value > 0 ? '+' : value < 0 ? '-' : '';
  return `${sign}${formatValue(Math.abs(value), format)}`;
}

function artifactStatus(snapshot: RepoHealthSnapshot, spec: MetricSpec): ArtifactStatus | null {
  const inputs = snapshot.provenance.inputs;
  if (spec.staleInput === 'sizeReport') return inputs.sizeReport?.status ?? null;
  if (spec.staleInput === 'coverageSummary') return inputs.coverageSummary?.status ?? null;
  return null;
}

/**
 * Only a PROVEN stale artifact marks its row. #1423 reports `unknown` whenever the producer stamps
 * no commit, which is every artifact today, so marking that too would put a caveat on every size and
 * coverage row forever — the comment fatigue this issue exists to remove. `unknown` gets one job
 * summary note instead.
 */
function staleInputFlag(snapshot: RepoHealthSnapshot, spec: MetricSpec): boolean {
  return artifactStatus(snapshot, spec) === 'stale';
}

function deltaRow(spec: MetricSpec, sources: DeltaSources): QualityDeltaRow | null {
  if (spec.kind !== 'delta' || sources.base === null) return null;
  const base = spec.read(sources.base);
  const head = spec.read(sources.head);
  if (base === null || head === null) return null;
  const delta = head - base;
  const worse = spec.direction === 'lower-is-better' ? delta > 0 : delta < 0;
  if (spec.worseOnly === true && !worse) return null;
  if (Math.abs(delta) < spec.minAbsDelta) return null;
  return {
    key: spec.key,
    label: spec.label,
    format: spec.format,
    owner: spec.owner,
    base,
    head,
    delta,
    crossed: formatSigned(delta, spec.format),
    severity: Math.abs(delta) / spec.minAbsDelta,
    stale: staleInputFlag(sources.head, spec),
  };
}

function absoluteRow(spec: MetricSpec, sources: DeltaSources): QualityDeltaRow | null {
  if (spec.kind !== 'absolute') return null;
  const head = spec.read(sources);
  if (head === null) return null;
  const higherIsBetter = spec.direction === 'higher-is-better';
  const crossed = higherIsBetter ? head < spec.bound : head > spec.bound;
  if (!crossed) return null;
  const comparator = higherIsBetter ? '<' : '>';
  const distance = Math.abs(head - spec.bound);
  return {
    key: spec.key,
    label: spec.label,
    format: spec.format,
    owner: spec.owner,
    base: null,
    head,
    delta: null,
    crossed: `${comparator} ${formatValue(spec.bound, spec.format)}`,
    severity: distance / Math.max(spec.bound, 1),
    stale: staleInputFlag(sources.head, spec),
  };
}

function missingInputNotes(sources: DeltaSources): string[] {
  const notes: string[] = [];
  if (sources.base === null) {
    notes.push(
      'No main-branch baseline for this PR yet — baseline-derived rows are omitted. ' +
        'The history job appends one snapshot per push to main (see scripts/quality-delta/README.md).',
    );
  } else if (!sources.baseExact) {
    notes.push(
      "The history has no entry for this PR's base commit yet, so the baseline is the nearest " +
        `stored main snapshot (\`${shortSha(sources.base.provenance.commit)}\`). Deltas may include ` +
        'main-side changes this PR did not make.',
    );
  }
  if (sources.head.metrics.size.available !== true) {
    notes.push(
      'Size metrics unavailable in the head snapshot (`pnpm size:markdown` produces them).',
    );
  }
  if (sources.changedCoverage === null) {
    notes.push('Changed-line coverage report unavailable (`pnpm check:coverage-changed --json`).');
  }
  if (sources.slowTest === null) {
    notes.push(
      'Slow-test report unavailable (the vitest reporter writes it during the coverage run).',
    );
  }
  const unverified = QUALITY_DELTA_METRICS.filter(
    (spec) => artifactStatus(sources.head, spec) === 'unknown',
  );
  if (unverified.length > 0) {
    notes.push(
      'Size and coverage are read artifacts whose producers stamp no commit, so repo-health reports ' +
        'their freshness as `unknown` (#1423): treat those rows as not provably current with the head tree.',
    );
  }
  return notes;
}

export function computeQualityDelta(sources: DeltaSources): QualityDeltaReport {
  const schemaMismatch =
    sources.base !== null && sources.base.schemaVersion !== sources.head.schemaVersion
      ? { base: sources.base.schemaVersion, head: sources.head.schemaVersion }
      : null;
  // Refusing to diff across schema versions is the point, not an edge case: the field names ARE
  // the contract (#1423 amendment), so a bump needs a migration note before deltas mean anything.
  const comparable: DeltaSources = schemaMismatch === null ? sources : { ...sources, base: null };
  const rows = QUALITY_DELTA_METRICS.flatMap((spec) => {
    const row = deltaRow(spec, comparable) ?? absoluteRow(spec, comparable);
    return row === null ? [] : [row];
  }).sort((left, right) => right.severity - left.severity);

  return {
    rows,
    head: { commit: sources.head.provenance.commit, schemaVersion: sources.head.schemaVersion },
    base:
      sources.base === null
        ? null
        : {
            commit: sources.base.provenance.commit,
            schemaVersion: sources.base.schemaVersion,
            exact: sources.baseExact,
          },
    schemaMismatch,
    notes: schemaMismatch === null ? missingInputNotes(sources) : missingInputNotes(comparable),
  };
}

// ---- Rendering --------------------------------------------------------------------------------

export type RenderContext = {
  /** `https://host/owner/repo/blob/<sha>`; when absent (local runs) paths render as plain code. */
  linkBase: string | null;
  /** Where overflow rows and every note live. */
  summaryUrl: string | null;
  /** Overridable only so the test can prove the cap, not a knob for callers. */
  maxLines?: number;
};

function ownerCell(owner: MetricOwner, linkBase: string | null): string {
  const target =
    linkBase === null ? `\`${owner.path}\`` : `[${owner.gate}](${linkBase}/${owner.path})`;
  return `${target} · \`${owner.fix}\``;
}

function rowLine(row: QualityDeltaRow, linkBase: string | null): string {
  const label = row.stale ? `${row.label} (stale artifact)` : row.label;
  const base = row.base === null ? '—' : formatValue(row.base, row.format);
  return `| ${label} | ${base} | ${formatValue(row.head, row.format)} | ${row.crossed} | ${ownerCell(row.owner, linkBase)} |`;
}

function shortSha(commit: string): string {
  return commit.slice(0, 7);
}

function headingLine(report: QualityDeltaReport): string {
  if (report.base === null) return `### ${COMMENT_HEADING} vs no main baseline`;
  const sha = `main@\`${shortSha(report.base.commit)}\``;
  // An inexact baseline is labelled in the heading, not buried in the job summary: the reader is
  // about to attribute these numbers to the PR, and part of them may belong to main.
  return report.base.exact
    ? `### ${COMMENT_HEADING} vs ${sha}`
    : `### ${COMMENT_HEADING} vs nearest ${sha} (PR base not in history yet)`;
}

function summaryLink(summaryUrl: string | null): string {
  return summaryUrl === null ? 'the job summary' : `the [job summary](${summaryUrl})`;
}

function migrationRefusalLine(report: QualityDeltaReport): string | null {
  const mismatch = report.schemaMismatch;
  if (mismatch === null) return null;
  return (
    `Refusing to diff snapshot schemaVersion ${mismatch.base} against ${mismatch.head}: ` +
    'write a migration note in scripts/quality-delta/README.md, then rerun.'
  );
}

/**
 * The sticky-comment body, without the marker line the caller owns (scripts/size-report.mjs
 * `--post-comment` machinery keeps it a single in-place comment). Never longer than
 * `MAX_COMMENT_LINES` minus that marker: overflow rows are dropped lowest-severity-first and
 * summarized, because a 60-row comment is the failure mode this issue exists to prevent.
 */
export function renderComment(report: QualityDeltaReport, context: RenderContext): string {
  const maxLines = (context.maxLines ?? MAX_COMMENT_LINES) - 1;
  const refusal = migrationRefusalLine(report);
  if (report.rows.length === 0) {
    if (refusal !== null) return `${refusal}\n`;
    if (report.base === null) {
      return `${COMMENT_HEADING}: no main baseline for \`${shortSha(report.head.commit)}\` yet — see ${summaryLink(context.summaryUrl)}.\n`;
    }
    return `${NO_DELTAS_LINE}\n`;
  }

  const header = [
    headingLine(report),
    ...(refusal === null ? [] : [refusal]),
    '',
    '| Metric | Base | Head | Δ / bound | Gate · fix |',
    '| --- | --- | --- | --- | --- |',
  ];
  const budget = maxLines - header.length;
  const overflows = report.rows.length > budget;
  const shown = overflows ? report.rows.slice(0, Math.max(budget - 1, 0)) : report.rows;
  const footer = overflows
    ? [`+${report.rows.length - shown.length} more, see ${summaryLink(context.summaryUrl)}.`]
    : [];

  return `${[...header, ...shown.map((row) => rowLine(row, context.linkBase)), ...footer].join('\n')}\n`;
}

/** The unabridged report: every row, every note, and the provenance the rows were derived from. */
export function renderJobSummary(report: QualityDeltaReport, context: RenderContext): string {
  const lines = [
    `## ${COMMENT_HEADING}`,
    '',
    `Head snapshot \`${shortSha(report.head.commit)}\` (schemaVersion ${report.head.schemaVersion}); ` +
      (report.base === null
        ? 'no main baseline.'
        : `baseline \`${shortSha(report.base.commit)}\` (schemaVersion ${report.base.schemaVersion}).`),
    '',
  ];
  const refusal = migrationRefusalLine(report);
  if (refusal !== null) lines.push(refusal, '');
  if (report.rows.length === 0) {
    lines.push(NO_DELTAS_LINE, '');
  } else {
    lines.push(
      '| Metric | Base | Head | Δ / bound | Gate · fix |',
      '| --- | --- | --- | --- | --- |',
    );
    for (const row of report.rows) lines.push(rowLine(row, context.linkBase));
    lines.push('');
  }
  if (report.notes.length > 0) {
    lines.push('Notes:', ...report.notes.map((note) => `- ${note}`), '');
  }
  return `${lines.join('\n')}\n`;
}
