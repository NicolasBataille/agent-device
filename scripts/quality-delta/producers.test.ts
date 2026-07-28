// The artifact-race policy (#1424): the comment renders only after BOTH producers finish, and the
// wiring that guarantees it is a `workflow_run` trigger on both of them. Both halves are pinned
// here, because the failure mode is silent — a comment that permanently lacks size rows still looks
// like a perfectly good comment.

import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { parse } from 'yaml';
import {
  producerReadiness,
  PRODUCER_WORKFLOWS,
  selectRenderTarget,
  type PullRequestSummary,
  type WorkflowRunSummary,
} from './producers.ts';

const HEAD = 'a'.repeat(40);

function run(overrides: Partial<WorkflowRunSummary>): WorkflowRunSummary {
  return { id: 1, name: 'CI', head_sha: HEAD, status: 'completed', ...overrides };
}

test('rendering waits until every producer completed for this head sha', () => {
  const both = [run({ id: 1, name: 'CI' }), run({ id: 2, name: 'Size' })];
  expect(producerReadiness(both, HEAD)).toEqual({
    ready: true,
    runIds: { CI: 1, Size: 2 },
    reason: '',
  });

  const sizeRunning = [
    run({ id: 1, name: 'CI' }),
    run({ id: 2, name: 'Size', status: 'in_progress' }),
  ];
  const deferred = producerReadiness(sizeRunning, HEAD);
  expect(deferred.ready).toBe(false);
  expect(deferred.reason).toContain('Size (in_progress)');
  // The later completion fires the trigger again, so deferring loses nothing.
  expect(deferred.reason).toContain('last producer to complete renders the comment');

  const onlyCi = [run({ id: 1, name: 'CI' })];
  expect(producerReadiness(onlyCi, HEAD).reason).toContain('Size (no run for this sha)');
});

test('runs for another head sha never make this one look ready', () => {
  const other = [
    run({ id: 1, name: 'CI' }),
    run({ id: 2, name: 'Size', head_sha: 'b'.repeat(40) }),
  ];
  const readiness = producerReadiness(other, HEAD);
  expect(readiness.ready).toBe(false);
  expect(readiness.runIds.Size).toBe(null);
});

test('a re-run supersedes the earlier run of the same producer', () => {
  const rerun = [
    run({ id: 1, name: 'CI' }),
    run({ id: 2, name: 'Size', status: 'completed' }),
    run({ id: 9, name: 'Size', status: 'in_progress' }),
  ];
  const readiness = producerReadiness(rerun, HEAD);
  expect(readiness.ready).toBe(false);
  expect(readiness.runIds.Size).toBe(9);
});

test('a superseded head renders nothing, so a late run cannot overwrite newer metrics', () => {
  const pull = (head: string, state = 'open'): PullRequestSummary => ({
    number: 1477,
    state,
    head: { sha: head },
    base: { sha: 'base'.repeat(10) },
  });

  expect(selectRenderTarget([pull(HEAD)], HEAD)).toEqual({
    number: 1477,
    baseSha: 'base'.repeat(10),
  });
  // The PR's head moved on while this run was finishing: its metrics describe an old tree.
  expect(selectRenderTarget([pull('b'.repeat(40))], HEAD)).toBe(null);
  expect(selectRenderTarget([pull(HEAD, 'closed')], HEAD)).toBe(null);
  expect(selectRenderTarget([], HEAD)).toBe(null);
});

test('the rendering workflow triggers on both producers and gates every step on readiness', () => {
  const workflow = parse(readFileSync('.github/workflows/quality-delta.yml', 'utf8')) as {
    on: { workflow_run: { workflows: string[]; types: string[] } };
    concurrency: { group: string; 'cancel-in-progress': boolean };
    jobs: Record<string, { if: string; steps: { name: string; if?: string }[] }>;
  };
  expect(workflow.on.workflow_run.workflows.toSorted()).toEqual([...PRODUCER_WORKFLOWS].toSorted());
  expect(workflow.on.workflow_run.types).toEqual(['completed']);

  // Serialized per PR (sha fallback for fork triggers), so a newer head cancels an older renderer
  // even while it is mid-write; a sha-keyed group could not.
  expect(workflow.concurrency.group).toContain('workflow_run.pull_requests[0].number');
  expect(workflow.concurrency.group).toContain('workflow_run.head_sha');
  expect(workflow.concurrency['cancel-in-progress']).toBe(true);

  const job = workflow.jobs.comment!;
  // Fork PRs must not be checked out by a write-token workflow, and get job summaries instead.
  expect(job.if).toContain('head_repository.full_name == github.repository');

  const gated = job.steps.filter((step) =>
    step.if?.includes("steps.producers.outputs.ready == 'true'"),
  );
  // Everything after the readiness check is gated on it; the checkout and the check itself are not.
  expect(gated).toHaveLength(job.steps.length - 2);

  // Posting uses the PR the gate verified is still on this head, never a second, ungated lookup.
  const post = job.steps.find((step) => step.name === 'Comment on the PR')!;
  expect(post.if).toContain("steps.producers.outputs.ready == 'true'");
  expect(JSON.stringify(post)).toContain('steps.producers.outputs.pr_number');
  // …and the write path re-verifies the head itself, covering the gap between gate and write.
  expect(JSON.stringify(post)).toContain('--expect-head');
});

test('no other workflow posts a PR comment', () => {
  // Comment fatigue is the constraint (#1424): exactly one workflow may write the sticky comment.
  const posting = ['ci', 'size', 'quality-delta', 'repo-health-history'].filter((name) =>
    readFileSync(`.github/workflows/${name}.yml`, 'utf8').includes('--post-comment'),
  );
  expect(posting).toEqual(['quality-delta']);
});
