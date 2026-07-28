// The main-branch metric history: an append-only JSONL store of repo-health snapshots (#1424).
//
// One line per push to main, one file per month (`history/YYYY-MM.jsonl`), so looking a commit up
// is a bounded read of the month it landed in rather than a growing whole-file parse (a snapshot
// serializes to ~11 kB, so a month of merges is ~1 MB). Lines are append-only and never rewritten,
// which is what makes the store queryable by commit sha and safe to fetch shallowly.
//
// This module is pure: it parses, keys, and folds text. The workflow owns git and run.ts owns fs.

import type { RepoHealthSnapshot } from '../repo-health/model.ts';

/** Directory inside the history ref holding the monthly shards. */
export const HISTORY_DIR = 'history';

/** The shard a snapshot belongs to, keyed by the month it was generated in (UTC). */
export function historyShardName(generatedAt: string): string {
  const at = new Date(generatedAt);
  const month = `${at.getUTCMonth() + 1}`.padStart(2, '0');
  return `${at.getUTCFullYear()}-${month}.jsonl`;
}

/** One snapshot as one line — compact, so a shard stays greppable by sha. */
export function serializeEntry(snapshot: RepoHealthSnapshot): string {
  return JSON.stringify(snapshot);
}

export type ParsedHistory = {
  entries: readonly RepoHealthSnapshot[];
  /** Lines that were not parseable snapshots. Reported, never silently dropped. */
  malformed: number;
};

export function parseHistory(text: string): ParsedHistory {
  const entries: RepoHealthSnapshot[] = [];
  let malformed = 0;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const parsed = JSON.parse(line) as RepoHealthSnapshot;
      if (
        typeof parsed.schemaVersion === 'number' &&
        typeof parsed.provenance?.commit === 'string'
      ) {
        entries.push(parsed);
      } else {
        malformed += 1;
      }
    } catch {
      malformed += 1;
    }
  }
  return { entries, malformed };
}

export type AppendOutcome = {
  text: string;
  /** False when an entry for the same commit is already stored — reruns of main are idempotent. */
  appended: boolean;
};

/**
 * Append one snapshot to a shard's text. A commit already present wins: the history is keyed by
 * commit sha, so a re-run of a main build must not create a second, differently-timestamped entry
 * for the same tree.
 */
export function appendEntry(existingText: string, snapshot: RepoHealthSnapshot): AppendOutcome {
  const { entries } = parseHistory(existingText);
  if (entries.some((entry) => entry.provenance.commit === snapshot.provenance.commit)) {
    return { text: existingText, appended: false };
  }
  const prefix =
    existingText === '' || existingText.endsWith('\n') ? existingText : `${existingText}\n`;
  return { text: `${prefix}${serializeEntry(snapshot)}\n`, appended: true };
}

export type BaselineLookup = {
  snapshot: RepoHealthSnapshot;
  /** True when the store held the requested commit; false when this is the newest entry instead. */
  exact: boolean;
};

/**
 * The baseline for a PR: the entry for `commit` when main has one, otherwise the newest entry.
 * The fallback exists because a PR's base commit may not have finished its history job yet — a
 * near baseline states a real delta, while no baseline states nothing at all.
 */
export function findBaseline(
  entries: readonly RepoHealthSnapshot[],
  commit: string | null,
): BaselineLookup | null {
  if (entries.length === 0) return null;
  if (commit !== null && commit !== '') {
    const exact = entries.find(
      (entry) => entry.provenance.commit === commit || entry.provenance.commit.startsWith(commit),
    );
    if (exact) return { snapshot: exact, exact: true };
  }
  const newest = [...entries].sort((left, right) =>
    left.provenance.generatedAt.localeCompare(right.provenance.generatedAt),
  );
  const last = newest.at(-1);
  return last === undefined ? null : { snapshot: last, exact: false };
}
