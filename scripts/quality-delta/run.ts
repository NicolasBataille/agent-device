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
import { findBaseline, HISTORY_DIR, parseHistory } from './history.ts';
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
 * The sticky-comment marker owned by scripts/size-report.mjs. The comment this command renders IS
 * that comment, evolved: same marker, same update-in-place machinery, so a PR keeps exactly one.
 * scripts/quality-delta/run.test.ts fails if the two ever drift apart.
 */
export const STICKY_COMMENT_MARKER = '<!-- agent-device-size-report -->';

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

function readBaselineFromHistory(
  historyDir: string,
  baseSha: string | null,
): RepoHealthSnapshot | null {
  let newest: RepoHealthSnapshot | null = null;
  for (const shard of shardPaths(historyDir)) {
    const { entries } = parseHistory(fs.readFileSync(shard, 'utf8'));
    const found = findBaseline(entries, baseSha);
    if (found === null) continue;
    if (found.exact) return found.snapshot;
    newest ??= found.snapshot;
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
  const baseSha = values['base-sha'] ?? process.env.GITHUB_BASE_SHA ?? null;
  const base =
    readJsonIfExists<RepoHealthSnapshot>(values.baseline) ??
    (values['history-dir'] === undefined
      ? null
      : readBaselineFromHistory(values['history-dir'], baseSha));

  const report = computeQualityDelta({
    head,
    base,
    changedCoverage: readJsonIfExists<ChangedCoverageResult>(values['changed-coverage']),
    slowTest: readJsonIfExists<SlowTestReport>(values['slow-test']),
  });

  const context = githubUrls(head.provenance.commit);
  const comment = `${STICKY_COMMENT_MARKER}\n${renderComment(report, context)}`;
  if (typeof values.markdown === 'string') writeFile(values.markdown, comment);

  const summary = renderJobSummary(report, context);
  process.stdout.write(summary);
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) fs.appendFileSync(summaryPath, summary);
  return 0;
}

runAsMain(import.meta.url, 'quality-delta', run);
