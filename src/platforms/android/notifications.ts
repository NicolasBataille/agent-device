import { AppError } from '@agent-device/kernel/errors';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { runAndroidShell } from './adb.ts';
import { sh, type ShellSafe } from '@agent-device/kernel/shell';

type AndroidBroadcastPayload = {
  action?: string;
  receiver?: string;
  extras?: Record<string, unknown>;
};

export async function pushAndroidNotification(
  device: DeviceInfo,
  packageName: string,
  payload: AndroidBroadcastPayload,
  options: Readonly<{ signal?: AbortSignal }> = {},
): Promise<{ action: string; extrasCount: number }> {
  const action =
    typeof payload.action === 'string' && payload.action.trim()
      ? payload.action.trim()
      : `${packageName}.TEST_PUSH`;
  const args: ShellSafe[] = [
    ...sh.lits('am', 'broadcast', '-a'),
    sh.arg(action),
    sh.lit('-p'),
    sh.arg(packageName),
  ];
  const receiver = typeof payload.receiver === 'string' ? payload.receiver.trim() : '';
  if (receiver) {
    args.push(sh.lit('-n'), sh.arg(receiver));
  }
  const rawExtras = payload.extras;
  if (
    rawExtras !== undefined &&
    (typeof rawExtras !== 'object' || rawExtras === null || Array.isArray(rawExtras))
  ) {
    throw new AppError('INVALID_ARGS', 'Android push payload extras must be an object');
  }
  const extras = rawExtras ?? {};
  let extrasCount = 0;
  for (const [key, rawValue] of Object.entries(extras)) {
    if (!key) continue;
    appendBroadcastExtra(args, key, rawValue);
    extrasCount += 1;
  }
  await runAndroidShell(device, args, { signal: options.signal });
  return { action, extrasCount };
}

function appendBroadcastExtra(args: ShellSafe[], key: string, value: unknown): void {
  if (typeof value === 'string') {
    args.push(sh.lit('--es'), sh.arg(key), sh.arg(value));
    return;
  }
  if (typeof value === 'boolean') {
    args.push(sh.lit('--ez'), sh.arg(key), sh.lit(value ? 'true' : 'false'));
    return;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (Number.isInteger(value)) {
      args.push(sh.lit('--ei'), sh.arg(key), sh.num(value));
      return;
    }
    args.push(sh.lit('--ef'), sh.arg(key), sh.num(value));
    return;
  }
  throw new AppError(
    'INVALID_ARGS',
    `Unsupported Android broadcast extra type for "${key}". Use string, boolean, or number.`,
  );
}
