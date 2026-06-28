import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  mergeSnapshotDiagnostics,
  readSnapshotDiagnosticsSummary,
  readSnapshotRunnerTiming,
  recordSnapshotTiming,
  summarizeSnapshotDiagnostics,
  summarizeSnapshotTimingSamples,
} from '../snapshot-diagnostics.ts';

test('records session snapshot timing stats', () => {
  const session = {};

  recordSnapshotTiming(session, { durationMs: 400, backend: 'android', platform: 'android' });
  recordSnapshotTiming(session, { durationMs: 2_100, backend: 'android', platform: 'android' });

  const summary = summarizeSnapshotDiagnostics(session);
  assert.deepEqual(summary?.stats, {
    count: 2,
    p50Ms: 400,
    p95Ms: 2_100,
    maxMs: 2_100,
    slowThresholdMs: 1_500,
    platform: 'android',
    backends: { android: 2 },
  });
  assert.match(summary?.warning ?? '', /p95 2100ms over 2 captures/);
});

test('snapshot diagnostics summarizes bounded phase timing stats', () => {
  const summary = summarizeSnapshotTimingSamples([
    {
      durationMs: 1_000,
      platform: 'ios',
      backend: 'xctest',
      phases: {
        runner_total: 800,
        xctest_root_snapshot: 650,
      },
    },
    {
      durationMs: 2_000,
      platform: 'ios',
      backend: 'xctest',
      phases: {
        runner_total: 1_700,
        xctest_root_snapshot: 1_500,
      },
    },
  ]);

  assert.equal(summary?.stats.p95Ms, 2_000);
  assert.equal(summary?.phases?.runner_total?.p95Ms, 1_700);
  assert.equal(summary?.phases?.xctest_root_snapshot?.p50Ms, 650);
  assert.equal(summary?.phases?.runner_total?.platform, 'ios');
  assert.deepEqual(summary?.phases?.runner_total?.backends, { xctest: 2 });
});

test('snapshot diagnostics reads serialized phase stats', () => {
  const summary = readSnapshotDiagnosticsSummary({
    stats: {
      count: 1,
      p50Ms: 100,
      p95Ms: 100,
      maxMs: 100,
      slowThresholdMs: 1_500,
      platform: 'ios',
    },
    phases: {
      runner_total: {
        count: 1,
        p50Ms: 80,
        p95Ms: 80,
        maxMs: 80,
        slowThresholdMs: 1_500,
        platform: 'ios',
      },
      'bad phase': {
        count: 1,
        p50Ms: 1,
        p95Ms: 1,
        maxMs: 1,
        slowThresholdMs: 1_500,
      },
    },
  });

  assert.equal(summary?.phases?.runner_total?.p95Ms, 80);
  assert.equal(summary?.phases?.['bad phase'], undefined);
});

test('merges snapshot diagnostics without inflating capture count', () => {
  const merged = mergeSnapshotDiagnostics([
    {
      stats: {
        count: 1,
        p50Ms: 300,
        p95Ms: 300,
        maxMs: 300,
        slowThresholdMs: 1_500,
        platform: 'android',
      },
      phases: {
        runner_total: {
          count: 1,
          p50Ms: 200,
          p95Ms: 200,
          maxMs: 200,
          slowThresholdMs: 1_500,
          platform: 'android',
        },
      },
    },
    {
      stats: {
        count: 2,
        p50Ms: 500,
        p95Ms: 1_900,
        maxMs: 1_900,
        slowThresholdMs: 1_500,
        platform: 'android',
      },
      phases: {
        runner_total: {
          count: 2,
          p50Ms: 300,
          p95Ms: 1_700,
          maxMs: 1_700,
          slowThresholdMs: 1_500,
          platform: 'android',
        },
      },
    },
  ]);

  assert.equal(merged?.stats.count, 3);
  assert.equal(merged?.stats.p50Ms, 500);
  assert.equal(merged?.stats.p95Ms, 1_900);
  assert.equal(merged?.stats.maxMs, 1_900);
  assert.equal(merged?.stats.platform, 'android');
  const runnerTotal = merged?.phases?.runner_total;
  assert.ok(runnerTotal);
  assert.equal(runnerTotal.count, 3);
  assert.equal(runnerTotal.p50Ms, 300);
  assert.equal(runnerTotal.p95Ms, 1_700);
  assert.match(merged?.warning ?? '', /p95 1900ms over 3 captures/);
});

test('snapshot diagnostics parses runner timing into bounded phase names', () => {
  const timing = readSnapshotRunnerTiming({
    totalMs: 120.4,
    selectedBackend: 'tree',
    phases: {
      xctest_root_snapshot: 95.8,
      'bad phase': 100,
      bad_value: 'slow',
    },
    backends: {
      tree: 110.2,
      queries: 0,
    },
  });

  assert.deepEqual(timing, {
    totalMs: 120.4,
    selectedBackend: 'tree',
    phases: {
      xctest_root_snapshot: 96,
      runner_total: 120,
      'backend.tree': 110,
      'backend.queries': 0,
    },
  });
});

test('snapshot diagnostics keeps only recent timing samples', () => {
  const session: {
    snapshotDiagnostics?: { samples: Array<{ durationMs: number }> };
  } = {};

  for (let index = 0; index < 55; index += 1) {
    recordSnapshotTiming(session, { durationMs: index, platform: 'ios' });
  }

  assert.equal(session.snapshotDiagnostics?.samples.length, 50);
  assert.equal(session.snapshotDiagnostics?.samples[0]?.durationMs, 5);
  const summary = summarizeSnapshotDiagnostics(session);
  assert.equal(summary?.stats.count, 50);
  assert.equal(summary?.stats.maxMs, 54);
});
