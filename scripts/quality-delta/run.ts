// The quality-delta report command (#1424, Track C of #1412):
//
//   pnpm quality-delta --head .tmp/repo-health.json --history-dir .tmp/metric-history \
//                      --base-sha <sha> --markdown .tmp/quality-delta.md
//
// Renders the sticky PR comment body (posted in place by scripts/size-report.mjs
// `--post-comment`, whose marker this file reuses — one comment surface, no new bots) plus the
// unabridged job summary. Thresholds and gate ownership live in thresholds.ts; the comparison and
// the line budget live in model.ts; this file only reads inputs and writes outputs.
//
// It never gates. Every input except the head snapshot is optional: a missing baseline, coverage
// report, or slow-test report costs the rows it would have produced and a job-summary note, which
// is the quiet degradation fork PRs and docs-only PRs rely on.

import fs from 'node:fs';
import path from 'node:path';
import { parseScriptArgs } from '../lib/cli-args.ts';
import { runAsMain } from '../lib/run-as-main.ts';
import type { ChangedCoverageResult } from '../coverage-changed/model.ts';
import type { RepoHealthSnapshot } from '../repo-health/model.ts';
import type { SlowTestReport } from '../vitest-slow-test-budgets.ts';
import { findBaseline, HISTORY_DIR, parseHistory, type BaselineLookup } from './history.ts';
import { computeQualityDelta, renderComment, renderJobSummary } from './model.ts';

const USAGE = `Usage: pnpm quality-delta [options]

Options:
  --head <path>              Head repo-health snapshot JSON (default .tmp/repo-health.json).
  --history-dir <path>       Checkout of the main-branch history ref (its ${HISTORY_DIR}/ shards).
  --baseline <path>          Use this snapshot as the baseline instead of the history.
  --base-sha <sha>           Commit to key the baseline on (default GITHUB_BASE_SHA).
  --changed-coverage <path>  Changed-line coverage JSON from pnpm check:coverage-changed --json.
  --slow-test <path>         Slow-test offenders JSON written during the coverage run.
  --markdown <path>          Write the comment body (marker included) for --post-comment.
`;

/**
 * The sticky-comment marker owned by scripts/size-report.mjs, whose `--post-comment` machinery
 * posts this body and updates it in place. One marker, one comment per PR, no second bot — size is
 * now one row family inside it. scripts/quality-delta/run.test.ts fails if the two drift apart.
 */
export const STICKY_COMMENT_MARKER = '<!-- agent-device-quality-delta -->';

function readJsonIfExists<T>(filePath: string | undefined): T | null {
  if (filePath === undefined || !fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

/** Newest shard first: the baseline is almost always in the current month. */
function shardPaths(historyDir: string): string[] {
  const dir = path.join(historyDir, HISTORY_DIR);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.jsonl'))
    .sort((left, right) => right.localeCompare(left))
    .map((name) => path.join(dir, name));
}

/**
 * The baseline and whether it is the PR's own base commit. An inexact hit is kept (a near baseline
 * states a real delta) but reported as such, so the comment can say the numbers may include
 * main-side movement instead of attributing all of it to the PR.
 */
function readBaselineFromHistory(
  historyDir: string,
  baseSha: string | null,
): BaselineLookup | null {
  let newest: BaselineLookup | null = null;
  for (const shard of shardPaths(historyDir)) {
    const { entries } = parseHistory(fs.readFileSync(shard, 'utf8'));
    const found = findBaseline(entries, baseSha);
    if (found === null) continue;
    if (found.exact) return found;
    newest ??= found;
  }
  return newest;
}

function githubUrls(commit: string): { linkBase: string | null; summaryUrl: string | null } {
  const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = process.env;
  if (!GITHUB_SERVER_URL || !GITHUB_REPOSITORY) return { linkBase: null, summaryUrl: null };
  const repoUrl = `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}`;
  return {
    linkBase: `${repoUrl}/blob/${commit}`,
    summaryUrl: GITHUB_RUN_ID ? `${repoUrl}/actions/runs/${GITHUB_RUN_ID}` : null,
  };
}

function writeFile(filePath: string, contents: string): void {
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, contents);
}

/** The baseline to diff against: an explicitly passed snapshot, or the history's best hit. */
function resolveBaseline(
  baselinePath: string | undefined,
  historyDir: string | undefined,
  baseSha: string | null,
): BaselineLookup | null {
  // An explicitly passed baseline is the caller's assertion that it IS the base.
  const explicit = readJsonIfExists<RepoHealthSnapshot>(baselinePath);
  if (explicit !== null) return { snapshot: explicit, exact: true };
  if (historyDir === undefined) return null;
  return readBaselineFromHistory(historyDir, baseSha);
}

/** stdout always, the job summary when GitHub gave us one: it is the comment's overflow surface. */
function emitSummary(summary: string): void {
  process.stdout.write(summary);
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) fs.appendFileSync(summaryPath, summary);
}

function run(argv: readonly string[]): number {
  const values = parseScriptArgs(argv, USAGE, {
    head: { type: 'string', default: '.tmp/repo-health.json' },
    'history-dir': { type: 'string' },
    baseline: { type: 'string' },
    'base-sha': { type: 'string' },
    'changed-coverage': { type: 'string' },
    'slow-test': { type: 'string' },
    markdown: { type: 'string' },
  });

  const head = readJsonIfExists<RepoHealthSnapshot>(values.head);
  if (head === null) {
    throw new Error(
      `no repo-health snapshot at ${values.head}. Run \`pnpm repo-health --out\` first.`,
    );
  }
  const lookup = resolveBaseline(
    values.baseline,
    values['history-dir'],
    values['base-sha'] ?? process.env.GITHUB_BASE_SHA ?? null,
  );

  const report = computeQualityDelta({
    head,
    base: lookup?.snapshot ?? null,
    baseExact: lookup?.exact ?? false,
    changedCoverage: readJsonIfExists<ChangedCoverageResult>(values['changed-coverage']),
    slowTest: readJsonIfExists<SlowTestReport>(values['slow-test']),
  });

  const context = githubUrls(head.provenance.commit);
  const comment = `${STICKY_COMMENT_MARKER}\n${renderComment(report, context)}`;
  if (typeof values.markdown === 'string') writeFile(values.markdown, comment);

  emitSummary(renderJobSummary(report, context));
  return 0;
}

runAsMain(import.meta.url, 'quality-delta', run);
