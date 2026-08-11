import {
  deviceReadinessRuntimeUses,
  ensureReadyHeadlessUse,
  ensureReadyUse,
} from '@agent-device/contracts/platform';
import { expect, test } from 'vitest';
import { commandDescriptors } from '../registry.ts';

test('boot descriptor declares both readiness uses instead of a capability bucket', () => {
  const boot = commandDescriptors.find(({ name }) => name === 'boot');

  expect(boot).not.toHaveProperty('capability');
  expect(boot?.platformExecution).toEqual({
    kind: 'device-runtime',
    uses: deviceReadinessRuntimeUses,
  });
  expect(new Set(deviceReadinessRuntimeUses)).toEqual(
    new Set([ensureReadyUse, ensureReadyHeadlessUse]),
  );
});
