import type { ManagedWebBackend } from '@agent-device/contracts/host-platform-services';

/** Root composition for the managed browser host tool used by both CLI and web runtime paths. */
export const managedWebBackend: ManagedWebBackend = Object.freeze({
  setup: async (options) => {
    const { setupManagedAgentBrowser } = await import('./platforms/web/agent-browser-tool.ts');
    return await setupManagedAgentBrowser(options);
  },
  doctor: async (options) => {
    const { doctorManagedAgentBrowser } = await import('./platforms/web/agent-browser-tool.ts');
    return await doctorManagedAgentBrowser(options);
  },
});
