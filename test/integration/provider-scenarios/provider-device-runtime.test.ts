import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  createProviderDeviceRuntimeRequestProviders,
  setActiveProviderDeviceRuntimes,
  type ProviderDeviceRuntime,
  type ProviderPortReverseOptions,
} from '../../../src/provider-device-runtime.ts';
import type { DeviceInventoryProvider } from '../../../src/core/dispatch-resolve.ts';
import type { Interactor, SnapshotResult } from '../../../src/core/interactor-types.ts';
import type { LeaseLifecycleProvider } from '../../../src/daemon/handlers/lease.ts';
import type { DeviceLease } from '../../../src/daemon/lease-registry.ts';
import type { DaemonRequest } from '../../../src/daemon/types.ts';
import type { DeviceInfo } from '../../../src/utils/device.ts';
import { assertRpcOk } from './assertions.ts';
import { createProviderScenarioHarness, withProviderScenarioResource } from './harness.ts';
import { runProviderScenario } from './scenario.ts';

const FAKE_PROVIDER = 'fake-provider';
const DEVTOOLS_PORT_REVERSE = { devicePort: 8097, hostPort: 8097, portReverseName: 'devtools' };
const ABSENT_FAKE_PROVIDER_INTERACTOR_PROPERTIES = new Set([
  'then',
  'tapElementSelector',
  'fillElementSelector',
  'setViewport',
]);

type FakeProviderCall = {
  type:
    | 'lease.allocate'
    | 'lease.heartbeat'
    | 'lease.release'
    | 'inventory'
    | 'open'
    | 'tap'
    | 'snapshot'
    | 'portReverse.ensure'
    | 'portReverse.remove';
  [key: string]: unknown;
};

type FakeProviderSession = {
  device: DeviceInfo;
  interactor: Interactor;
};

test('Provider-backed scenario composes lease, inventory, dispatch, and port reverse providers', async () => {
  await withProviderScenarioResource(createFakeProviderWorld, async ({ daemon, runtime }) => {
    const allocate = await daemon.callCommand('lease_allocate', [], leaseFlags(), {
      meta: leaseMeta(),
    });
    const { lease } = assertRpcOk<{ lease: DeviceLease }>(allocate);
    const flags = leaseFlags(lease.leaseId);
    const meta = leaseMeta(lease.leaseId);
    const portReverse = {
      provider: FAKE_PROVIDER,
      leaseId: lease.leaseId,
      devicePort: DEVTOOLS_PORT_REVERSE.devicePort,
      hostPort: DEVTOOLS_PORT_REVERSE.hostPort,
      name: DEVTOOLS_PORT_REVERSE.portReverseName,
    };

    await runProviderScenario(
      daemon,
      [
        {
          name: 'heartbeat',
          command: 'lease_heartbeat',
          expectData: { provider: { provider: FAKE_PROVIDER } },
        },
        {
          name: 'open',
          command: 'open',
          positionals: ['com.example.demo'],
          expectData: {
            platform: 'android',
            id: runtime.deviceIdForLease(lease.leaseId),
            serial: runtime.deviceIdForLease(lease.leaseId),
          },
        },
        {
          name: 'click',
          command: 'click',
          positionals: ['10', '20'],
        },
        {
          name: 'snapshot',
          command: 'snapshot',
        },
        {
          name: 'port-reverse',
          command: 'runtime',
          positionals: ['port-reverse'],
          flags: DEVTOOLS_PORT_REVERSE,
          expectData: {
            action: 'port-reverse',
            ...portReverse,
          },
        },
        {
          name: 'port-reverse-remove',
          command: 'runtime',
          positionals: ['port-reverse-remove'],
          flags: DEVTOOLS_PORT_REVERSE,
          expectData: {
            action: 'port-reverse-remove',
            ...portReverse,
          },
        },
        {
          name: 'release',
          command: 'lease_release',
          expectData: { released: true, provider: { provider: FAKE_PROVIDER } },
        },
      ],
      { flags, meta },
    );

    const session = daemon.session();
    const deviceId = runtime.deviceIdForLease(lease.leaseId);
    assert.equal(session?.device.id, deviceId);
    assert.equal(session?.lease?.leaseId, lease.leaseId);
    assert.deepEqual(
      runtime.calls.find((call) => call.type === 'open'),
      { type: 'open', deviceId, app: 'com.example.demo', url: undefined },
    );
    assert.deepEqual(
      runtime.calls.find((call) => call.type === 'tap'),
      { type: 'tap', deviceId, x: 10, y: 20 },
    );
    assert.deepEqual(
      runtime.calls.map((call) => call.type),
      [
        'lease.allocate',
        'lease.heartbeat',
        'inventory',
        'open',
        'tap',
        'snapshot',
        'portReverse.ensure',
        'portReverse.remove',
        'lease.release',
      ],
    );
  });
}, 15_000);

async function createFakeProviderWorld() {
  const runtime = new FakeProviderDeviceRuntime();
  setActiveProviderDeviceRuntimes([runtime]);
  const providerRuntimeProviders = createProviderDeviceRuntimeRequestProviders([runtime]);
  const daemon = await createProviderScenarioHarness({
    ...providerRuntimeProviders,
    deviceInventoryProvider: providerRuntimeProviders.deviceInventoryProvider!,
  });
  return {
    daemon,
    runtime,
    close: async () => {
      setActiveProviderDeviceRuntimes([]);
      await runtime.shutdown();
      await daemon.close();
    },
  };
}

