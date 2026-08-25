import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { sleep } from '../../utils/timeouts.ts';
import { sh } from '@agent-device/kernel/shell';
import type { AndroidAdbExecutor } from './adb-executor.ts';
import { resolveAndroidAdbExecutor } from './adb-executor.ts';
import { runAndroidShell } from './adb.ts';
import { annotateAndroidNativePerfError } from './perf-native-errors.ts';
import { buildAndroidNativePerfStopSummary } from './perf-native-summary.ts';
import {
  ANDROID_NATIVE_PROFILE_TIMEOUT_MS,
  ANDROID_NATIVE_REMOTE_DIR,
  ANDROID_PERF_TIMEOUT_MS,
  ANDROID_PERFETTO_METHOD,
  ANDROID_SIMPLEPERF_METHOD,
  type AndroidNativePerfOptions,
  type AndroidNativePerfSession,
  type AndroidNativePerfStopResult,
} from './perf-native-types.ts';

const ANDROID_NATIVE_ARTIFACT_POLL_INTERVAL_MS = 250;
const ANDROID_NATIVE_ARTIFACT_POLL_ATTEMPTS = 12;

export async function stopAndroidNativePerfSession(
  device: DeviceInfo,
  session: AndroidNativePerfSession,
  options: AndroidNativePerfOptions,
): Promise<AndroidNativePerfStopResult> {
  const adb = resolveAndroidAdbExecutor(device, options.adb);
  await stopAndroidBackgroundTool(device, session);
  await waitForAndroidNativeArtifact(device, session);
  await pullAndroidNativeArtifact(adb, session);
  const sizeBytes = await readFileSize(session.outPath);
  await cleanupAndroidRemotePath(device, session.remotePath);
  const stoppedAt = Date.now();
  const durationMs = Math.max(0, stoppedAt - session.startedAt);
  const summary = await buildAndroidNativePerfStopSummary(device, session, sizeBytes, durationMs, {
    adb,
  });
  return {
    ...session,
    action: 'stop',
    platform: 'android',
    state: 'stopped',
    stoppedAt,
    durationMs,
    sizeBytes,
    method: session.kind === 'simpleperf' ? ANDROID_SIMPLEPERF_METHOD : ANDROID_PERFETTO_METHOD,
    artifact: {
      path: session.outPath,
      sizeBytes,
    },
    summary,
    message: `Stopped Android ${session.kind} ${session.type} for ${session.packageName}`,
  };
}

export async function cleanupAndroidNativePerfSession(
  device: DeviceInfo,
  session: AndroidNativePerfSession,
  _options: AndroidNativePerfOptions = {},
): Promise<void> {
  try {
    if (session.state === 'running') {
      await stopAndroidBackgroundTool(device, session);
      await waitForAndroidNativeArtifact(device, session).catch(() => {});
    }
  } finally {
    await cleanupAndroidRemotePath(device, session.remotePath);
  }
}

export function buildAndroidNativeRemotePath(
  packageName: string,
  fileName: string,
  remoteDir = ANDROID_NATIVE_REMOTE_DIR,
): string {
  const safePackage = packageName.replace(/[^A-Za-z0-9_.-]/g, '_');
  return `${remoteDir}/agent-device-${safePackage}-${Date.now()}-${fileName}`;
}

export async function cleanupAndroidRemotePath(
  device: DeviceInfo,
  remotePath: string,
): Promise<void> {
  try {
    // shell-safe-approved: fixed `rm -f` on a shellQuote-escaped device path
    await runAndroidShell(device, [sh.raw(`rm -f ${shellQuote(remotePath)}`)], {
      allowFailure: true,
      timeoutMs: ANDROID_PERF_TIMEOUT_MS,
    });
  } catch {
    // Best-effort cleanup must not hide the primary profiling result.
  }
}

export async function writeJsonArtifact(outPath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, `${JSON.stringify(value, null, 2)}\n`);
}

