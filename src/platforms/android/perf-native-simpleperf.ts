import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { sh } from '@agent-device/kernel/shell';
import { runAndroidShell } from './adb.ts';
import {
  buildAndroidNativeRemotePath,
  cleanupAndroidRemotePath,
  readFileSize,
  shellQuote,
  stopAndroidNativePerfSession,
  writeJsonArtifact,
} from './perf-native-artifacts.ts';
import { annotateAndroidNativePerfError } from './perf-native-errors.ts';
import { parseSimpleperfReportEntries } from './perf-native-report.ts';
import {
  assertAndroidNativeToolAvailable,
  findPidToken,
  resolveAndroidAppPid,
} from './perf-native-process.ts';
import {
  ANDROID_NATIVE_MAX_SECONDS,
  ANDROID_NATIVE_PROFILE_TIMEOUT_MS,
  ANDROID_NATIVE_REMOTE_DIR,
  ANDROID_SIMPLEPERF_METHOD,
  type AndroidNativePerfOptions,
  type AndroidNativePerfSession,
  type AndroidNativePerfStartResult,
  type AndroidNativePerfStopResult,
  type AndroidSimpleperfReportResult,
} from './perf-native-types.ts';

const SIMPLEPERF_AGENT_TOP_FUNCTION_LIMIT = 10;

export async function startAndroidSimpleperfProfile(
  device: DeviceInfo,
  packageName: string,
  outPath: string,
  _options: AndroidNativePerfOptions = {},
): Promise<AndroidNativePerfStartResult> {
  const appPid = await resolveAndroidAppPid(device, packageName);
  await assertAndroidNativeToolAvailable(device, 'simpleperf', packageName);
  const remotePath = buildAndroidNativeRemotePath(packageName, 'cpu.perf.data');
  let profilerPid: string;
  try {
    profilerPid = await startAndroidSimpleperfBackgroundTool(
      device,
      appPid,
      remotePath,
      packageName,
    );
  } catch (error) {
    await cleanupAndroidRemotePath(device, remotePath);
    throw error;
  }
  const session = {
    type: 'cpu-profile',
    kind: 'simpleperf',
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
    method: ANDROID_SIMPLEPERF_METHOD,
    message: `Started Android Simpleperf CPU profile for ${packageName}`,
  };
}

export async function stopAndroidSimpleperfProfile(
  device: DeviceInfo,
  session: AndroidNativePerfSession,
  outPath: string,
  options: AndroidNativePerfOptions = {},
): Promise<AndroidNativePerfStopResult> {
  return await stopAndroidNativePerfSession(device, { ...session, outPath }, options);
}

export async function writeAndroidSimpleperfReport(
  device: DeviceInfo,
  session: AndroidNativePerfSession,
  outPath: string,
  _options: AndroidNativePerfOptions = {},
): Promise<AndroidSimpleperfReportResult> {
  await assertAndroidNativeToolAvailable(device, 'simpleperf', session.packageName);
  const report = await runAndroidSimpleperfReport(device, session);
  const generatedAt = new Date().toISOString();
  const entries = parseSimpleperfReportEntries(report.stdout);
  const topFunctions = entries.slice(0, SIMPLEPERF_AGENT_TOP_FUNCTION_LIMIT).map((entry) => ({
    symbol: entry.symbol ?? '<unknown>',
    binary: entry.dso,
    selfSamplePercent: entry.percentage,
  }));
  const payload = {
    kind: 'simpleperf-report',
    generatedAt,
    packageName: session.packageName,
    appPid: session.appPid,
    sourceProfilePath: session.outPath,
    sourceRemotePath: session.remotePath,
    entryCount: entries.length,
    summary: { topFunctions },
    entries,
  };
  await writeJsonArtifact(outPath, payload);
  const sizeBytes = await readFileSize(outPath);
  return {
    action: 'report',
    platform: 'android',
    type: 'cpu-profile-report',
    kind: 'simpleperf',
    packageName: session.packageName,
    appPid: session.appPid,
    sourceProfilePath: session.outPath,
    outPath,
    sizeBytes,
    generatedAt,
    entryCount: entries.length,
    summary: { topFunctions },
    method: ANDROID_SIMPLEPERF_METHOD,
    message: `Wrote Android Simpleperf report for ${session.packageName}`,
  };
}

async function startAndroidSimpleperfBackgroundTool(
  device: DeviceInfo,
  appPid: string,
  remotePath: string,
  packageName: string,
): Promise<string> {
  try {
    // shell-safe-approved: buildSimpleperfStartCommand emits a background-launch script whose
    // dynamic parts (appPid, remotePath, stderr path) are all shellQuote-escaped and the
    // duration is a numeric String(...) — no unquoted dynamic value reaches the fragment
    const result = await runAndroidShell(
      device,
      [sh.raw(buildSimpleperfStartCommand(appPid, remotePath))],
      {
        timeoutMs: ANDROID_NATIVE_PROFILE_TIMEOUT_MS,
      },
    );
    const pid = findPidToken(result.stdout);
    if (pid) return pid;
    throw new AppError('COMMAND_FAILED', 'Android simpleperf did not return a profiler pid', {
      package: packageName,
      tool: 'simpleperf',
      hint: 'Retry perf. If simpleperf exits immediately, verify the app is profileable and the device permits native profiling.',
    });
  } catch (error) {
    throw annotateAndroidNativePerfError('start', 'simpleperf', packageName, error);
  }
}

function buildSimpleperfStartCommand(appPid: string, remotePath: string): string {
  return buildBackgroundShellCommand(
    [
      'simpleperf',
      'record',
      '-e',
      'cpu-clock:u',
      '-p',
      appPid,
      '-o',
      remotePath,
      '--duration',
      String(ANDROID_NATIVE_MAX_SECONDS),
    ],
    'simpleperf',
  );
}

function buildBackgroundShellCommand(argv: string[], label: string): string {
  const command = argv.map(shellQuote).join(' ');
  const stderrPath = `${ANDROID_NATIVE_REMOTE_DIR}/agent-device-${label}-${Date.now()}.err`;
  return [
    `err=${shellQuote(stderrPath)}`,
    `(${command}) >/dev/null 2>"$err" & pid=$!`,
    'sleep 1',
    'if kill -0 "$pid" 2>/dev/null; then rm -f "$err"; echo "$pid"; exit 0; fi',
    'cat "$err" >&2',
    'rm -f "$err"',
    'exit 1',
  ].join('; ');
}

async function runAndroidSimpleperfReport(
  device: DeviceInfo,
  session: AndroidNativePerfSession,
): Promise<{ stdout: string }> {
  try {
    return await runAndroidShell(
      device,
      [
        ...sh.lits('simpleperf', 'report', '-i'),
        sh.arg(session.remotePath),
        ...sh.lits('--stdio', '--sort', 'comm,dso,symbol'),
      ],
      {
        timeoutMs: ANDROID_NATIVE_PROFILE_TIMEOUT_MS,
      },
    );
  } catch (error) {
    throw annotateAndroidNativePerfError('report', 'simpleperf', session.packageName, error);
  }
}
