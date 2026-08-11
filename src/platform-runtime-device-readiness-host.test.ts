import type { DeviceInfo } from '@agent-device/kernel/device';
import { beforeEach, expect, test, vi } from 'vitest';
import { createDeviceReadinessRuntimeHost } from './platform-runtime-device-readiness-host.ts';
import { listLocalDeviceInventory } from './core/device-inventory-context.ts';
import { resolveIosPhysicalDeviceControl } from './platforms/apple/core/physical-device-control.ts';
import { ensureBootedSimulator } from './platforms/apple/core/simulator.ts';
import { prewarmAppleRunnerCache } from './platforms/apple/core/runner/runner-client.ts';
import {
  ensureAndroidEmulatorBooted,
  waitForAndroidBoot,
} from './platforms/android/emulator-lifecycle.ts';

vi.mock('./core/device-inventory-context.ts', () => ({ listLocalDeviceInventory: vi.fn() }));
vi.mock('./platforms/apple/core/physical-device-control.ts', () => ({
  resolveIosPhysicalDeviceControl: vi.fn(),
}));
vi.mock('./platforms/apple/core/simulator.ts', () => ({ ensureBootedSimulator: vi.fn() }));
vi.mock('./platforms/apple/core/runner/runner-client.ts', () => ({
  prewarmAppleRunnerCache: vi.fn(),
}));
vi.mock('./platforms/android/emulator-lifecycle.ts', () => ({
  ensureAndroidEmulatorBooted: vi.fn(),
  waitForAndroidBoot: vi.fn(),
}));

const mockEnsureBootedSimulator = vi.mocked(ensureBootedSimulator);
const mockResolveIosPhysicalDeviceControl = vi.mocked(resolveIosPhysicalDeviceControl);
const mockPrewarmAppleRunnerCache = vi.mocked(prewarmAppleRunnerCache);
const mockEnsureAndroidEmulatorBooted = vi.mocked(ensureAndroidEmulatorBooted);
const mockWaitForAndroidBoot = vi.mocked(waitForAndroidBoot);

beforeEach(() => {
  vi.clearAllMocks();
});

test('Apple readiness preserves simulator cold-boot signaling and physical readiness', async () => {
  const physicalEnsureReady = vi.fn(async () => {});
  mockResolveIosPhysicalDeviceControl.mockReturnValue({
    ensureReady: physicalEnsureReady,
  } as unknown as ReturnType<typeof resolveIosPhysicalDeviceControl>);
  const host = createDeviceReadinessRuntimeHost();
  const coldBoot = vi.fn();
  const simulator = appleDevice({ kind: 'simulator', booted: false });
  mockEnsureBootedSimulator.mockImplementation(async (_device, options) => {
    options?.onColdBootStart?.(simulator);
  });

  await host.apple.ensureReady(simulator, { onColdBootStart: coldBoot }, signal());
  const physical = appleDevice({ kind: 'device', id: 'physical' });
  await host.apple.ensureReady(physical, {}, signal());

  expect(coldBoot).toHaveBeenCalledOnce();
  expect(physicalEnsureReady).toHaveBeenCalledWith(physical);
});

test('Apple keep-hot policy delegates only iOS-family simulators to the runner cache', async () => {
  const host = createDeviceReadinessRuntimeHost();
  const simulator = appleDevice({ kind: 'simulator' });

  host.apple.keepAutomationReady(simulator);
  host.apple.keepAutomationReady(appleDevice({ kind: 'device' }));
  host.apple.keepAutomationReady(appleDevice({ appleOs: 'macos', kind: 'device' }));

  await vi.waitFor(() => expect(mockPrewarmAppleRunnerCache).toHaveBeenCalledOnce());
  expect(mockPrewarmAppleRunnerCache).toHaveBeenCalledWith(simulator, {});
});

test('Android readiness launches stopped AVD placeholders with the selected headless policy', async () => {
  const placeholder = androidDevice({
    id: 'Pixel_9_Pro_XL',
    name: 'Pixel_9_Pro_XL',
    booted: false,
  });
  const ready = androidDevice({ id: 'emulator-5554', name: 'Pixel_9_Pro_XL', booted: true });
  mockEnsureAndroidEmulatorBooted.mockResolvedValue(ready);
  const host = createDeviceReadinessRuntimeHost();

  await expect(
    host.android.ensureReady(
      placeholder,
      { serial: 'emulator-5554', androidSerialAllowlist: ['emulator-5554'], headless: true },
      signal(),
    ),
  ).resolves.toEqual(ready);

  expect(mockEnsureAndroidEmulatorBooted).toHaveBeenCalledWith(
    { avdName: 'Pixel_9_Pro_XL', serial: 'emulator-5554', headless: true },
    {
      discoverLocal: listLocalDeviceInventory,
      androidSerialAllowlist: ['emulator-5554'],
    },
  );
  expect(mockWaitForAndroidBoot).not.toHaveBeenCalled();
});

test('Android readiness preserves physical-device boot polling', async () => {
  const physical = androidDevice({ kind: 'device', id: 'physical-1', booted: false });
  const host = createDeviceReadinessRuntimeHost();

  await expect(host.android.ensureReady(physical, { headless: false }, signal())).resolves.toEqual({
    ...physical,
    booted: true,
  });

  expect(mockWaitForAndroidBoot).toHaveBeenCalledWith('physical-1');
  expect(mockEnsureAndroidEmulatorBooted).not.toHaveBeenCalled();
});

function signal(): AbortSignal {
  return new AbortController().signal;
}

function appleDevice(overrides: Partial<DeviceInfo> = {}): DeviceInfo {
  return {
    platform: 'apple',
    appleOs: 'ios',
    id: 'simulator',
    name: 'iPhone',
    kind: 'simulator',
    target: 'mobile',
    booted: true,
    ...overrides,
  };
}

function androidDevice(overrides: Partial<DeviceInfo> = {}): DeviceInfo {
  return {
    platform: 'android',
    id: 'emulator-5554',
    name: 'Pixel',
    kind: 'emulator',
    target: 'mobile',
    booted: true,
    ...overrides,
  };
}
