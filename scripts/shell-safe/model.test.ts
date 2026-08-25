import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findShellSafeMatches, unapprovedShellSafeMatches } from './model.ts';

function scan(source: string, path = 'src/x.ts') {
  return findShellSafeMatches([{ path, source }]);
}

test('an approved sh.raw is accepted', () => {
  const src = [
    'const x = 1;',
    '// shell-safe-approved: fixed rm on a shellQuote-escaped device path',
    'const cmd = sh.raw(`rm -f ${shellQuote(p)}`);',
  ].join('\n');
  const matches = scan(src);
  assert.equal(matches.length, 1);
  assert.equal(matches[0]?.approved, true);
  assert.deepEqual(unapprovedShellSafeMatches(matches), []);
});

test('an unapproved sh.raw is flagged', () => {
  const matches = scan('const cmd = sh.raw(userText);');
  assert.equal(matches.length, 1);
  assert.equal(unapprovedShellSafeMatches(matches).length, 1);
});

test('a bare marker with no reason does not approve', () => {
  const src = ['// shell-safe-approved:', 'const cmd = sh.raw(x);'].join('\n');
  assert.equal(unapprovedShellSafeMatches(scan(src)).length, 1);
});

test('an as-ShellSafe cast outside the constructor module is flagged', () => {
  const matches = scan('const s = value as ShellSafe;');
  assert.equal(matches.length, 1);
  assert.equal(matches[0]?.kind, 'as-shell-safe');
  assert.equal(unapprovedShellSafeMatches(matches).length, 1);
});

test('as-ShellSafe casts inside the kernel constructor module are exempt', () => {
  const matches = scan('return value as ShellSafe;', 'packages/kernel/src/shell-safe.ts');
  assert.deepEqual(matches, []);
});
