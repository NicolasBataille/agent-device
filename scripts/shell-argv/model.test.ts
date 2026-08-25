import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diffInventory, findShellArgvValues, toInventory } from './model.ts';

function scan(source: string) {
  return findShellArgvValues([{ path: 'src/platforms/android/example.ts', source }]);
}

test('an all-literal device-shell argv is not inventoried', () => {
  assert.deepEqual(scan(`adb(['shell', 'input', 'keyevent', '4']);`), []);
  assert.deepEqual(scan(`adb(['exec-out', 'screencap', '-p']);`), []);
});

test('a dynamic element in a device-shell argv is inventoried', () => {
  const values = scan(`adb(['shell', 'input', 'text', text]);`);
  assert.deepEqual(
    values.map((value) => value.expression),
    ['text'],
  );
});

test('quoted values are safe; the quote call is the boundary', () => {
  assert.deepEqual(scan(`adb(['shell', 'input', 'text', shellQuoteIfNeeded(text)]);`), []);
  assert.deepEqual(scan(`adb(['shell', 'rm -f ' + shellQuote(remotePath)]);`), []);
  assert.deepEqual(scan('adb([`shell`, `rm -f ${shellQuote(remotePath)}`]);'), []);
});

test('a template with an unquoted expression inventories the inner expression', () => {
  const values = scan("adb(['shell', `am start ${component}`]);");
  assert.deepEqual(
    values.map((value) => value.expression),
    ['component'],
  );
});

test('spreads and ternaries recurse to the argv values, not the condition', () => {
  // `flag` selects which argv is sent but never reaches the shell itself;
  // only the branch elements do.
  const values = scan(`adb(['shell', 'aa', ...(flag ? ['-m', target.module] : [])]);`);
  assert.deepEqual(
    values.map((value) => value.expression),
    ['target.module'],
  );
});

test('arrays that are not device-shell argv are ignored', () => {
  assert.deepEqual(scan(`adb(['install', '-r', apkPath]);`), []);
  assert.deepEqual(scan(`const words = ['shellfish', userText];`), []);
});

test('the inventory counts repeated identical expressions per file', () => {
  const inventory = toInventory(
    scan(`adb(['shell', 'pm', 'grant', pkg]); adb(['shell', 'pm', 'revoke', pkg]);`),
  );
  assert.deepEqual(inventory, { 'src/platforms/android/example.ts :: pkg': 2 });
});

test('the diff flags growth and staleness in both directions', () => {
  const scanned = { 'a.ts :: pkg': 2, 'a.ts :: mode': 1 };
  assert.deepEqual(diffInventory(scanned, { 'a.ts :: pkg': 2, 'a.ts :: mode': 1 }), {
    added: [],
    stale: [],
  });
  assert.deepEqual(diffInventory(scanned, { 'a.ts :: pkg': 1 }), {
    added: ['a.ts :: mode (1 site(s), 0 recorded)', 'a.ts :: pkg (2 site(s), 1 recorded)'],
    stale: [],
  });
  assert.deepEqual(diffInventory({ 'a.ts :: pkg': 1 }, scanned), {
    added: [],
    stale: ['a.ts :: mode (1 recorded, 0 site(s))', 'a.ts :: pkg (2 recorded, 1 site(s))'],
  });
});
