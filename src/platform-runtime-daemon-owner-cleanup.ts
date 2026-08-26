import type { DaemonOwnerCleanup } from '@agent-device/contracts/host-platform-services';

/**
 * Root composition for owner-scoped host cleanup. The CLI names only the neutral service; Apple
 * runner lease discovery and process disposal stay behind the platform composition boundary.
 */
export const daemonOwnerCleanup: DaemonOwnerCleanup = Object.freeze({
  cleanup: async (owner) => {
    const { cleanupRunnerLeasesForOwner, runnerLeaseCleanupAdapter } =
      await import('./platforms/apple/core/runner-client.ts');
    await cleanupRunnerLeasesForOwner(owner, runnerLeaseCleanupAdapter);
  },
});
