import type { DeviceInfo } from '@agent-device/kernel/device';
import { type ShellArgv, shellArgvToStrings } from '@agent-device/kernel/shell';
import { AppError } from '@agent-device/kernel/errors';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { runCmd, type ExecOptions, type ExecResult } from '../../utils/exec.ts';

export type HarmonyHdcOptions = Pick<
  ExecOptions,
  'allowFailure' | 'timeoutMs' | 'binaryStdout' | 'signal'
>;

export const DEFAULT_HARMONY_HDC_TIMEOUT_MS = 15_000;

/**
 * Runs a non-shell HDC command scoped to one HarmonyOS target. `shell` is
 * rejected here — its argv is re-parsed on the device and must go through
 * `runHarmonyShell` with `ShellSafe` atoms.
 */
export async function runHarmonyHdc(
  device: Pick<DeviceInfo, 'id'>,
  args: string[],
  options?: HarmonyHdcOptions,
): Promise<ExecResult> {
  if (args[0] === 'shell') {
    throw new AppError(
      'INVALID_ARGS',
      'Device-shell argv must go through runHarmonyShell with ShellSafe atoms, not runHarmonyHdc.',
    );
  }
  return await runHdcUnchecked(device, args, options);
}

/** Runs an `hdc shell` command from typed `ShellSafe` atoms (`sh.*`). */
export async function runHarmonyShell(
  device: Pick<DeviceInfo, 'id'>,
  args: ShellArgv,
  options?: HarmonyHdcOptions,
): Promise<ExecResult> {
  return await runHdcUnchecked(device, ['shell', ...shellArgvToStrings(args)], options);
}

async function runHdcUnchecked(
  device: Pick<DeviceInfo, 'id'>,
  args: string[],
  options?: HarmonyHdcOptions,
): Promise<ExecResult> {
  return await runCmd('hdc', ['-t', device.id, ...args], {
    timeoutMs: DEFAULT_HARMONY_HDC_TIMEOUT_MS,
    ...options,
  });
}

/**
 * DevEco's command-line tools do not amend PATH for non-interactive processes.
 * Honor the documented roots so the daemon sees the same HDC binary as a shell.
 */
export async function ensureHarmonyToolchainPathConfigured(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const toolchainRoots = [
    env.HDC_SDK_PATH,
    env.DEVECO_SDK_HOME
      ? path.join(env.DEVECO_SDK_HOME, 'default', 'openharmony', 'toolchains')
      : undefined,
    env.HARMONYOS_COMMAND_LINE_TOOLS
      ? path.join(env.HARMONYOS_COMMAND_LINE_TOOLS, 'sdk', 'default', 'openharmony', 'toolchains')
      : undefined,
  ].filter((value): value is string => Boolean(value?.trim()));
  const executableRoots: string[] = [];
  for (const root of toolchainRoots) {
    try {
      await fs.access(path.join(root, 'hdc'), fs.constants.X_OK);
      executableRoots.push(root);
    } catch {
      // Continue through explicit alternatives; the final missing-tool error names recovery.
    }
  }
  if (executableRoots.length === 0) return;
  const currentEntries = (env.PATH ?? '').split(path.delimiter).filter(Boolean);
  env.PATH = [...new Set([...executableRoots, ...currentEntries])].join(path.delimiter);
}
