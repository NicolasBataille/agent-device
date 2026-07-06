import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { test } from 'vitest';
import { applyStickyFlags, parsePromptCommandLines, type RunnableLine } from '../prompt-lines.ts';

const CWD = tmpdir();

function parseOne(text: string): ReturnType<typeof parsePromptCommandLines>[number] {
  const lines = parsePromptCommandLines(text, { cwd: CWD });
  assert.equal(lines.length, 1);
  return lines[0]!;
}

test('splits prompt text into command lines, skipping blanks and comments', () => {
  const lines = parsePromptCommandLines('\n# comment\ndevices\n\nsnapshot -i\n', { cwd: CWD });
  assert.deepEqual(
    lines.map((line) => (line.kind === 'command' ? line.command : line.error)),
    ['devices', 'snapshot'],
  );
});

test('strips an optional leading agent-device token', () => {
  const line = parseOne('agent-device devices');
  assert.equal(line.kind, 'command');
  assert.equal((line as RunnableLine).command, 'devices');
});

test('accepts ACP slash commands for advertised commands', () => {
  const lines = parsePromptCommandLines('/devices\n/snapshot -i', { cwd: CWD });
  assert.deepEqual(
    lines.map((line) => {
      assert.equal(line.kind, 'command');
      return (line as RunnableLine).command;
    }),
    ['devices', 'snapshot'],
  );
  assert.equal((lines[1] as RunnableLine).flags.snapshotInteractiveOnly, true);
});

test('tokenizes quoted arguments with spaces like replay scripts', () => {
  const line = parseOne('fill "id:search" "hello world" --platform ios');
  assert.equal(line.kind, 'command');
  const runnable = line as RunnableLine;
  assert.deepEqual(runnable.positionals, ['id:search', 'hello world']);
  assert.equal(runnable.flags.platform, 'ios');
});

test('rejects unknown commands with per-line guidance', () => {
  const line = parseOne('frobnicate');
  assert.equal(line.kind, 'error');
  assert.match((line as { error: string }).error, /Unknown command: frobnicate/);
});

test('rejects CLI-only commands that are not automatable through ACP', () => {
  for (const command of ['mcp', 'acp', 'connect', 'auth']) {
    const line = parseOne(command);
    assert.equal(line.kind, 'error', `expected ${command} to be rejected`);
  }
});

test('sticky flags fill in target selection and explicit flags win', () => {
  const bare = parseOne('snapshot -i') as RunnableLine;
  assert.equal(bare.kind, 'command');
  assert.deepEqual(bare.providedSticky, {});
  const merged = applyStickyFlags(bare, { platform: 'ios', session: 'demo' });
  assert.equal(merged.platform, 'ios');
  assert.equal(merged.session, 'demo');

  const explicit = parseOne('snapshot -i --platform android') as RunnableLine;
  assert.equal(explicit.kind, 'command');
  assert.deepEqual(explicit.providedSticky, { platform: 'android' });
  assert.equal(applyStickyFlags(explicit, { platform: 'ios' }).platform, 'android');
});
