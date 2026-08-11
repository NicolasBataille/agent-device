import { test, expect } from 'vitest';

import { handleSessionStateCommands } from '../session-state.ts';
import { makeSessionStore } from '../../../__tests__/test-utils/store-factory.ts';
import { withTestDeviceInventory } from '../../../__tests__/test-utils/device-inventory-gateways.ts';
import { createUnavailablePlatformRuntimeFacts } from '@agent-device/capture-kit';
import { localRuntimeOwner } from '@agent-device/contracts/platform';

test('boot rejects --headless outside Android directly', async () => {
  const device = {
    platform: 'apple' as const,
    appleOs: 'ios' as const,
    id: 'sim-1',
    name: 'iPhone',
    kind: 'simulator' as const,
    target: 'mobile' as const,
    booted: false,
  };
  const response = await withTestDeviceInventory(
    { local: async () => [device] },
    async () =>
      await handleSessionStateCommands({
        req: {
          token: 't',
          session: 'default',
          command: 'boot',
          positionals: [],
          flags: { platform: 'ios', headless: true },
        },
        sessionName: 'default',
        sessionStore: makeSessionStore('agent-device-session-state-'),
        inspectFacts: async () =>
          createUnavailablePlatformRuntimeFacts(device, localRuntimeOwner('apple'), {
            appLog: { available: false, reason: 'owner-capability-missing' },
            network: { available: false, reason: 'owner-capability-missing' },
            readiness: { available: false, reason: 'unsupported-device-kind' },
          }),
      }),
  );

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(false);
  if (response && !response.ok) {
    expect(response.error.code).toBe('INVALID_ARGS');
    expect(response.error.message).toMatch(/supported only for Android emulators/i);
  }
});

test('appstate returns missing-session error for explicit session flag', async () => {
  const response = await handleSessionStateCommands({
    req: {
      token: 't',
      session: 'named',
      command: 'appstate',
      positionals: [],
      flags: { platform: 'ios', session: 'named' },
    },
    sessionName: 'named',
    sessionStore: makeSessionStore('agent-device-session-state-'),
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(false);
  if (response && !response.ok) {
    expect(response.error.code).toBe('SESSION_NOT_FOUND');
    expect(response.error.message).toMatch(/Run open with --session named first/i);
  }
});

test('appstate rejects web before Android app-state backend dispatch', async () => {
  const response = await withTestDeviceInventory(
    {
      local: async () => [
        {
          platform: 'web',
          id: 'agent-browser-chrome',
          name: 'Agent Browser Chrome',
          kind: 'device',
          target: 'desktop',
          booted: true,
        },
      ],
    },
    async () =>
      await handleSessionStateCommands({
        req: {
          token: 't',
          session: 'default',
          command: 'appstate',
          positionals: [],
          flags: { platform: 'web' },
        },
        sessionName: 'default',
        sessionStore: makeSessionStore('agent-device-session-state-'),
      }),
  );

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(false);
  if (response && !response.ok) {
    expect(response.error.code).toBe('UNSUPPORTED_OPERATION');
    expect(response.error.message).toMatch(/appstate is not supported on web/i);
  }
});
