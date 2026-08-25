import { AppError } from '@agent-device/kernel/errors';
import type { AppStateRuntimeResult } from '@agent-device/contracts/platform';
import { sleep } from '../../utils/timeouts.ts';
import type { AppsFilter } from '@agent-device/contracts/device';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { isDeepLinkTarget } from '@agent-device/contracts/command';
import { sh, type ShellSafe } from '@agent-device/kernel/shell';
import { waitForAndroidBoot } from './emulator-lifecycle.ts';
import { runAndroidShell } from './adb.ts';
import {
  androidAdbResultError,
  createAndroidPortReverseManager,
  resolveAndroidAdbProvider,
  type AndroidPortReverseEndpoint,
} from './adb-executor.ts';
import {
  androidAppsDiscoveryHint,
  inferAndroidAppName,
  resolveAndroidApp,
} from './app-deployment-resolution.ts';
import {
  parseAndroidBlockingDialogFocus,
  parseAndroidLaunchablePackages,
  parseAndroidUserInstalledPackages,
  type AndroidBlockingDialogFocus,
} from './app-parsers.ts';

export type { AndroidBlockingDialogFocus } from './app-parsers.ts';

const ANDROID_LAUNCHER_CATEGORY = 'android.intent.category.LAUNCHER';
const ANDROID_LEANBACK_CATEGORY = 'android.intent.category.LEANBACK_LAUNCHER';
const ANDROID_DEFAULT_CATEGORY = 'android.intent.category.DEFAULT';
const ANDROID_LOCALHOST_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const ANDROID_CLOSE_FOCUS_TIMEOUT_MS = 2_000;
const ANDROID_CLOSE_FOCUS_POLL_MS = 50;
const ANDROID_CLOSE_PROCESS_TIMEOUT_MS = 2_000;
const ANDROID_CLOSE_PROCESS_POLL_MS = 50;
const ANDROID_CLOSE_PROCESS_GONE_STABLE_MS = 150;
const ANDROID_FOREGROUND_COMMANDS = [
  ['dumpsys', 'window', 'windows'],
  ['dumpsys', 'window'],
  ['dumpsys', 'activity', 'activities'],
  ['dumpsys', 'activity'],
] as const;
const ANDROID_FOCUS_LINE =
  /(?:(mCurrentFocus=Window\{)|(mFocusedApp=AppWindowToken\{)|(mResumedActivity:)|(ResumedActivity:))(.*)$/gm;

export async function listAndroidApps(
  device: DeviceInfo,
  filter: AppsFilter,
): Promise<Array<{ package: string; name: string }>> {
  const launchable = await listAndroidLaunchablePackages(device);
  const packageIds =
    filter === 'user-installed'
      ? (await listAndroidUserInstalledPackages(device)).filter((pkg) => launchable.has(pkg))
      : Array.from(launchable);
  return packageIds
    .sort((a, b) => a.localeCompare(b))
    .map((pkg) => ({ package: pkg, name: inferAndroidAppName(pkg) }));
}

async function listAndroidLaunchablePackages(device: DeviceInfo): Promise<Set<string>> {
  const packages = new Set<string>();
  for (const category of resolveAndroidLaunchCategories(device, {
    includeFallbackWhenUnknown: true,
  })) {
    const result = await runAndroidShell(
      device,
      [
        ...sh.lits(
          'cmd',
          'package',
          'query-activities',
          '--brief',
          '-a',
          'android.intent.action.MAIN',
          '-c',
        ),
        sh.arg(category),
      ],
      { allowFailure: true },
    );
    if (result.exitCode !== 0 || result.stdout.trim().length === 0) {
      continue;
    }
    for (const pkg of parseAndroidLaunchablePackages(result.stdout)) {
      packages.add(pkg);
    }
  }
  return packages;
}

function resolveAndroidLauncherCategory(device: DeviceInfo): string {
  return resolveAndroidLaunchCategories(device)[0] ?? ANDROID_LAUNCHER_CATEGORY;
}

function resolveAndroidLaunchCategories(
  device: DeviceInfo,
  options: { includeFallbackWhenUnknown?: boolean } = {},
): string[] {
  if (device.target === 'tv') {
    return [ANDROID_LEANBACK_CATEGORY];
  }
  if (device.target === 'mobile') {
    return [ANDROID_LAUNCHER_CATEGORY];
  }
  if (options.includeFallbackWhenUnknown) {
    return [ANDROID_LAUNCHER_CATEGORY, ANDROID_LEANBACK_CATEGORY];
  }
  return [ANDROID_LAUNCHER_CATEGORY];
}

async function listAndroidUserInstalledPackages(device: DeviceInfo): Promise<string[]> {
  const result = await runAndroidShell(device, sh.lits('pm', 'list', 'packages', '-3'));
  return parseAndroidUserInstalledPackages(result.stdout);
}

export async function getAndroidAppState(device: DeviceInfo): Promise<AppStateRuntimeResult> {
  for (const args of ANDROID_FOREGROUND_COMMANDS) {
    const result = await runAndroidShell(device, sh.lits(...args), { allowFailure: true });
    const state = parseLegacyAndroidForegroundApp(result.stdout ?? '');
    if (state) return state;
  }
  return {};
}

export async function getAndroidBlockingDialogFocus(
  device: DeviceInfo,
): Promise<AndroidBlockingDialogFocus | null> {
  return await readAndroidBlockingDialogFocus(device, [
    ['dumpsys', 'window', 'windows'],
    ['dumpsys', 'window'],
  ]);
}

async function readAndroidBlockingDialogFocus(
  device: DeviceInfo,
  commands: string[][],
): Promise<AndroidBlockingDialogFocus | null> {
  for (const args of commands) {
    const result = await runAndroidShell(device, sh.lits(...args), { allowFailure: true });
    const parsed = parseAndroidBlockingDialogFocus(result.stdout ?? '');
    if (parsed) return parsed;
  }
  return null;
}

function androidLocalhostReverseEndpoint(target: string): AndroidPortReverseEndpoint | null {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return null;
  }

  const hostname = url.hostname.toLowerCase();
  if (!ANDROID_LOCALHOST_HOSTNAMES.has(hostname)) return null;
  if (!url.port) return null;
  const port = Number(url.port);
  if (!Number.isInteger(port)) return null;
  return `tcp:${port}`;
}

async function ensureAndroidLocalhostReverse(device: DeviceInfo, target: string): Promise<void> {
  const endpoint = androidLocalhostReverseEndpoint(target);
  if (!endpoint) return;

  const reverse = createAndroidPortReverseManager(resolveAndroidAdbProvider(device));
  try {
    await reverse.ensure({ local: endpoint, remote: endpoint });
  } catch (error) {
    const details = {
      localPort: endpoint.replace('tcp:', ''),
      operation: `adb reverse ${endpoint} ${endpoint}`,
    };
    if (error instanceof AppError) {
      Object.assign(details, {
        hint: error.details?.hint,
        diagnosticId: error.details?.diagnosticId,
        logPath: error.details?.logPath,
      });
    }
    throw new AppError(
      'COMMAND_FAILED',
      `Failed to ensure Android port reverse ${endpoint} before opening localhost URL`,
      details,
      error,
    );
  }
}

export type OpenAndroidAppOptions = {
  activity?: string;
  appBundleId?: string;
  launchArgs?: string[];
  url?: string;
};

// `adb shell` joins its argv with spaces and feeds the result to a device
// shell, which re-tokenises. The other `am start` arguments (action, category,
// component, etc.) are well-known and never contain shell-significant
// characters, so they round-trip untouched. URLs and launch arguments are
// user-supplied and may contain JSON, spaces, `#`, or `&`; each is single-quoted
// unless it consists entirely of safe shell characters.
function androidLaunchArgs(options: OpenAndroidAppOptions): ShellSafe[] {
  return (options.launchArgs ?? []).map(sh.arg);
}

export async function openAndroidApp(
  device: DeviceInfo,
  app: string,
  optionsOrActivity?: OpenAndroidAppOptions | string,
): Promise<void> {
  if (!device.booted) {
    await waitForAndroidBoot(device.id);
  }
  const options = normalizeOpenAndroidAppOptions(optionsOrActivity);
  const activity = options.activity;
  const deepLinkTarget = app.trim();
  if (isDeepLinkTarget(deepLinkTarget)) {
    await openAndroidDeepLink(device, deepLinkTarget, options);
    return;
  }
  if (options.url !== undefined) {
    await openAndroidAppBoundDeepLink(device, app, options);
    return;
  }
  const resolved = await resolveAndroidApp(device, app);
  const launchCategory = resolveAndroidLauncherCategory(device);
  if (resolved.type === 'intent') {
    await openAndroidIntent(device, resolved.value, options);
    return;
  }
  if (activity) {
    await openAndroidPackageActivity(device, resolved.value, activity, launchCategory, options);
    return;
  }
  await openAndroidPackage(device, resolved.value, launchCategory, options);
}

async function openAndroidDeepLink(
  device: DeviceInfo,
  target: string,
  options: OpenAndroidAppOptions,
): Promise<void> {
  if (options.activity) {
    throw new AppError(
      'INVALID_ARGS',
      'Activity override is not supported when opening a deep link URL',
    );
  }
  await ensureAndroidLocalhostReverse(device, target);
  await runAndroidShell(device, [
    ...sh.lits('am', 'start', '-W', '-a', 'android.intent.action.VIEW', '-d'),
    sh.arg(target),
    ...androidDeepLinkPackageArgs(options.appBundleId),
    ...androidLaunchArgs(options),
  ]);
}

async function openAndroidAppBoundDeepLink(
  device: DeviceInfo,
  app: string,
  options: OpenAndroidAppOptions,
): Promise<void> {
  if (options.activity) {
    throw new AppError(
      'INVALID_ARGS',
      'Activity override is not supported when opening an app-bound deep link URL',
    );
  }
  const deepLinkUrl = options.url?.trim() ?? '';
  if (!isDeepLinkTarget(deepLinkUrl)) {
    throw new AppError('INVALID_ARGS', 'Android app-bound open requires a valid URL target');
  }
  await ensureAndroidLocalhostReverse(device, deepLinkUrl);
  const resolved = await resolveAndroidPackageForOpen(device, app, 'app-bound open');
  await runAndroidShell(device, [
    ...sh.lits('am', 'start', '-W', '-a', 'android.intent.action.VIEW', '-d'),
    sh.arg(deepLinkUrl),
    sh.lit('-p'),
    sh.arg(resolved),
    ...androidLaunchArgs(options),
  ]);
}

async function openAndroidIntent(
  device: DeviceInfo,
  intent: string,
  options: OpenAndroidAppOptions,
): Promise<void> {
  if (options.activity) {
    throw new AppError('INVALID_ARGS', 'Activity override requires a package name, not an intent');
  }
  await runAndroidShell(device, [
    ...sh.lits('am', 'start', '-W', '-a'),
    sh.arg(intent),
    ...androidLaunchArgs(options),
  ]);
}

async function openAndroidPackageActivity(
  device: DeviceInfo,
  packageName: string,
  activity: string,
  launchCategory: string,
  options: OpenAndroidAppOptions,
): Promise<void> {
  const component = activity.includes('/')
    ? activity
    : `${packageName}/${activity.startsWith('.') ? activity : `.${activity}`}`;
  try {
    await runAndroidShell(
      device,
      buildAndroidActivityLaunchArgs(component, launchCategory, options),
    );
  } catch (error) {
    await maybeRethrowAndroidMissingPackageError(device, packageName, error);
    throw error;
  }
}

async function openAndroidPackage(
  device: DeviceInfo,
  packageName: string,
  launchCategory: string,
  options: OpenAndroidAppOptions,
): Promise<void> {
  const primaryResult = await runAndroidShell(
    device,
    [
      ...sh.lits('am', 'start', '-W', '-a', 'android.intent.action.MAIN', '-c'),
      sh.lit(ANDROID_DEFAULT_CATEGORY),
      sh.lit('-c'),
      sh.arg(launchCategory),
      sh.lit('-p'),
      sh.arg(packageName),
      ...androidLaunchArgs(options),
    ],
    { allowFailure: true },
  );
  if (primaryResult.exitCode === 0 && !isAmStartError(primaryResult.stdout, primaryResult.stderr)) {
    return;
  }
  const component = await resolveAndroidLaunchComponent(device, packageName);
  if (!component) {
    if (!(await isAndroidPackageInstalled(device, packageName))) {
      throw buildAndroidPackageNotInstalledError(packageName);
    }
    throw androidAdbResultError(`Failed to launch ${packageName}`, primaryResult);
  }
  await runAndroidShell(device, buildAndroidActivityLaunchArgs(component, launchCategory, options));
}

function buildAndroidActivityLaunchArgs(
  component: string,
  launchCategory: string,
  options: OpenAndroidAppOptions,
): ShellSafe[] {
  return [
    ...sh.lits('am', 'start', '-W', '-a', 'android.intent.action.MAIN', '-c'),
    sh.lit(ANDROID_DEFAULT_CATEGORY),
    sh.lit('-c'),
    sh.arg(launchCategory),
    sh.lit('-n'),
    sh.arg(component),
    ...androidLaunchArgs(options),
  ];
}

async function resolveAndroidPackageForOpen(
  device: DeviceInfo,
  app: string,
  label: string,
): Promise<string> {
  const resolved = await resolveAndroidApp(device, app);
  if (resolved.type === 'intent') {
    throw new AppError('INVALID_ARGS', `Android ${label} requires a package name, not an intent`);
  }
  return resolved.value;
}

function normalizeOpenAndroidAppOptions(
  optionsOrActivity: OpenAndroidAppOptions | string | undefined,
): OpenAndroidAppOptions {
  if (typeof optionsOrActivity === 'string') return { activity: optionsOrActivity };
  return optionsOrActivity ?? {};
}

function androidDeepLinkPackageArgs(packageName: string | undefined): ShellSafe[] {
  const normalized = packageName?.trim();
  return normalized ? [sh.lit('-p'), sh.arg(normalized)] : [];
}

function buildAndroidPackageNotInstalledError(packageName: string): AppError {
  return new AppError('APP_NOT_INSTALLED', `No package found matching "${packageName}"`, {
    package: packageName,
    hint: androidAppsDiscoveryHint,
  });
}

async function isAndroidPackageInstalled(
  device: DeviceInfo,
  packageName: string,
): Promise<boolean> {
  const result = await runAndroidShell(device, [...sh.lits('pm', 'path'), sh.arg(packageName)], {
    allowFailure: true,
  });
  const output = `${result.stdout}\n${result.stderr}`;
  if (result.exitCode === 0 && /\bpackage:/i.test(output)) {
    return true;
  }
  if (looksLikeMissingAndroidPackageOutput(output)) {
    return false;
  }
  return false;
}

async function maybeRethrowAndroidMissingPackageError(
  device: DeviceInfo,
  packageName: string,
  error: unknown,
): Promise<void> {
  const output =
    error instanceof AppError
      ? `${String(error.details?.stdout ?? '')}\n${String(error.details?.stderr ?? '')}`
      : '';
  if (looksLikeMissingAndroidPackageOutput(output)) {
    throw buildAndroidPackageNotInstalledError(packageName);
  }
  if (!(await isAndroidPackageInstalled(device, packageName))) {
    throw buildAndroidPackageNotInstalledError(packageName);
  }
}

function looksLikeMissingAndroidPackageOutput(output: string): boolean {
  return (
    /\bunknown package\b/i.test(output) ||
    /\bpackage .* (?:was|is) not found\b/i.test(output) ||
    /\bpackage .* does not exist\b/i.test(output) ||
    /\bcould not find package\b/i.test(output)
  );
}

async function resolveAndroidLaunchComponent(
  device: DeviceInfo,
  packageName: string,
): Promise<string | null> {
  const categories = Array.from(
    new Set(resolveAndroidLaunchCategories(device, { includeFallbackWhenUnknown: true })),
  );
  for (const category of categories) {
    const result = await runAndroidShell(
      device,
      [
        ...sh.lits(
          'cmd',
          'package',
          'resolve-activity',
          '--brief',
          '-a',
          'android.intent.action.MAIN',
          '-c',
        ),
        sh.arg(category),
        sh.arg(packageName),
      ],
      { allowFailure: true },
    );
    if (result.exitCode !== 0) {
      continue;
    }
    const component = parseAndroidLaunchComponent(result.stdout);
    if (component) return component;
  }
  return null;
}

export function isAmStartError(stdout: string, stderr: string): boolean {
  const output = `${stdout}\n${stderr}`;
  return /Error:.*(?:Activity not started|unable to resolve Intent)/i.test(output);
}

export function parseAndroidLaunchComponent(stdout: string): string | null {
  const lines = stdout
    .split('\n')
    .map((line: string) => line.trim())
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line === undefined) continue;
    if (!line.includes('/')) continue;
    const component = line.split(/\s+/)[0];
    if (component !== undefined) return component;
  }
  return null;
}

