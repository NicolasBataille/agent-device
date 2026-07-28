// Who has to finish before the quality-delta comment can be rendered (#1424).
//
// The comment's rows come from two workflows that run CONCURRENTLY on the same head sha: CI
// (changed-line coverage, slow-test breaches) and Size (the size report). Rendering from inside
// either one is a race whose loser is permanent — the comment is posted once, so a size report that
// lands a minute later never reaches it. So rendering happens in a `workflow_run`-triggered
// workflow that fires on BOTH producers' completion and renders only on the LAST one to finish;
// earlier firings exit cleanly, because the later completion will fire the trigger again.
//
// This module is the pure decision: given the runs GitHub reports for a head sha, is everything the
// comment needs available, and from which run ids?

/** The fields this decision needs from GitHub's `actions/runs` payload. */
export type WorkflowRunSummary = {
  id: number;
  name: string;
  head_sha: string;
  /** 'queued' | 'in_progress' | 'completed' (GitHub also uses several waiting states). */
  status: string;
};

/** Workflow names that must have completed for the comment to carry all of its rows. */
export const PRODUCER_WORKFLOWS = ['CI', 'Size'] as const;

export type ProducerReadiness = {
  /** Every producer has a completed run for this head sha. */
  ready: boolean;
  /** Newest run id per producer, or null when it has not started for this sha. */
  runIds: Readonly<Record<string, number | null>>;
  /** Why rendering is deferred, for the job log. Empty when ready. */
  reason: string;
};

/**
 * The newest run per producer wins: a re-run of Size supersedes the earlier one, and its artifact is
 * the one a fresh comment should describe.
 */
function newestRunFor(
  runs: readonly WorkflowRunSummary[],
  workflow: string,
  headSha: string,
): WorkflowRunSummary | null {
  const matching = runs
    .filter((run) => run.name === workflow && run.head_sha === headSha)
    .sort((left, right) => right.id - left.id);
  return matching[0] ?? null;
}

export function producerReadiness(
  runs: readonly WorkflowRunSummary[],
  headSha: string,
): ProducerReadiness {
  const runIds: Record<string, number | null> = {};
  const pending: string[] = [];
  for (const workflow of PRODUCER_WORKFLOWS) {
    const run = newestRunFor(runs, workflow, headSha);
    runIds[workflow] = run?.id ?? null;
    if (run === null) pending.push(`${workflow} (no run for this sha)`);
    else if (run.status !== 'completed') pending.push(`${workflow} (${run.status})`);
  }
  return {
    ready: pending.length === 0,
    runIds,
    reason:
      pending.length === 0
        ? ''
        : `waiting for ${pending.join(', ')}; the last producer to complete renders the comment`,
  };
}
