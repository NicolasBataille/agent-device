// CLI shell for the render-readiness decision (#1424):
//
//   gh api "repos/$REPO/actions/runs?head_sha=$SHA&per_page=100" > .tmp/runs.json
//   gh api "repos/$REPO/commits/$SHA/pulls" > .tmp/pulls.json
//   pnpm quality-delta:producers --runs .tmp/runs.json --pulls .tmp/pulls.json --head-sha "$SHA"
//
// Writes `ready`, `ci_run_id`, `size_run_id`, `pr_number`, and `pr_base_sha` to $GITHUB_OUTPUT.
// `ready` is false both while a producer is still running and when the sha has been SUPERSEDED (the
// PR's head moved on), so a late renderer cannot overwrite the sticky comment with older metrics.
// Exit code stays 0 either way: "not this run" is a normal outcome, not a failure.

import fs from 'node:fs';
import { parseScriptArgs } from '../lib/cli-args.ts';
import { runAsMain } from '../lib/run-as-main.ts';
import {
  producerReadiness,
  selectRenderTarget,
  type ProducerReadiness,
  type PullRequestSummary,
  type RenderTarget,
  type WorkflowRunSummary,
} from './producers.ts';

const USAGE = `Usage: pnpm quality-delta:producers --runs <path> --pulls <path> --head-sha <sha>

Options:
  --runs <path>      JSON from GitHub's actions/runs API (its workflow_runs array).
  --pulls <path>     JSON from GitHub's commits/<sha>/pulls API.
  --head-sha <sha>   The head commit the comment will describe.
`;

type RenderDecision = {
  ready: boolean;
  reason: string;
  runIds: Readonly<Record<string, number | null>>;
  target: RenderTarget | null;
};

/** An absent value is an EMPTY output, which the workflow's `!= ''` guards read as "do not use". */
function optional(value: string | number | null | undefined): string {
  return value === null || value === undefined ? '' : String(value);
}

function outputLines(decision: RenderDecision): string[] {
  return [
    `ready=${decision.ready}`,
    `ci_run_id=${optional(decision.runIds.CI)}`,
    `size_run_id=${optional(decision.runIds.Size)}`,
    `pr_number=${optional(decision.target?.number)}`,
    `pr_base_sha=${optional(decision.target?.baseSha)}`,
    '',
  ];
}

function writeStepOutputs(decision: RenderDecision): void {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) return;
  fs.appendFileSync(outputPath, outputLines(decision).join('\n'));
}

function requiredArgs(argv: readonly string[]): {
  runsPath: string;
  pullsPath: string;
  headSha: string;
} {
  const values = parseScriptArgs(argv, USAGE, {
    runs: { type: 'string' },
    pulls: { type: 'string' },
    'head-sha': { type: 'string' },
  });
  const runsPath = values.runs;
  const pullsPath = values.pulls;
  const headSha = values['head-sha'];
  if (
    typeof runsPath !== 'string' ||
    typeof pullsPath !== 'string' ||
    typeof headSha !== 'string'
  ) {
    throw new Error('--runs, --pulls and --head-sha are required');
  }
  return { runsPath, pullsPath, headSha };
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

function readRuns(runsPath: string): readonly WorkflowRunSummary[] {
  return readJson<{ workflow_runs?: WorkflowRunSummary[] }>(runsPath).workflow_runs ?? [];
}

/** Why this run is not rendering, for the job log. Empty when it is. */
function deferralReason(
  readiness: ProducerReadiness,
  target: RenderTarget | null,
  headSha: string,
): string {
  if (!readiness.ready) return readiness.reason;
  if (target === null) return `${headSha.slice(0, 12)} is not the head of an open PR any more`;
  return '';
}

/** Both halves of "may this run post": every producer finished, and the sha is still the PR's head. */
function decide(argv: readonly string[]): RenderDecision {
  const { runsPath, pullsPath, headSha } = requiredArgs(argv);
  const readiness = producerReadiness(readRuns(runsPath), headSha);
  const target = selectRenderTarget(readJson<PullRequestSummary[]>(pullsPath), headSha);
  const reason = deferralReason(readiness, target, headSha);
  return { ready: reason === '', reason, runIds: readiness.runIds, target };
}

function run(argv: readonly string[]): number {
  const decision = decide(argv);
  const verdict = decision.ready ? `rendering PR #${decision.target?.number}` : decision.reason;
  process.stdout.write(`quality-delta: ${verdict}.\n`);
  writeStepOutputs(decision);
  return 0;
}

runAsMain(import.meta.url, 'quality-delta:producers', run);