export async function openAndroidDevice(device: DeviceInfo): Promise<void> {
  if (!device.booted) {
    await waitForAndroidBoot(device.id);
  }
}

export async function closeAndroidApp(device: DeviceInfo, app: string): Promise<void> {
  const trimmed = app.trim();
  if (trimmed.toLowerCase() === 'settings') {
    await runAndroidShell(device, sh.lits('am', 'force-stop', 'com.android.settings'));
    await waitForAndroidPackageStopped(device, 'com.android.settings');
    return;
  }
  const resolved = await resolveAndroidApp(device, app);
  if (resolved.type === 'intent') {
    throw new AppError('INVALID_ARGS', 'Close requires a package name, not an intent');
  }
  await runAndroidShell(device, [...sh.lits('am', 'force-stop'), sh.arg(resolved.value)]);
  await waitForAndroidPackageStopped(device, resolved.value);
}

async function waitForAndroidPackageStopped(
  device: DeviceInfo,
  packageName: string,
): Promise<void> {
  await waitForAndroidPackageNotForeground(device, packageName);
  await waitForAndroidPackageProcessGone(device, packageName);
}

async function waitForAndroidPackageNotForeground(
  device: DeviceInfo,
  packageName: string,
): Promise<void> {
  const deadline = Date.now() + ANDROID_CLOSE_FOCUS_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const foreground = await readAndroidForegroundApp(device);
    if (foreground?.package !== packageName) return;
    await sleep(ANDROID_CLOSE_FOCUS_POLL_MS);
  }
}

