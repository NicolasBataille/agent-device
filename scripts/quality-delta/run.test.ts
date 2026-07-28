// End-to-end coverage of the two quality-delta CLIs. Both are spawned as subprocesses (they are
// exercised through argument handling and the files they write), which is why this file lives in
// the `subprocess-stub` vitest project rather than `unit-core` — see #1412 coordination rule 4.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { changedCoverageFixture, snapshotFixture } from './fixtures.ts';
import { HISTORY_DIR } from './history.ts';
import { STICKY_COMMENT_MARKER } from './run.ts';

function runScript(
  script: string,
  args: readonly string[],
  env: Record<string, string> = {},
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(
    process.execPath,
    ['--experimental-strip-types', `scripts/quality-delta/${script}`, ...args],
    { encoding: 'utf8', env: { ...process.env, GITHUB_STEP_SUMMARY: '', ...env } },
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
  // The pre-#1424 marker stays recognized, or PRs that already carry that comment get a second one.
  expect(sizeReport).toContain("LEGACY_COMMENT_MARKERS = ['<!-- agent-device-size-report -->']");
});

/**
 * Post through a stand-in GitHub API that reports `currentHead` and records every call, so an
 * attempted write cannot pass unnoticed. The child is spawned asynchronously on purpose: a blocking
 * spawn would stall the event loop this stub server answers on.
 */
async function postCommentAgainst(
  currentHead: string,
  expectHead: string,
): Promise<{ calls: string[]; code: number | null; stdout: string }> {
  const calls: string[] = [];
  const server = createServer((request, response) => {
    calls.push(`${request.method} ${request.url}`);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(request.url?.includes('/pulls/') ? `{"head":{"sha":"${currentHead}"}}` : '[]');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const markdown = join(workdir(), 'comment.md');
  writeFileSync(markdown, `${STICKY_COMMENT_MARKER}\nQuality delta\n`);

  const child = spawn(
    process.execPath,
    [
      'scripts/size-report.mjs',
      '--post-comment',
      markdown,
      '--pr',
      '7',
      '--expect-head',
      expectHead,
    ],
    {
      env: {
        ...process.env,
        GITHUB_API_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        GITHUB_TOKEN: 'stub-token',
        GITHUB_REPOSITORY: 'callstack/agent-device',
      },
    },
  );
  let stdout = '';
  child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
  const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return { calls, code, stdout };
}

test('a head that advances before the write refuses the comment instead of overwriting it', async () => {
  const rendered = 'a'.repeat(40);

  // The gate passed minutes ago; the PR was pushed to while this run built the report.
  const moved = await postCommentAgainst('b'.repeat(40), rendered);
  expect(moved.code).toBe(0);
  expect(moved.stdout).toContain('Refusing to comment');
  expect(moved.calls.some((call) => /^(POST|PATCH)/.test(call))).toBe(false);

  // Same head: the write happens exactly as before.
  const current = await postCommentAgainst(rendered, rendered);
  expect(current.code).toBe(0);
  expect(current.calls).toContain('POST /repos/callstack/agent-device/issues/7/comments');
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

  // A base sha the history has not stored yet falls back to the newest entry — allowed, but it must
  // say so, or main-side movement since the base reads as this PR's doing.
  const fallback = runScript('run.ts', [
    '--head',
    head,
    '--history-dir',
    historyDir,
    '--base-sha',
    'f'.repeat(40),
  ]);
  expect(fallback.status, fallback.stdout).toBe(0);
  expect(fallback.stdout).toContain('nearest');
  expect(fallback.stdout).toContain('main-side changes this PR did not make');
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

test('the render gate reports readiness, run ids and the PR through $GITHUB_OUTPUT', () => {
  const dir = workdir();
  const headSha = 'c'.repeat(40);
  const baseSha = 'd'.repeat(40);
  const openPr = [{ number: 7, state: 'open', head: { sha: headSha }, base: { sha: baseSha } }];
  const pulls = writeJson(dir, 'pulls.json', openPr);

  function gate(name: string, runs: unknown, pullsPath: string): string {
    const output = join(dir, `${name}-output`);
    writeFileSync(output, '');
    const result = runScript(
      'producers-run.ts',
      [
        '--runs',
        writeJson(dir, `${name}-runs.json`, runs),
        '--pulls',
        pullsPath,
        '--head-sha',
        headSha,
      ],
      { GITHUB_OUTPUT: output },
    );
    // Not rendering is a normal outcome, never a failure.
    expect(result.status, result.stderr).toBe(0);
    return readFileSync(output, 'utf8');
  }

  const completed = [
    { id: 11, name: 'CI', head_sha: headSha, status: 'completed' },
    { id: 22, name: 'Size', head_sha: headSha, status: 'completed' },
  ];
  const ready = gate('ready', { workflow_runs: completed }, pulls);
  expect(ready).toContain('ready=true');
  expect(ready).toContain('size_run_id=22');
  expect(ready).toContain('pr_number=7');
  expect(ready).toContain(`pr_base_sha=${baseSha}`);

  // Size still running: its completion fires the workflow again.
  const waiting = gate(
    'waiting',
    { workflow_runs: [completed[0], { ...completed[1], status: 'in_progress' }] },
    pulls,
  );
  expect(waiting).toContain('ready=false');

  // Superseded head: the PR moved on, so posting would replace newer metrics with older ones.
  const moved = writeJson(dir, 'moved.json', [{ ...openPr[0], head: { sha: 'e'.repeat(40) } }]);
  const superseded = gate('superseded', { workflow_runs: completed }, moved);
  expect(superseded).toContain('ready=false');
  expect(superseded).toContain('pr_number=');
  expect(superseded).not.toContain('pr_number=7');
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
