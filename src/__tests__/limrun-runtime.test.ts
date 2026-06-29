import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test, vi } from 'vitest';
import { LimrunRuntime, readLocalhostUrlPort } from '../cloud/limrun-runtime.ts';
import type { SimulatorLease } from '../daemon/lease-registry.ts';
import { runCmd } from '../utils/exec.ts';
import type { DeviceInfo } from '../utils/device.ts';

const limrunMockState = vi.hoisted(() => {
  const androidTunnelClose = vi.fn();
  return {
    constructorOptions: [] as Array<{ defaultHeaders?: Record<string, string> }>,
    assetsGetOrUpload: vi.fn(async () => ({
      signedDownloadUrl: 'https://assets.example/app',
      md5: 'asset-md5',
    })),
    iosInstallApp: vi.fn(async () => ({
      bundleId: 'com.example.ios',
      url: 'https://assets.example/app',
    })),
    androidOpenUrl: vi.fn(async () => undefined),
    androidDisconnect: vi.fn(),
    androidSendAsset: vi.fn(async () => undefined),
    androidTunnelClose,
    androidStartAdbTunnel: vi.fn(async () => ({
      address: { address: '127.0.0.1', port: 62_001 },
      close: androidTunnelClose,
    })),
    iosCreate: vi.fn(async () => ({
      metadata: { id: 'ios-instance-1' },
      status: { token: 'instance-token', apiUrl: 'https://ios.example' },
    })),
    iosDelete: vi.fn(async () => undefined),
    androidCreate: vi.fn(async () => ({
      metadata: { id: 'android-instance-1' },
      status: {
        token: 'instance-token',
        apiUrl: 'https://android.example',
        adbWebSocketUrl: 'wss://adb.example',
      },
    })),
    androidDelete: vi.fn(async () => undefined),
  };
});

vi.mock('@limrun/api', () => ({
  default: class MockLimrun {
    readonly iosInstances = {
      create: limrunMockState.iosCreate,
      delete: limrunMockState.iosDelete,
    };

    readonly androidInstances = {
      create: limrunMockState.androidCreate,
      delete: limrunMockState.androidDelete,
    };

    readonly assets = {
      getOrUpload: limrunMockState.assetsGetOrUpload,
    };

    constructor(options: { defaultHeaders?: Record<string, string> }) {
      limrunMockState.constructorOptions.push(options);
    }
  },
}));

vi.mock('@limrun/api/ios-client', () => ({
  createInstanceClient: vi.fn(async () => ({
    disconnect: vi.fn(),
    installApp: limrunMockState.iosInstallApp,
  })),
}));

vi.mock('@limrun/api/instance-client', () => ({
  createInstanceClient: vi.fn(async () => ({
    disconnect: limrunMockState.androidDisconnect,
    openUrl: limrunMockState.androidOpenUrl,
    sendAsset: limrunMockState.androidSendAsset,
    startAdbTunnel: limrunMockState.androidStartAdbTunnel,
  })),
}));

vi.mock('../utils/exec.ts', () => ({
  runCmd: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })),
}));

afterEach(() => {
  limrunMockState.constructorOptions.length = 0;
  vi.clearAllMocks();
});

type AllocateLease = NonNullable<LimrunRuntime['leaseLifecycle']['allocate']>;
type ReleaseLease = NonNullable<LimrunRuntime['leaseLifecycle']['release']>;

function createLimrunTestRuntime(): LimrunRuntime {
  return new LimrunRuntime({
    apiKey: 'lim_test_key',
    version: '9.9.9-test',
  });
}

function makeLease(
  backend: SimulatorLease['backend'],
  leaseId = backend === 'ios-instance' ? 'lease-ios' : 'lease-android',
): SimulatorLease {
  return {
    leaseId,
    tenantId: 'team-a',
    runId: 'run-a',
    backend,
    leaseProvider: 'limrun',
    createdAt: 1,
    heartbeatAt: 1,
    expiresAt: 60_001,
  };
}

function requireAllocateLease(runtime: LimrunRuntime): AllocateLease {
  const allocateLease = runtime.leaseLifecycle.allocate;
  if (!allocateLease) throw new Error('Limrun runtime must provide lease allocation');
  return allocateLease;
}

function requireReleaseLease(runtime: LimrunRuntime): ReleaseLease {
  const releaseLease = runtime.leaseLifecycle.release;
  if (!releaseLease) throw new Error('Limrun runtime must provide lease release');
  return releaseLease;
}

async function allocateDevice(runtime: LimrunRuntime, lease: SimulatorLease): Promise<DeviceInfo> {
  const allocated = await requireAllocateLease(runtime)(lease);
  const device = allocated?.device;
  if (!device || typeof device !== 'object') {
    throw new Error('Limrun runtime must return allocated device metadata');
  }
  return device as DeviceInfo;
}

