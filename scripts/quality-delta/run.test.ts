// End-to-end coverage of the two quality-delta CLIs. Both are spawned as subprocesses (they are
// exercised through argument handling and the files they write), which is why this file lives in
// the `subprocess-stub` vitest project rather than `unit-core` — see #1412 coordination rule 4.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { changedCoverageFixture, snapshotFixture } from './fixtures.ts';
import { HISTORY_DIR } from './history.ts';
import { STICKY_COMMENT_MARKER } from './run.ts';

function runScript(
  script: string,
  args: readonly string[],
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(
    process.execPath,
    ['--experimental-strip-types', `scripts/quality-delta/${script}`, ...args],
    { encoding: 'utf8', env: { ...process.env, GITHUB_STEP_SUMMARY: '' } },
  );
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function workdir(): string {
  return mkdtempSync(join(tmpdir(), 'quality-delta-'));
}

function writeJson(dir: string, name: string, value: unknown): string {
  const target = join(dir, name);
  writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
  return target;
}

test('the sticky-comment marker stays the one scripts/size-report.mjs posts', () => {
  // The comment IS the evolved size-report comment: a drifting marker would silently produce a
  // second comment per PR instead of updating one in place.
  const sizeReport = readFileSync('scripts/size-report.mjs', 'utf8');
  expect(sizeReport).toContain(`const COMMENT_MARKER = '${STICKY_COMMENT_MARKER}'`);
});

test('the CLI writes a marker-prefixed comment and prints the full summary', () => {
  const dir = workdir();
  const head = writeJson(
    dir,
    'head.json',
    snapshotFixture({ commit: 'b'.repeat(40), jsGzipBytes: 900_000 }),
  );
  const base = writeJson(dir, 'base.json', snapshotFixture());
  const coverage = writeJson(
    dir,
    'coverage.json',
    changedCoverageFixture({ pct: 55, passed: false }),
  );
  const markdown = join(dir, 'comment.md');

  const { status, stdout } = runScript('run.ts', [
    '--head',
    head,
    '--baseline',
    base,
    '--changed-coverage',
    coverage,
    '--markdown',
    markdown,
  ]);
  expect(status, stdout).toBe(0);

  const comment = readFileSync(markdown, 'utf8');
  expect(comment.startsWith(`${STICKY_COMMENT_MARKER}\n`)).toBe(true);
  expect(comment).toContain('JS gzip');
  expect(comment).toContain('Changed-line coverage');
  expect(comment.trimEnd().split('\n').length).toBeLessThanOrEqual(20);
  expect(stdout).toContain('## Quality delta');
});

test('the CLI resolves its baseline out of the JSONL history by base sha', () => {
  const dir = workdir();
  const historyDir = join(dir, 'history-ref');
  mkdirSync(join(historyDir, HISTORY_DIR), { recursive: true });
  const baseSha = '3'.repeat(40);
  writeFileSync(
    join(historyDir, HISTORY_DIR, '2026-07.jsonl'),
    [
      JSON.stringify(
        snapshotFixture({ commit: '9'.repeat(40), generatedAt: '2026-07-02T00:00:00.000Z' }),
      ),
      JSON.stringify(
        snapshotFixture({
          commit: baseSha,
          generatedAt: '2026-07-08T00:00:00.000Z',
          typeInversionTotal: 7,
        }),
      ),
      '',
    ].join('\n'),
  );
  const head = writeJson(
    dir,
    'head.json',
    snapshotFixture({ commit: 'b'.repeat(40), typeInversionTotal: 5 }),
  );

  const { status, stdout } = runScript('run.ts', [
    '--head',
    head,
    '--history-dir',
    historyDir,
    '--base-sha',
    baseSha,
  ]);
  expect(status, stdout).toBe(0);
  expect(stdout).toContain(`baseline \`${baseSha.slice(0, 7)}\``);
  expect(stdout).toContain('R6 type inversions');
});

test('a missing head snapshot fails loudly, missing optional inputs do not', () => {
  const dir = workdir();
  const missing = runScript('run.ts', ['--head', join(dir, 'nope.json')]);
  expect(missing.status).toBe(1);
  expect(missing.stderr).toContain('pnpm repo-health --out');

  const head = writeJson(dir, 'head.json', snapshotFixture());
  const degraded = runScript('run.ts', ['--head', head]);
  expect(degraded.status, degraded.stderr).toBe(0);
  expect(degraded.stdout).toContain('no main baseline');
});

test('appending to the history is idempotent per commit', () => {
  const dir = workdir();
  const snapshot = writeJson(dir, 'snapshot.json', snapshotFixture({ commit: '7'.repeat(40) }));
  const historyDir = join(dir, 'history-ref');

  const first = runScript('append-history.ts', [
    '--snapshot',
    snapshot,
    '--history-dir',
    historyDir,
  ]);
  expect(first.status, first.stderr).toBe(0);
  expect(first.stdout).toContain('appended');
  const shard = join(historyDir, HISTORY_DIR, '2026-07.jsonl');
  expect(existsSync(shard)).toBe(true);
  expect(readFileSync(shard, 'utf8').trimEnd().split('\n')).toHaveLength(1);

  const second = runScript('append-history.ts', [
    '--snapshot',
    snapshot,
    '--history-dir',
    historyDir,
  ]);
  expect(second.status).toBe(0);
  expect(second.stdout).toContain('already in');
  expect(readFileSync(shard, 'utf8').trimEnd().split('\n')).toHaveLength(1);
});
