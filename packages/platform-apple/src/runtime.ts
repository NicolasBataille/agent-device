import type {
  DeviceBinding,
  NetworkDumpInput,
  PlatformRuntimeHost,
  PlatformRuntimeOperations,
  PlatformRuntimeOwner,
} from '@agent-device/contracts/platform';
import { localRuntimeOwner } from '@agent-device/contracts/platform';
import { isMacOs, type DeviceInfo } from '@agent-device/kernel/device';
import { createAppleAppLogRuntime } from './logs/runtime.ts';
import { dumpAppleNetworkTraffic } from './network/runtime.ts';
import {
  appleScreenRecordingFacts,
  createAppleScreenRecordingOperations,
} from './recording/runtime.ts';
import { ensureAppleReady } from './readiness/runtime.ts';

const owner = localRuntimeOwner('apple');
const available = Object.freeze({ available: true } as const);
const unavailable = Object.freeze({
  available: false,
  reason: 'unsupported-platform-leaf',
} as const);
const headlessUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-provider-mode',
  hint: 'Headless boot is supported only for local Android emulators.',
} as const);

export function createApplePlatformRuntime(host: PlatformRuntimeHost): PlatformRuntimeOwner {
  const appLogs = createAppleAppLogRuntime(host);
  const inspectFacts = async (device: DeviceInfo) => {
    const logs = await appLogs.inspectFacts(device);
    const leafRecordingFacts = appleScreenRecordingFacts(device);
    const hostAvailability = leafRecordingFacts.available
      ? await host.screenRecording.apple.availability(device)
      : undefined;
    const recordingFacts =
      leafRecordingFacts.available && hostAvailability?.available === false
        ? Object.freeze({
            available: false,
            reason: 'unsupported-provider-mode' as const,
            hint: hostAvailability.hint,
          })
        : leafRecordingFacts;
    const readiness = device.appleOs === 'watchos' ? unavailable : available;
    const boot = isMacOs(device) || device.appleOs === 'watchos' ? unavailable : available;
    return Object.freeze({
      device: logs.device,
      operations: {
        ...logs.operations,
        networkDump: available,
        screenRecordingStart: recordingFacts,
        screenRecordingReattach: recordingFacts,
        screenRecordingCleanup: recordingFacts,
        ensureReady: readiness,
        bootTarget: boot,
        bootTargetHeadless: headlessUnavailable,
      },
    });
  };
  return Object.freeze({
    owner,
    ownsDevice: (device) => device.platform === 'apple',
    inspectFacts,
    bind: async (request) => {
      const logs = await appLogs.bind(request);
      const facts = await inspectFacts(request.device);
      const recordingFacts = facts.operations.screenRecordingStart;
      return Object.freeze({
        device: logs.device,
        owner,
        facts,
        operations: Object.freeze({
          ...logs.operations,
          networkDump: async (input: NetworkDumpInput) =>
            await dumpAppleNetworkTraffic(host, request.device, input, request.scope.signal),
          ...(recordingFacts.available
            ? createAppleScreenRecordingOperations({
                host,
                device: request.device,
                owner,
                signal: request.scope.signal,
              })
            : {}),
          ...(facts.operations.ensureReady.available
            ? {
                ensureReady: async () =>
                  await ensureAppleReady(host, request.device, request.scope.signal),
              }
            : {}),
          ...(facts.operations.bootTarget.available
            ? {
                bootTarget: async () =>
                  await ensureAppleReady(host, request.device, request.scope.signal),
              }
            : {}),
        }),
        [Symbol.asyncDispose]: async () => await logs[Symbol.asyncDispose](),
      }) satisfies DeviceBinding<PlatformRuntimeOperations>;
    },
    shutdown: async () => await appLogs.shutdown(),
  });
}
