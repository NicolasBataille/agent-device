import { test, expect } from 'vitest';
import path from 'node:path';
import { handleSessionInventoryCommands } from '../session-inventory.ts';
import { makeSessionStore } from '../../../__tests__/test-utils/store-factory.ts';
import type { DaemonRequest, DaemonResponse, SessionState } from '../../types.ts';
import { IOS_SIMULATOR } from '../../../__tests__/test-utils/device-fixtures.ts';

// A session opened without an explicit --session is NAMED `default` and STORED under
// `cwd:<hash>:default`. `session list` resolved its paths from the name, so it answered with
// `<state>/sessions/default` — a directory that does not exist — while the session's real
// artifacts (runner.log included) sat in `<state>/sessions/cwd_<hash>_default` (#2031/#1394).

const SCOPED_KEY = 'cwd:8bea844ab16aa9b3:default';

function scopedSession(): SessionState {
  return {
    name: 'default',
    sessionScope: { kind: 'cwd', id: '8bea844ab16aa9b3' },
    device: IOS_SIMULATOR,
    createdAt: Date.now(),
    actions: [],
  };
}

async function runSessionList(): Promise<DaemonResponse | null> {
  const sessionStore = makeSessionStore('agent-device-inventory-scoped-');
  sessionStore.set(SCOPED_KEY, scopedSession());
  const req: DaemonRequest = {
    token: 't',
    session: 'default',
    command: 'session_list',
    positionals: [],
    flags: {},
  };
  return await handleSessionInventoryCommands({
    req,
    sessionName: SCOPED_KEY,
    sessionStore,
  });
}

test('session list resolves a cwd-scoped session directory from its store key', async () => {
  const response = await runSessionList();

  expect(response?.ok).toBe(true);
  if (!response?.ok) return;
  const sessions = response.data?.sessions as {
    name: string;
    sessionStateDir: string;
    runnerLogPath: string;
  }[];
  expect(sessions).toHaveLength(1);
  const session = sessions[0]!;
  // The public name stays what the caller typed …
  expect(session.name).toBe('default');
  // … while the reported paths point at the directory that actually holds the session.
  expect(path.basename(session.sessionStateDir)).toBe('cwd_8bea844ab16aa9b3_default');
  expect(session.runnerLogPath.startsWith(`${session.sessionStateDir}${path.sep}`)).toBe(true);
});