test('Limrun runtime identifies direct CLI usage to the Limrun API', async () => {
  const runtime = createLimrunTestRuntime();
  const lease = makeLease('ios-instance', 'lease-a');

  try {
    await requireAllocateLease(runtime)(lease);

    assert.deepEqual(limrunMockState.constructorOptions[0]?.defaultHeaders, {
      'x-agent-device-client': 'agent-device-cli',
      'x-agent-device-version': '9.9.9-test',
    });
    const iosCreateCalls = limrunMockState.iosCreate.mock.calls as unknown as Array<
      [{ metadata?: { labels?: Record<string, string> } }]
    >;
    assert.deepEqual(iosCreateCalls[0]?.[0].metadata?.labels, {
      tenantId: 'team-a',
      runId: 'run-a',
      leaseId: 'lease-a',
      provider: 'limrun',
      source: 'agent-device-cli',
    });
  } finally {
    await runtime.shutdown();
  }
});

test('Limrun Android reverses localhost URL ports through the persistent ADB tunnel', async () => {
  const runtime = createLimrunTestRuntime();
  const lease = makeLease('android-instance');

  try {
    const device = await allocateDevice(runtime, lease);
    const interactor = runtime.getInteractor(device);
    if (!interactor) throw new Error('Limrun runtime must return an interactor');

    await interactor.open('exp://127.0.0.1:8081');
    await runtime.shutdown();

    assert.equal(limrunMockState.androidStartAdbTunnel.mock.calls.length, 1);
    const androidOpenUrlCalls = limrunMockState.androidOpenUrl.mock.calls as unknown as Array<
      [string]
    >;
    assert.equal(androidOpenUrlCalls[0]?.[0], 'exp://127.0.0.1:8081');
    assert.deepEqual(vi.mocked(runCmd).mock.calls[0]?.[1], [
      '-s',
      '127.0.0.1:62001',
      'reverse',
      'tcp:8081',
      'tcp:8081',
    ]);
    assert.deepEqual(vi.mocked(runCmd).mock.calls[1]?.[1], [
      '-s',
      '127.0.0.1:62001',
      'reverse',
      '--remove-all',
    ]);
    assert.deepEqual(vi.mocked(runCmd).mock.calls[2]?.[1], ['disconnect', '127.0.0.1:62001']);
    assert.equal(limrunMockState.androidTunnelClose.mock.calls.length, 1);
  } finally {
    await runtime.shutdown();
  }
});

test('Limrun Android ADB command failures include the selected tunnel serial in diagnostics', async () => {
  const runtime = createLimrunTestRuntime();
  const lease = makeLease('android-instance');

  try {
    const device = await allocateDevice(runtime, lease);
    const interactor = runtime.getInteractor(device);
    if (!interactor) throw new Error('Limrun runtime must return an interactor');
    vi.mocked(runCmd).mockResolvedValueOnce({
      stdout: '',
      stderr: 'launch failed',
      exitCode: 1,
    });

    await assert.rejects(
      () => interactor.open('com.example.android'),
      (error) => {
        const details = (error as { details?: Record<string, unknown> }).details;
        assert.equal(
          details?.command,
          'adb -s 127.0.0.1:62001 shell monkey -p com.example.android -c android.intent.category.LAUNCHER 1',
        );
        return true;
      },
    );
  } finally {
    await runtime.shutdown();
  }
});

test('Limrun Android installs direct local artifacts through Limrun assets', async () => {
  const runtime = createLimrunTestRuntime();
  const lease = makeLease('android-instance');

  try {
    const device = await allocateDevice(runtime, lease);
    assert.deepEqual(device.capabilities?.supportedCommands?.slice(0, 3), [
      'install',
      'install-from-source',
      'reinstall',
    ]);

    const result = await runtime.installApp(device, 'com.example.android', '/tmp/app-debug.apk');

    const assetCalls = limrunMockState.assetsGetOrUpload.mock.calls as unknown as Array<
      [Record<string, unknown>]
    >;
    assert.deepEqual(assetCalls[0]?.[0], {
      path: '/tmp/app-debug.apk',
      name: 'com.example.android.apk',
    });
    assert.deepEqual(limrunMockState.androidSendAsset.mock.calls[0], [
      'https://assets.example/app',
    ]);
    assert.deepEqual(result, {
      packageName: 'com.example.android',
      launchTarget: 'com.example.android',
      appName: 'android',
    });
  } finally {
    await runtime.shutdown();
  }
});

