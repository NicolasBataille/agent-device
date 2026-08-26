import type { ManagedWebBackend } from '@agent-device/contracts/managed-web-backend';

/** Root composition for the managed browser host tool used by the CLI web command. */
export function createManagedWebBackend(): ManagedWebBackend {
  return Object.freeze({
    setup: async (options) => {
      const { setupManagedAgentBrowser } = await import('./platforms/web/agent-browser-tool.ts');
      return await setupManagedAgentBrowser(options);
    },
    doctor: async (options) => {
      const { doctorManagedAgentBrowser } = await import('./platforms/web/agent-browser-tool.ts');
      return await doctorManagedAgentBrowser(options);
    },
  });
}
