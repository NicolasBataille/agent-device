import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { sh } from '@agent-device/kernel/shell';
import { runAndroidAdb, runAndroidShell } from '../adb.ts';
import { resolveAndroidAdbExecutor } from '../adb-executor.ts';

// The device-shell execution boundary. `adb shell`/`exec-out` argv is re-parsed
// by the device `sh`, so a raw string must never reach it. These planted-red
// tests prove the boundary rejects raw and variable-built shell argv, and that
// the typed funnel is the only way through.

const device = { id: 'emulator-5554', platform: 'android', name: 'test' } as DeviceInfo;

test('runAndroidAdb rejects a literal shell argv (use runAndroidShell)', async () => {
  await assert.rejects(
    runAndroidAdb(device, ['shell', 'input', 'text', 'anything']),
    /Device-shell argv must go through runAndroidShell/,
  );
});

test('runAndroidAdb rejects exec-out too', async () => {
  await assert.rejects(
    runAndroidAdb(device, ['exec-out', 'screencap', '-p']),
    /Device-shell argv must go through/,
  );
});

// The key property the removed static gate could not provide: the boundary
// checks the runtime value of the subcommand, so a variable-built or indirect
// shell argv is rejected exactly like a literal one.
test('runAndroidAdb rejects a variable-built shell argv (indirect)', async () => {
  const subcommand = ['sh', 'ell'].join('');
  const evil = 'x"; rm -rf /data; echo "';
  await assert.rejects(
    runAndroidAdb(device, [subcommand, 'input', 'text', evil]),
    /Device-shell argv must go through/,
  );
});

test('the resolved executor itself rejects shell argv, not only the wrapper', async () => {
  const exec = resolveAndroidAdbExecutor(device);
  await assert.rejects(exec(['shell', 'whoami']), /Device-shell argv must go through/);
});

// The typed path only accepts ShellSafe atoms — a raw string is a compile error,
// which is the whole guarantee. (Runtime assertion here is incidental; the
// @ts-expect-error is the real test.)
test('runAndroidShell does not accept raw strings (type-level)', () => {
  const call = () =>
    // @ts-expect-error raw strings are not ShellSafe — they cannot reach a device shell
    runAndroidShell(device, ['input', 'text', 'raw-user-text']);
  assert.equal(typeof call, 'function');
});

// A malicious value carried through sh.arg is quoted, so the device shell sees
// exactly one argument — no injection.
test('sh.arg quotes an injection vector into a single argument', () => {
  const evil = 'x"; rm -rf /data #';
  const [safe] = [sh.arg(evil)];
  assert.notEqual(safe, evil);
  assert.match(String(safe), /^'/);
});