export async function readFileSize(filePath: string): Promise<number> {
  try {
    return (await fs.stat(filePath)).size;
  } catch (error) {
    throw new AppError(
      'COMMAND_FAILED',
      `Profiler artifact was not written: ${filePath}`,
      {
        outPath: filePath,
        hint: 'Retry the profiling command and check daemon logs if the artifact path is still missing.',
      },
      error,
    );
  }
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function stopAndroidBackgroundTool(
  device: DeviceInfo,
  session: AndroidNativePerfSession,
): Promise<void> {
  try {
    // shell-safe-approved: buildStopProfilerCommand emits a fixed kill/wait script whose only
    // interpolation is the profiler pid, shellQuote-escaped inside the builder
    await runAndroidShell(device, [sh.raw(buildStopProfilerCommand(session.profilerPid))], {
      timeoutMs: ANDROID_NATIVE_PROFILE_TIMEOUT_MS,
    });
  } catch (error) {
    throw annotateAndroidNativePerfError('stop', session.kind, session.packageName, error);
  }
}

function buildStopProfilerCommand(pid: string): string {
  return [
    `pid=${shellQuote(pid)}`,
    'kill -INT "$pid" 2>/dev/null || true',
    'for i in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$pid" 2>/dev/null || exit 0; sleep 0.2; done',
    'kill -TERM "$pid" 2>/dev/null || true',
    'for i in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$pid" 2>/dev/null || exit 0; sleep 0.2; done',
    'echo "profiler process did not stop after SIGTERM" >&2',
    'exit 1',
  ].join('; ');
}

async function pullAndroidNativeArtifact(
  adb: AndroidAdbExecutor,
  session: AndroidNativePerfSession,
): Promise<void> {
  await fs.mkdir(path.dirname(session.outPath), { recursive: true });
  try {
    await adb(['pull', session.remotePath, session.outPath], {
      timeoutMs: ANDROID_NATIVE_PROFILE_TIMEOUT_MS,
    });
  } catch (error) {
    throw new AppError(
      'COMMAND_FAILED',
      `Failed to pull Android ${session.kind} artifact for ${session.packageName}`,
      {
        package: session.packageName,
        tool: session.kind,
        remotePath: session.remotePath,
        outPath: session.outPath,
        hint: 'Check that the profiling command ran long enough to create an artifact, then retry stop with the same session.',
      },
      error,
    );
  }
}

async function waitForAndroidNativeArtifact(
  device: DeviceInfo,
  session: AndroidNativePerfSession,
): Promise<void> {
  let previousSize: number | undefined;
  for (let attempt = 0; attempt < ANDROID_NATIVE_ARTIFACT_POLL_ATTEMPTS; attempt += 1) {
    const size = await readAndroidRemoteFileSize(device, session.remotePath);
    if (size !== undefined && size > 0 && size === previousSize) {
      return;
    }
    previousSize = size;
    await sleep(ANDROID_NATIVE_ARTIFACT_POLL_INTERVAL_MS);
  }
  throw new AppError('COMMAND_FAILED', `Android ${session.kind} artifact is not ready to pull`, {
    package: session.packageName,
    tool: session.kind,
    remotePath: session.remotePath,
    hint: 'The profiler stopped, but the remote artifact was missing, empty, or still changing. Retry stop with the same session or inspect the device-side artifact.',
  });
}

async function readAndroidRemoteFileSize(
  device: DeviceInfo,
  remotePath: string,
): Promise<number | undefined> {
  const quotedPath = shellQuote(remotePath);
  // shell-safe-approved: file-size probe on a shellQuote-escaped device path — every
  // interpolation uses `quotedPath`; the surrounding `[ -f ] / stat / wc` script is fixed
  const result = await runAndroidShell(
    device,
    [
      sh.raw(
        `if [ -f ${quotedPath} ]; then stat -c %s ${quotedPath} 2>/dev/null || wc -c < ${quotedPath}; fi`,
      ),
    ],
    {
      allowFailure: true,
      timeoutMs: ANDROID_PERF_TIMEOUT_MS,
    },
  );
  if (result.exitCode !== 0) return undefined;
  const value = Number(result.stdout.trim().split(/\s+/)[0]);
  return Number.isFinite(value) ? value : undefined;
}
