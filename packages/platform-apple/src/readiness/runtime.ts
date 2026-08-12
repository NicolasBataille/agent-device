import type { PlatformRuntimeHost } from '@agent-device/contracts/platform';
import { isMacOs, type DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';

const BOOT_TIMEOUT_MS = 120_000;
const LIST_TIMEOUT_MS = 15_000;

export async function ensureAppleReady(
  host: PlatformRuntimeHost,
  device: DeviceInfo,
  signal: AbortSignal,
): Promise<DeviceInfo> {
  signal.throwIfAborted();
  if (isMacOs(device)) return { ...device, booted: true };
  if (device.kind === 'device') {
    await host.deviceReadiness.applePhysical.ensureConnected(device, signal);
    return { ...device, booted: true };
  }
  if (device.kind !== 'simulator') return { ...device, booted: true };

  const state = await simulatorState(host, device, signal);
  if (state !== 'Booted') {
    host.deviceReadiness.appleAutomation.keepHot(device);
    await bootSimulator(host, device, signal);
    await showSimulator(host, signal);
  }
  host.deviceReadiness.appleAutomation.keepHot(device);
  return { ...device, booted: true };
}

async function bootSimulator(
  host: PlatformRuntimeHost,
  device: DeviceInfo,
  signal: AbortSignal,
): Promise<void> {
  let started = false;
  try {
    const boot = await host.appleTools.run(
      {
        tool: 'simctl',
        args: simctlArgs(device, ['boot', device.id]),
        allowFailure: true,
        timeoutMs: BOOT_TIMEOUT_MS,
      },
      signal,
    );
    const output = `${boot.stdout}\n${boot.stderr}`.toLowerCase();
    const alreadyBooted =
      output.includes('already booted') || output.includes('current state: booted');
    if (boot.exitCode !== 0 && !alreadyBooted) {
      throw new AppError('COMMAND_FAILED', 'simctl boot failed', {
        stdout: boot.stdout,
        stderr: boot.stderr,
        exitCode: boot.exitCode,
      });
    }
    started = !alreadyBooted;
    const status = await host.appleTools.run(
      {
        tool: 'simctl',
        args: simctlArgs(device, ['bootstatus', device.id, '-b']),
        allowFailure: true,
        timeoutMs: BOOT_TIMEOUT_MS,
      },
      signal,
    );
    if (status.exitCode !== 0) {
      throw new AppError('COMMAND_FAILED', 'simctl bootstatus failed', {
        stdout: status.stdout,
        stderr: status.stderr,
        exitCode: status.exitCode,
      });
    }
    if ((await simulatorState(host, device, signal)) !== 'Booted') {
      throw new AppError('COMMAND_FAILED', 'Simulator is still booting', { deviceId: device.id });
    }
  } catch (error) {
    if (started && signal.aborted) scheduleSimulatorShutdown(host, device);
    signal.throwIfAborted();
    throw error;
  }
}

async function simulatorState(
  host: PlatformRuntimeHost,
  device: DeviceInfo,
  signal: AbortSignal,
): Promise<string | null> {
  const result = await host.appleTools.run(
    {
      tool: 'simctl',
      args: simctlArgs(device, ['list', 'devices', '-j']),
      allowFailure: true,
      timeoutMs: LIST_TIMEOUT_MS,
    },
    signal,
  );
  if (result.exitCode !== 0) return null;
  try {
    const payload = JSON.parse(result.stdout) as {
      devices: Record<string, Array<{ udid: string; state: string }>>;
    };
    return (
      Object.values(payload.devices)
        .flat()
        .find(({ udid }) => udid === device.id)?.state ?? null
    );
  } catch {
    return null;
  }
}

function simctlArgs(device: DeviceInfo, args: readonly string[]): string[] {
  return device.simulatorSetPath ? ['--set', device.simulatorSetPath, ...args] : [...args];
}

async function showSimulator(host: PlatformRuntimeHost, signal: AbortSignal): Promise<void> {
  await host.commands.run(
    { executable: 'open', args: ['-a', 'Simulator'], allowFailure: true, timeoutMs: 10_000 },
    signal,
  );
}

function scheduleSimulatorShutdown(host: PlatformRuntimeHost, device: DeviceInfo): void {
  void host.appleTools
    .run({ tool: 'simctl', args: simctlArgs(device, ['shutdown', device.id]), allowFailure: true })
    .catch(() => {});
}
