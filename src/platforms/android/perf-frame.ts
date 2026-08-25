import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { type AndroidAdbExecutor } from './adb-executor.ts';
import { runAndroidShell } from './adb.ts';
import { sh } from '@agent-device/kernel/shell';
import { parseAndroidFramePerfSample, type AndroidFramePerfSample } from './perf-frame-parser.ts';

export {
  ANDROID_FRAME_SAMPLE_DESCRIPTION,
  ANDROID_FRAME_SAMPLE_METHOD,
  type AndroidFramePerfSample,
} from './perf-frame-parser.ts';

const ANDROID_FRAME_PERF_TIMEOUT_MS = 15_000;
const ANDROID_FRAME_RESET_TIMEOUT_MS = 3_000;

export type AndroidFramePerfOptions = {
  adb?: AndroidAdbExecutor;
};

export async function sampleAndroidFramePerf(
  device: DeviceInfo,
  packageName: string,
  options: AndroidFramePerfOptions = {},
): Promise<AndroidFramePerfSample> {
  try {
    const result = await runAndroidShell(
      device,
      [...sh.lits('dumpsys', 'gfxinfo'), sh.arg(packageName), sh.lit('framestats')],
      { timeoutMs: ANDROID_FRAME_PERF_TIMEOUT_MS },
    );
    const sample = parseAndroidFramePerfSample(
      result.stdout,
      packageName,
      new Date().toISOString(),
    );
    await resetAndroidFramePerfStats(device, packageName, options);
    return sample;
  } catch (error) {
    throw annotateAndroidFramePerfSamplingError(packageName, error);
  }
}

export async function resetAndroidFramePerfStats(
  device: DeviceInfo,
  packageName: string,
  _options: AndroidFramePerfOptions = {},
): Promise<void> {
  try {
    await runAndroidShell(
      device,
      [...sh.lits('dumpsys', 'gfxinfo'), sh.arg(packageName), sh.lit('reset')],
      { allowFailure: true, timeoutMs: ANDROID_FRAME_RESET_TIMEOUT_MS },
    );
  } catch {
    // Reset is best-effort; sampling/open should still succeed if adb times out or disappears.
  }
}

function annotateAndroidFramePerfSamplingError(packageName: string, error: unknown): AppError {
  if (error instanceof AppError) {
    return new AppError(
      error.code,
      error.message,
      {
        ...(error.details ?? {}),
        metric: 'fps',
        package: packageName,
      },
      error,
    );
  }

  return new AppError(
    'COMMAND_FAILED',
    `Failed to sample Android fps for ${packageName}`,
    {
      metric: 'fps',
      package: packageName,
    },
    error,
  );
}