class FakeProviderDeviceRuntime implements ProviderDeviceRuntime {
  readonly provider = FAKE_PROVIDER;
  readonly calls: FakeProviderCall[] = [];
  private readonly sessionsByLeaseId = new Map<string, FakeProviderSession>();

  readonly leaseLifecycle: LeaseLifecycleProvider = {
    allocate: async (lease) => {
      if (lease.leaseProvider !== this.provider) return undefined;
      const device = this.createDevice(lease);
      const interactor = createFakeProviderInteractor(device, this.calls);
      this.sessionsByLeaseId.set(lease.leaseId, { device, interactor });
      this.calls.push({
        type: 'lease.allocate',
        leaseId: lease.leaseId,
        provider: lease.leaseProvider,
        deviceId: device.id,
      });
      return { provider: this.provider, deviceId: device.id };
    },
    heartbeat: async (lease) => {
      if (lease.leaseProvider !== this.provider) return undefined;
      this.calls.push({
        type: 'lease.heartbeat',
        leaseId: lease.leaseId,
        provider: lease.leaseProvider,
      });
      return { provider: this.provider };
    },
    release: async (lease) => {
      if (lease.leaseProvider !== this.provider) return undefined;
      this.sessionsByLeaseId.delete(lease.leaseId);
      this.calls.push({
        type: 'lease.release',
        leaseId: lease.leaseId,
        provider: lease.leaseProvider,
      });
      return { provider: this.provider };
    },
  };

  readonly deviceInventoryProvider: DeviceInventoryProvider = async (request) => {
    if (request.leaseProvider !== this.provider) return null;
    const leaseId = request.leaseId;
    if (!leaseId) return [];
    const session = this.sessionsByLeaseId.get(leaseId);
    if (!session) return [];
    this.calls.push({
      type: 'inventory',
      leaseId,
      platform: request.platform,
    });
    return [session.device];
  };

  ownsDevice(device: DeviceInfo): boolean {
    return device.id.startsWith('fake-provider:android:');
  }

  getInteractor(device: DeviceInfo): Interactor | undefined {
    return [...this.sessionsByLeaseId.values()].find((session) => session.device.id === device.id)
      ?.interactor;
  }

  async configurePortReverse(
    options: ProviderPortReverseOptions,
  ): Promise<Record<string, unknown> | undefined> {
    if (options.provider !== this.provider) return undefined;
    this.calls.push({ type: 'portReverse.ensure', options });
    return { provider: this.provider, ...options };
  }

  async removePortReverse(
    options: ProviderPortReverseOptions,
  ): Promise<Record<string, unknown> | undefined> {
    if (options.provider !== this.provider) return undefined;
    this.calls.push({ type: 'portReverse.remove', options });
    return { provider: this.provider, ...options };
  }

  async shutdown(): Promise<void> {
    this.sessionsByLeaseId.clear();
  }

  deviceIdForLease(leaseId: string): string {
    return `fake-provider:android:${leaseId}`;
  }

  private createDevice(lease: DeviceLease): DeviceInfo {
    return {
      platform: 'android',
      id: this.deviceIdForLease(lease.leaseId),
      name: 'Fake Provider Android',
      kind: 'device',
      target: 'mobile',
      booted: true,
    };
  }
}

function createFakeProviderInteractor(device: DeviceInfo, calls: FakeProviderCall[]): Interactor {
  return new Proxy<Partial<Interactor>>(
    {
      open: async (app, options) => {
        calls.push({ type: 'open', deviceId: device.id, app, url: options?.url });
      },
      tap: async (x, y) => {
        calls.push({ type: 'tap', deviceId: device.id, x, y });
        return { backend: 'fake-provider', x, y };
      },
      snapshot: async (options): Promise<SnapshotResult> => {
        calls.push({
          type: 'snapshot',
          deviceId: device.id,
          interactiveOnly: options?.interactiveOnly,
        });
        return {
          backend: 'android',
          nodes: [
            {
              index: 0,
              type: 'TextView',
              label: 'Provider Ready',
              rect: { x: 0, y: 0, width: 120, height: 40 },
              enabled: true,
              visibleToUser: true,
            },
          ],
        };
      },
    },
    {
      get(target, property, receiver) {
        if (property in target) return Reflect.get(target, property, receiver);
        if (
          typeof property === 'string' &&
          ABSENT_FAKE_PROVIDER_INTERACTOR_PROPERTIES.has(property)
        ) {
          return undefined;
        }
        if (typeof property === 'string') {
          return () => throwUnexpectedProviderInteraction(property);
        }
        return undefined;
      },
    },
  ) as Interactor;
}

function leaseFlags(leaseId?: string): DaemonRequest['flags'] {
  return {
    platform: 'android',
    tenant: 'team-a',
    runId: 'run-a',
    leaseId,
    leaseProvider: FAKE_PROVIDER,
  };
}

function leaseMeta(leaseId?: string): DaemonRequest['meta'] {
  return {
    tenantId: 'team-a',
    runId: 'run-a',
    leaseId,
    leaseBackend: 'android-instance',
    leaseProvider: FAKE_PROVIDER,
    deviceKey: 'android-a',
    clientId: 'client-a',
  };
}

function throwUnexpectedProviderInteraction(method: string): never {
  throw new Error(`Unexpected fake provider interactor call: ${method}`);
}
