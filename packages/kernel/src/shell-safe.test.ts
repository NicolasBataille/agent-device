import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sh, shellArgvToStrings, shellQuote, shellQuoteIfNeeded } from './shell-safe.ts';

test('shellQuoteIfNeeded leaves safe tokens and quotes the rest', () => {
  assert.equal(shellQuoteIfNeeded('com.example.app'), 'com.example.app');
  assert.equal(shellQuoteIfNeeded('KEYCODE_DEL'), 'KEYCODE_DEL');
  assert.equal(shellQuoteIfNeeded('a b'), "'a b'");
  assert.equal(shellQuoteIfNeeded('x; rm -rf /'), "'x; rm -rf /'");
  assert.equal(shellQuoteIfNeeded("it's"), "'it'\\''s'");
});

// The migration's safety proof: for legitimate (safe-charset) input, the atom
// constructors are the identity, so a migrated argv is byte-identical to the
// pre-migration raw argv. Only a value that would have been an injection vector
// changes (it gets quoted).
test('lit and arg are byte-identical to the raw string for safe input', () => {
  for (const token of ['input', 'text', 'am', 'force-stop', '-n', 'com.x/.MainActivity']) {
    assert.equal(sh.lit(token), token);
    assert.equal(sh.arg(token), token);
  }
  assert.equal(sh.num(1080), '1080');
});

test('arg quotes an injection vector so the device shell sees one argument', () => {
  const evil = 'hi"; rm -rf /data; echo "';
  assert.equal(sh.arg(evil), shellQuote(evil));
  assert.notEqual(sh.arg(evil), evil);
});

test('lit rejects a token carrying shell metacharacters', () => {
  assert.throws(() => sh.lit('rm -f x'), /not a bare shell token/);
  assert.throws(() => sh.lit('a;b'), /not a bare shell token/);
  assert.throws(() => sh.lit('$(whoami)'), /not a bare shell token/);
});

test('lits maps a run of literal words', () => {
  assert.deepEqual(shellArgvToStrings(sh.lits('input', 'keyevent', '4')), [
    'input',
    'keyevent',
    '4',
  ]);
});

test('raw passes an author-quoted fragment through verbatim', () => {
  const fragment = `if [ -f ${shellQuote('/sdcard/x')} ]; then echo ok; fi`;
  assert.equal(sh.raw(fragment), fragment);
});
