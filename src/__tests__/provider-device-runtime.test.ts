import assert from 'node:assert/strict';
import { afterEach, test } from 'vitest';
import {
  createProviderDeviceRuntimeRequestProviders,
  getProviderDeviceInteractor,
  installProviderDeviceApp,
  setActiveProviderDeviceRuntimes,
  type ProviderDeviceRuntime,
} from '../provider-device-runtime.ts';
import type { Interactor } from '../core/interactor-types.ts';
import type { SimulatorLease } from '../daemon/lease-registry.ts';
import type { DeviceInfo } from '../utils/device.ts';

afterEach(() => {
  setActiveProviderDeviceRuntimes([]);
});

test('provider device runtime registry delegates lifecycle, inventory, interactors, and installs to matching providers', async () => {
  const lease: SimulatorLease = {
    leaseId: 'lease-a',
    tenantId: 'team-a',
    runId: 'run-a',
    backend: 'ios-instance',
    leaseProvider: 'hit',
    createdAt: 1,
    heartbeatAt: 1,
    expiresAt: 60_001,
  };
  const device: DeviceInfo = {
    platform: 'ios',
    kind: 'simulator',
    id: 'provider:ios:lease-a',
    name: 'Provider iOS',
    booted: true,
  };
  const interactor = { open: async () => undefined } as unknown as Interactor;
  const missRuntime = makeRuntime({
    provider: 'miss',
    leaseResult: undefined,
    devices: null,
    interactor: undefined,
    installResult: undefined,
  });
  const hitRuntime = makeRuntime({
    provider: 'hit',
    leaseResult: { provider: 'hit' },
    devices: [device],
    interactor,
    installResult: { bundleId: 'com.example.app' },
  });

  setActiveProviderDeviceRuntimes([missRuntime, hitRuntime]);
  const requestProviders = createProviderDeviceRuntimeRequestProviders([missRuntime, hitRuntime]);

  assert.deepEqual(await requestProviders.leaseLifecycleProvider?.allocate?.(lease), {
    provider: 'hit',
  });
  assert.deepEqual(
    await requestProviders.deviceInventoryProvider?.({
      platform: 'ios',
      leaseId: 'lease-a',
      leaseProvider: 'hit',
    }),
    [device],
  );
  assert.equal(getProviderDeviceInteractor(device), interactor);
  assert.deepEqual(await installProviderDeviceApp(device, 'com.example.app', '/tmp/app.ipa'), {
    bundleId: 'com.example.app',
  });
});

function makeRuntime(options: {
  provider: string;
  leaseResult: Record<string, unknown> | undefined;
  devices: DeviceInfo[] | null;
  interactor: Interactor | undefined;
  installResult: { bundleId: string } | undefined;
}): ProviderDeviceRuntime {
  return {
    provider: options.provider,
    leaseLifecycle: {
      allocate: async () => options.leaseResult,
      heartbeat: async () => options.leaseResult,
      release: async () => options.leaseResult,
    },
    deviceInventoryProvider: async () => options.devices,
    ownsDevice: (device) => options.devices?.some((entry) => entry.id === device.id) ?? false,
    getInteractor: () => options.interactor,
    installApp: async () => options.installResult,
    shutdown: async () => undefined,
  };
}
