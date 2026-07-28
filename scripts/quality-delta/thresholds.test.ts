// The comment's promise is that every row it shows names a real gate and a command you can run.
// That promise is only worth as much as its enumeration: these tests derive from
// QUALITY_DELTA_METRICS itself, so a metric added with a stale path or a made-up script fails here
// rather than shipping a dead link into a PR comment.

import { existsSync, readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { QUALITY_DELTA_METRICS } from './thresholds.ts';

const packageScripts = (
  JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> }
).scripts;

test('every metric names a file that exists in the tree', () => {
  for (const spec of QUALITY_DELTA_METRICS) {
    expect(existsSync(spec.owner.path), `${spec.key} -> ${spec.owner.path}`).toBe(true);
  }
});

test('every metric names a fix command that is a real package script', () => {
  for (const spec of QUALITY_DELTA_METRICS) {
    const script = spec.owner.fix.replace(/^pnpm /, '');
    expect(packageScripts[script], `${spec.key} -> ${spec.owner.fix}`).toBeDefined();
  }
});

test('every metric has a distinct key and a non-trivial threshold', () => {
  const keys = QUALITY_DELTA_METRICS.map((spec) => spec.key);
  expect(new Set(keys).size).toBe(keys.length);
  for (const spec of QUALITY_DELTA_METRICS) {
    const threshold = spec.kind === 'delta' ? spec.minAbsDelta : spec.bound;
    expect(threshold, spec.key).toBeGreaterThanOrEqual(0);
    if (spec.kind === 'delta') expect(spec.minAbsDelta, spec.key).toBeGreaterThan(0);
  }
});