test('Limrun iOS installs direct local artifacts through Limrun assets', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-limrun-install-'));
  const ipaPath = path.join(tempRoot, 'Demo.ipa');
  fs.writeFileSync(ipaPath, 'demo');
  const runtime = createLimrunTestRuntime();
  const lease = makeLease('ios-instance');

  try {
    const device = await allocateDevice(runtime, lease);

    const result = await runtime.installApp(device, 'com.example.ios', ipaPath, { relaunch: true });

    const assetCalls = limrunMockState.assetsGetOrUpload.mock.calls as unknown as Array<
      [Record<string, unknown>]
    >;
    assert.deepEqual(assetCalls[0]?.[0], {
      path: ipaPath,
      name: 'Demo.ipa',
    });
    assert.deepEqual(limrunMockState.iosInstallApp.mock.calls[0], [
      'https://assets.example/app',
      { md5: 'asset-md5', launchMode: 'RelaunchIfRunning' },
    ]);
    assert.deepEqual(result, {
      bundleId: 'com.example.ios',
      launchTarget: 'com.example.ios',
      appName: 'Demo',
    });
  } finally {
    await runtime.shutdown();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('Limrun Android configures and removes an explicit port reverse', async () => {
  const runtime = createLimrunTestRuntime();
  const lease = makeLease('android-instance');

  try {
    await requireAllocateLease(runtime)(lease);

    assert.deepEqual(
      await runtime.configurePortReverse({
        leaseId: lease.leaseId,
        devicePort: 8097,
        hostPort: 8097,
        name: 'react-devtools',
      }),
      {
        leaseId: lease.leaseId,
        devicePort: 8097,
        hostPort: 8097,
        name: 'react-devtools',
      },
    );
    await runtime.removePortReverse({
      leaseId: lease.leaseId,
      devicePort: 8097,
      hostPort: 8097,
      name: 'react-devtools',
    });

    assert.deepEqual(vi.mocked(runCmd).mock.calls[0]?.[1], [
      '-s',
      '127.0.0.1:62001',
      'reverse',
      'tcp:8097',
      'tcp:8097',
    ]);
    assert.deepEqual(vi.mocked(runCmd).mock.calls[1]?.[1], [
      '-s',
      '127.0.0.1:62001',
      'reverse',
      '--remove',
      'tcp:8097',
    ]);
  } finally {
    await runtime.shutdown();
  }
});

test('Limrun deletes iOS instance when post-create validation fails', async () => {
  limrunMockState.iosCreate.mockResolvedValueOnce({
    metadata: { id: 'ios-instance-missing-api' },
    status: { token: 'instance-token' },
  } as never);
  const runtime = createLimrunTestRuntime();
  const lease = makeLease('ios-instance');

  try {
    await assert.rejects(() => requireAllocateLease(runtime)(lease), /did not expose apiUrl/);
    assert.deepEqual(limrunMockState.iosDelete.mock.calls[0], ['ios-instance-missing-api']);
  } finally {
    await runtime.shutdown();
  }
});

test('Limrun deletes Android instance when post-create validation fails', async () => {
  limrunMockState.androidCreate.mockResolvedValueOnce({
    metadata: { id: 'android-instance-missing-adb' },
    status: {
      token: 'instance-token',
      apiUrl: 'https://android.example',
    },
  } as never);
  const runtime = createLimrunTestRuntime();
  const lease = makeLease('android-instance');

  try {
    await assert.rejects(() => requireAllocateLease(runtime)(lease), /did not expose API and ADB/);
    assert.deepEqual(limrunMockState.androidDelete.mock.calls[0], ['android-instance-missing-adb']);
  } finally {
    await runtime.shutdown();
  }
});

test('Limrun keeps session tracked when release fails so release can be retried', async () => {
  const runtime = createLimrunTestRuntime();
  const lease = makeLease('android-instance');

  try {
    const releaseLease = requireReleaseLease(runtime);
    await requireAllocateLease(runtime)(lease);
    limrunMockState.androidDelete.mockRejectedValueOnce(new Error('temporary delete failure'));

    await assert.rejects(() => releaseLease(lease), /temporary delete failure/);
    assert.deepEqual(await releaseLease(lease), { limrunInstanceId: 'android-instance-1' });
  } finally {
    await runtime.shutdown();
  }
});

test('readLocalhostUrlPort recognizes loopback URLs only', () => {
  assert.equal(readLocalhostUrlPort('exp://127.0.0.1:8081'), 8081);
  assert.equal(readLocalhostUrlPort('http://localhost:19000/status'), 19000);
  assert.equal(readLocalhostUrlPort('http://[::1]:8097'), 8097);
  assert.equal(readLocalhostUrlPort('https://metro.agent-device.dev/status'), undefined);
  assert.equal(readLocalhostUrlPort('not a url'), undefined);
});