async function readAndroidForegroundApp(device: DeviceInfo): Promise<AppStateRuntimeResult | null> {
  const foreground = await getAndroidAppState(device);
  return foreground.package ? foreground : null;
}

function parseLegacyAndroidForegroundApp(text: string): AppStateRuntimeResult | null {
  for (const match of text.matchAll(ANDROID_FOCUS_LINE)) {
    const segment = match[5];
    const component = segment?.match(
      /\b([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+)\/([A-Za-z0-9_.$]+)/,
    );
    if (component?.[1] && component[2]) {
      return { package: component[1], activity: component[2] };
    }
  }
  return null;
}

async function waitForAndroidPackageProcessGone(
  device: DeviceInfo,
  packageName: string,
): Promise<void> {
  const deadline = Date.now() + ANDROID_CLOSE_PROCESS_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!(await isAndroidPackageProcessRunning(device, packageName))) {
      await sleep(ANDROID_CLOSE_PROCESS_GONE_STABLE_MS);
      if (!(await isAndroidPackageProcessRunning(device, packageName))) return;
    }
    await sleep(ANDROID_CLOSE_PROCESS_POLL_MS);
  }
}

async function isAndroidPackageProcessRunning(
  device: DeviceInfo,
  packageName: string,
): Promise<boolean> {
  const result = await runAndroidShell(device, [sh.lit('pidof'), sh.arg(packageName)], {
    allowFailure: true,
  });
  return (result.stdout ?? '').trim().length > 0;
}
