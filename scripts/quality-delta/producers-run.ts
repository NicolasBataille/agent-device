// CLI shell for the producer-readiness decision (#1424):
//
//   gh api "repos/$REPO/actions/runs?head_sha=$SHA&per_page=100" > .tmp/runs.json
//   pnpm quality-delta:producers --runs .tmp/runs.json --head-sha "$SHA"
//
// Writes `ready`, `ci_run_id`, and `size_run_id` to $GITHUB_OUTPUT so the rendering workflow can
// skip cleanly while a producer is still running. Exit code stays 0 either way: "not yet" is a
// normal outcome, not a failure.

import fs from 'node:fs';
import { parseScriptArgs } from '../lib/cli-args.ts';
import { runAsMain } from '../lib/run-as-main.ts';
import { producerReadiness, type ProducerReadiness, type WorkflowRunSummary } from './producers.ts';

const USAGE = `Usage: pnpm quality-delta:producers --runs <path> --head-sha <sha>

Options:
  --runs <path>      JSON from GitHub's actions/runs API (its workflow_runs array).
  --head-sha <sha>   The head commit the comment will describe.
`;

/** The run ids the rendering steps need, so they can download from the right runs. */
function writeStepOutputs(readiness: ProducerReadiness): void {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) return;
  fs.appendFileSync(
    outputPath,
    [
      `ready=${readiness.ready}`,
      `ci_run_id=${readiness.runIds.CI ?? ''}`,
      `size_run_id=${readiness.runIds.Size ?? ''}`,
      '',
    ].join('\n'),
  );
}

function requiredArgs(argv: readonly string[]): { runsPath: string; headSha: string } {
  const values = parseScriptArgs(argv, USAGE, {
    runs: { type: 'string' },
    'head-sha': { type: 'string' },
  });
  const runsPath = values.runs;
  const headSha = values['head-sha'];
  if (typeof runsPath !== 'string' || typeof headSha !== 'string') {
    throw new Error('--runs and --head-sha are required');
  }
  return { runsPath, headSha };
}

function readRuns(runsPath: string): readonly WorkflowRunSummary[] {
  const payload = JSON.parse(fs.readFileSync(runsPath, 'utf8')) as {
    workflow_runs?: WorkflowRunSummary[];
  };
  return payload.workflow_runs ?? [];
}

function run(argv: readonly string[]): number {
  const { runsPath, headSha } = requiredArgs(argv);
  const readiness = producerReadiness(readRuns(runsPath), headSha);
  const verdict = readiness.ready
    ? `every producer completed for ${headSha.slice(0, 12)}`
    : readiness.reason;
  process.stdout.write(`quality-delta: ${verdict}.\n`);
  writeStepOutputs(readiness);
  return 0;
}

runAsMain(import.meta.url, 'quality-delta:producers', run);
