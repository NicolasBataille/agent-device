import assert from 'node:assert/strict';
import { afterEach, test } from 'vitest';
import {
  composeCloudDeviceInventoryProvider,
  composeCloudLeaseProvider,
  getCloudInteractor,
  setActiveCloudRuntimes,
  type CloudDeviceRuntime,
} from '../cloud/cloud-runtime.ts';
import type { Interactor } from '../core/interactor-types.ts';
import type { SimulatorLease } from '../daemon/lease-registry.ts';
import type { DeviceInfo } from '../utils/device.ts';

afterEach(() => {
  setActiveCloudRuntimes([]);
});

test('cloud runtime registry delegates inventory, leases, and interactors to matching providers', async () => {
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
  });
  const hitRuntime = makeRuntime({
    provider: 'hit',
    leaseResult: { provider: 'hit' },
    devices: [device],
    interactor,
  });

  setActiveCloudRuntimes([missRuntime, hitRuntime]);

  const leaseLifecycle = composeCloudLeaseProvider([missRuntime, hitRuntime]);
  const inventoryProvider = composeCloudDeviceInventoryProvider([missRuntime, hitRuntime]);

  assert.deepEqual(await leaseLifecycle?.allocate?.(lease), { provider: 'hit' });
  assert.deepEqual(
    await inventoryProvider?.({ platform: 'ios', leaseId: 'lease-a', leaseProvider: 'hit' }),
    [device],
  );
  assert.equal(getCloudInteractor(device), interactor);
});

function makeRuntime(options: {
  provider?: string;
  leaseResult: Record<string, unknown> | undefined;
  devices: DeviceInfo[] | null;
  interactor: Interactor | undefined;
}): CloudDeviceRuntime {
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
    shutdown: async () => undefined,
  };
}
