import type { DeviceInfo } from '@agent-device/kernel/device';
import { type ShellArgv, shellArgvToStrings } from '@agent-device/kernel/shell';
import {
  resolveAndroidAdbExecutor,
  resolveAndroidAdbShellExecutor,
  type AndroidAdbExecutor,
  type AndroidAdbExecutorOptions,
  type AndroidAdbExecutorResult,
} from './adb-executor.ts';

export { sleep } from '../../utils/timeouts.ts';

/**
 * Run a non-shell adb subcommand (`install`, `push`, `pull`, `reverse`, …).
 * `shell`/`exec-out` are rejected here — they re-parse their argv on the device
 * and must go through `runAndroidShell`/`runAndroidExecOut` with `ShellSafe`
 * atoms.
 */
export async function runAndroidAdb(
  device: DeviceInfo,
  args: string[],
  options?: AndroidAdbExecutorOptions,
): Promise<AndroidAdbExecutorResult> {
  return await resolveAndroidAdbExecutor(device)(args, options);
}

/**
 * Run an `adb shell` command from typed `ShellSafe` atoms (`sh.lit`/`sh.arg`/
 * `sh.num`/`sh.raw`). The device `sh` re-parses the joined argv, so a raw
 * string cannot be passed here — that is the whole point of the boundary.
 */
export async function runAndroidShell(
  device: DeviceInfo,
  args: ShellArgv,
  options?: AndroidAdbExecutorOptions,
  executor?: AndroidAdbExecutor,
): Promise<AndroidAdbExecutorResult> {
  return await resolveAndroidAdbShellExecutor(device, executor)(
    ['shell', ...shellArgvToStrings(args)],
    options,
  );
}

/** Run an `adb exec-out` command from typed `ShellSafe` atoms (binary stdout). */
export async function runAndroidExecOut(
  device: DeviceInfo,
  args: ShellArgv,
  options?: AndroidAdbExecutorOptions,
  executor?: AndroidAdbExecutor,
): Promise<AndroidAdbExecutorResult> {
  return await resolveAndroidAdbShellExecutor(device, executor)(
    ['exec-out', ...shellArgvToStrings(args)],
    options,
  );
}

export function isClipboardShellUnsupported(stdout: string, stderr: string): boolean {
  const haystack = `${stdout}\n${stderr}`.toLowerCase();
  return (
    haystack.includes('no shell command implementation') || haystack.includes('unknown command')
  );
}
