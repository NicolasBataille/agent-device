import { expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  adapter: { terminateProcess: vi.fn() },
  cleanupRunnerLeasesForOwner: vi.fn(async () => undefined),
}));

vi.mock('./platforms/apple/core/runner-client.ts', () => ({
  cleanupRunnerLeasesForOwner: mocks.cleanupRunnerLeasesForOwner,
  runnerLeaseCleanupAdapter: mocks.adapter,
}));

import { daemonOwnerCleanup } from './platform-runtime-daemon-owner-cleanup.ts';

test('composes owner cleanup with the Apple runner lease adapter', async () => {
  const owner = { pid: 42, startTime: 'process-start' };

  await daemonOwnerCleanup.cleanup(owner);

  expect(mocks.cleanupRunnerLeasesForOwner).toHaveBeenCalledWith(owner, mocks.adapter);
});
