import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import { localRuntimeOwner, providerRuntimeOwner } from './platform-runtime.ts';
import {
  bootTargetHeadlessUse,
  bootTargetUse,
  resolveDeviceReadinessRuntimePlan,
  type PlatformRuntimeProviderModule,
} from './platform-runtime-operations.ts';

function compileTimeProviderModuleProof(): void {
  const invalid: PlatformRuntimeProviderModule = {
    // @ts-expect-error Provider modules cannot advertise a local-family owner.
    owner: localRuntimeOwner('apple'),
    loadRuntime: async () => {
      throw new Error('not loaded');
    },
  };
  void invalid;
}
void compileTimeProviderModuleProof;

test('provider module exposes inert exact-owner metadata without loading mechanics', () => {
  const loadRuntime = vi.fn(async () => {
    throw new Error('not loaded');
  });
  const module: PlatformRuntimeProviderModule = {
    owner: providerRuntimeOwner('limrun', 'tenant-a'),
    loadRuntime,
  };

  assert.deepEqual(module.owner, {
    kind: 'provider-runtime',
    provider: 'limrun',
    instance: 'tenant-a',
  });
  assert.equal(loadRuntime.mock.calls.length, 0);
});

test.each([
  [false, 'boot-target', 'bootTarget', bootTargetUse],
  [true, 'boot-target-headless', 'bootTargetHeadless', bootTargetHeadlessUse],
] as const)(
  'normalizes headless=%s into the literal readiness plan %s',
  (headless, kind, operation, use) => {
    assert.deepEqual(resolveDeviceReadinessRuntimePlan({ headless }), {
      kind,
      operation,
      use,
    });
  },
);
