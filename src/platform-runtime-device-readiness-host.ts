import type {
  DeviceReadinessRuntimeHost,
  EnsureReadyInput,
} from '@agent-device/contracts/platform';
import { isIosFamily, type DeviceInfo } from '@agent-device/kernel/device';
import { listLocalDeviceInventory } from './core/device-inventory-context.ts';

export function createDeviceReadinessRuntimeHost(): DeviceReadinessRuntimeHost {
  return Object.freeze({
    apple: Object.freeze({
      ensureReady: async (
        device: DeviceInfo,
        options: Readonly<{ onColdBootStart?: () => void }>,
        signal: AbortSignal,
      ) => {
        signal.throwIfAborted();
        if (isIosFamily(device) && device.kind === 'simulator') {
          const { ensureBootedSimulator } = await import('./platforms/apple/core/simulator.ts');
          await ensureBootedSimulator(device, {
            onColdBootStart: () => options.onColdBootStart?.(),
          });
        } else if (isIosFamily(device) && device.kind === 'device') {
          const { resolveIosPhysicalDeviceControl } =
            await import('./platforms/apple/core/physical-device-control.ts');
          await resolveIosPhysicalDeviceControl(device).ensureReady(device);
        }
        signal.throwIfAborted();
      },
      keepAutomationReady: (device: DeviceInfo) => {
        if (!isIosFamily(device) || device.kind !== 'simulator') return;
        void import('./platforms/apple/core/runner/runner-client.ts').then(
          ({ prewarmAppleRunnerCache }) => prewarmAppleRunnerCache(device, {}),
        );
      },
    }),
    android: Object.freeze({
      ensureReady: async (
        device: DeviceInfo,
        input: EnsureReadyInput & Readonly<{ headless: boolean }>,
        signal: AbortSignal,
      ) => {
        signal.throwIfAborted();
        if (device.kind === 'emulator' && (device.booted !== true || !isRunningEmulator(device))) {
          const { ensureAndroidEmulatorBooted } =
            await import('./platforms/android/emulator-lifecycle.ts');
          const ready = await ensureAndroidEmulatorBooted(
            {
              avdName: device.name,
              serial: input.serial,
              headless: input.headless,
            },
            {
              discoverLocal: listLocalDeviceInventory,
              androidSerialAllowlist: input.androidSerialAllowlist,
            },
          );
          signal.throwIfAborted();
          return ready;
        }
        if (device.booted !== true) {
          const { waitForAndroidBoot } = await import('./platforms/android/emulator-lifecycle.ts');
          await waitForAndroidBoot(device.id);
        }
        signal.throwIfAborted();
        return { ...device, booted: true };
      },
    }),
  });
}

function isRunningEmulator(device: DeviceInfo): boolean {
  return device.id.startsWith('emulator-');
}
