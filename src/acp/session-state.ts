import { randomUUID } from 'node:crypto';
import type { CliFlags } from '../cli/parser/cli-flags.ts';

/**
 * Flags that persist across prompt lines within one ACP session so a target
 * selected once (`open app --platform ios`) applies to later lines
 * (`snapshot -i`). Explicitly provided flags always win over sticky values.
 */
export const STICKY_FLAG_KEYS = ['platform', 'device', 'udid', 'session', 'stateDir'] as const;
export type StickyFlagKey = (typeof STICKY_FLAG_KEYS)[number];
export type StickyFlags = Partial<Pick<CliFlags, StickyFlagKey>>;

export type AcpSessionState = {
  id: string;
  cwd: string;
  sticky: StickyFlags;
  cancelled: boolean;
  promptActive: boolean;
  toolCallCounter: number;
};

export type AcpSessionStore = {
  create: (cwd: string) => AcpSessionState;
  get: (id: string) => AcpSessionState | undefined;
};

export function createAcpSessionStore(): AcpSessionStore {
  const sessions = new Map<string, AcpSessionState>();
  return {
    create: (cwd) => {
      const session: AcpSessionState = {
        id: randomUUID(),
        cwd,
        sticky: {},
        cancelled: false,
        promptActive: false,
        toolCallCounter: 0,
      };
      sessions.set(session.id, session);
      return session;
    },
    get: (id) => sessions.get(id),
  };
}

export function nextToolCallId(session: AcpSessionState): string {
  session.toolCallCounter += 1;
  return `call-${session.toolCallCounter}`;
}
