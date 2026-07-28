import { expect, test } from 'vitest';
import { snapshotFixture } from './fixtures.ts';
import {
  appendEntry,
  findBaseline,
  historyShardName,
  parseHistory,
  serializeEntry,
} from './history.ts';

test('a snapshot lands in the shard for the month it was generated in (UTC)', () => {
  expect(historyShardName('2026-07-20T10:00:00.000Z')).toBe('2026-07.jsonl');
  // Late-UTC December must not roll into the next year via local time.
  expect(historyShardName('2026-12-31T23:59:59.000Z')).toBe('2026-12.jsonl');
});

test('appending is keyed by commit, so a rerun of the same main build is a no-op', () => {
  const snapshot = snapshotFixture({ commit: 'c'.repeat(40) });
  const first = appendEntry('', snapshot);
  expect(first.appended).toBe(true);
  expect(first.text.endsWith('\n')).toBe(true);

  const second = appendEntry(first.text, snapshot);
  expect(second.appended).toBe(false);
  expect(second.text).toBe(first.text);

  const other = appendEntry(first.text, snapshotFixture({ commit: 'd'.repeat(40) }));
  expect(other.appended).toBe(true);
  expect(parseHistory(other.text).entries).toHaveLength(2);
});

test('appending repairs a shard whose last line lost its newline', () => {
  const line = serializeEntry(snapshotFixture({ commit: 'e'.repeat(40) }));
  const appended = appendEntry(line, snapshotFixture({ commit: 'f'.repeat(40) }));
  expect(parseHistory(appended.text).entries).toHaveLength(2);
});

test('malformed lines are counted, never silently dropped', () => {
  const text = ['{"not":"a snapshot"}', 'not json at all', serializeEntry(snapshotFixture())].join(
    '\n',
  );
  const parsed = parseHistory(text);
  expect(parsed.entries).toHaveLength(1);
  expect(parsed.malformed).toBe(2);
});

test('a baseline lookup prefers the requested commit and falls back to the newest entry', () => {
  const older = snapshotFixture({
    commit: '1'.repeat(40),
    generatedAt: '2026-07-01T00:00:00.000Z',
  });
  const newer = snapshotFixture({
    commit: '2'.repeat(40),
    generatedAt: '2026-07-09T00:00:00.000Z',
  });
  const entries = [newer, older];

  expect(findBaseline(entries, '1'.repeat(40))).toEqual({ snapshot: older, exact: true });
  // A short sha from `git rev-parse --short` still resolves.
  expect(findBaseline(entries, '1'.repeat(7))?.exact).toBe(true);
  expect(findBaseline(entries, 'deadbee')).toEqual({ snapshot: newer, exact: false });
  expect(findBaseline([], 'deadbee')).toBe(null);
});
