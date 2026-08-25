import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { sh } from '@agent-device/kernel/shell';
import { runAndroidShell } from './adb.ts';
import {
  buildAndroidNativeRemotePath,
  cleanupAndroidRemotePath,
  stopAndroidNativePerfSession,
} from './perf-native-artifacts.ts';
import { annotateAndroidNativePerfError } from './perf-native-errors.ts';
import { resetAndroidFramePerfStats } from './perf-frame.ts';
import {
  assertAndroidNativeToolAvailable,
  findPidToken,
  resolveAndroidAppPid,
} from './perf-native-process.ts';
import {
  ANDROID_NATIVE_MAX_SECONDS,
  ANDROID_NATIVE_PROFILE_TIMEOUT_MS,
  ANDROID_PERFETTO_METHOD,
  ANDROID_PERFETTO_REMOTE_DIR,
  type AndroidNativePerfOptions,
  type AndroidNativePerfSession,
  type AndroidNativePerfStartResult,
  type AndroidNativePerfStopResult,
} from './perf-native-types.ts';

export async function startAndroidPerfettoTrace(
  device: DeviceInfo,
  packageName: string,
  outPath: string,
  _options: AndroidNativePerfOptions = {},
): Promise<AndroidNativePerfStartResult> {
  const appPid = await resolveAndroidAppPid(device, packageName);
  await assertAndroidNativeToolAvailable(device, 'perfetto', packageName);
  const remotePath = buildAndroidNativeRemotePath(
    packageName,
    'app.perfetto-trace',
    ANDROID_PERFETTO_REMOTE_DIR,
  );
  let profilerPid: string;
  try {
    await resetAndroidFramePerfStats(device, packageName);
    profilerPid = await startAndroidPerfettoBackgroundTool(device, remotePath, packageName);
  } catch (error) {
    await cleanupAndroidRemotePath(device, remotePath);
    throw error;
  }
  const session = {
    type: 'trace',
    kind: 'perfetto',
    packageName,
    appPid,
    profilerPid,
    remotePath,
    outPath,
    startedAt: Date.now(),
    state: 'running',
  } satisfies AndroidNativePerfSession;
  return {
    ...session,
    action: 'start',
    platform: 'android',
    method: ANDROID_PERFETTO_METHOD,
    message: `Started Android Perfetto trace for ${packageName}`,
  };
}

export async function stopAndroidPerfettoTrace(
  device: DeviceInfo,
  session: AndroidNativePerfSession,
  outPath: string,
  options: AndroidNativePerfOptions = {},
): Promise<AndroidNativePerfStopResult> {
  return await stopAndroidNativePerfSession(device, { ...session, outPath }, options);
}

async function startAndroidPerfettoBackgroundTool(
  device: DeviceInfo,
  remotePath: string,
  packageName: string,
): Promise<string> {
  try {
    const result = await runAndroidShell(
      device,
      [
        ...sh.lits('perfetto', '--background-wait', '-o'),
        sh.arg(remotePath),
        sh.lit('-t'),
        sh.arg(`${ANDROID_NATIVE_MAX_SECONDS}s`),
        ...sh.lits(
          'sched',
          'freq',
          'idle',
          'am',
          'wm',
          'gfx',
          'view',
          'binder_driver',
          'hal',
          'dalvik',
        ),
      ],
      {
        timeoutMs: ANDROID_NATIVE_PROFILE_TIMEOUT_MS,
      },
    );
    const pid = findPidToken(result.stdout);
    if (pid) return pid;
    throw new AppError('COMMAND_FAILED', 'Android perfetto did not return a profiler pid', {
      package: packageName,
      tool: 'perfetto',
      hint: 'Retry perf trace start. If perfetto exits immediately, verify the device permits trace capture.',
    });
  } catch (error) {
    throw annotateAndroidNativePerfError('start', 'perfetto', packageName, error);
  }
}
