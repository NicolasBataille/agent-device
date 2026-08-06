import type { CommandFlags } from '@agent-device/contracts/command';
import type { SnapshotBackend } from '@agent-device/kernel/snapshot';
import { beforeEach, expect, test, vi } from 'vitest';
import { makeIosSession } from '../../__tests__/test-utils/session-factories.ts';
import { makeSessionStore } from '../../__tests__/test-utils/store-factory.ts';
import type { SessionStore } from '../session-store.ts';
import type { DaemonResponse, SessionState } from '../types.ts';
import { activateCompleteRefFrame } from '../ref-frame.ts';
import { isPostGestureStabilizationPending } from '../deferred-interaction-outcome.ts';
import { buildSnapshotState } from '../handlers/snapshot-capture.ts';
import { setSessionSnapshot } from '../session-snapshot.ts';

// #1638 `--settle` on the generic route (scroll/back): the settled diff is
// taken against the session's STORED pre-action tree, rides the response as
// `data.settle`, and is ref-issuing exactly like the touch route. Quiet windows
// are tuned down (settleQuietMs 25) so no test waits real time.

vi.mock('../../core/dispatch.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../core/dispatch.ts')>();
  return { ...actual, dispatchCommand: vi.fn(async () => ({})) };
});

vi.mock('../handlers/interaction-snapshot.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../handlers/interaction-snapshot.ts')>();
  return { ...actual, captureSnapshotForSession: vi.fn() };
});

import { dispatchCommand } from '../../core/dispatch.ts';
import { captureSnapshotForSession } from '../handlers/interaction-snapshot.ts';
import { dispatchGenericCommand } from '../request-generic-dispatch.ts';

const mockDispatch = vi.mocked(dispatchCommand);
const mockCapture = vi.mocked(captureSnapshotForSession);

const BEFORE_NODES = [
  { index: 0, type: 'Application', rect: { x: 0, y: 0, width: 390, height: 844 } },
  {
    index: 1,
    parentIndex: 0,
    type: 'Button',
    label: 'Load more',
    rect: { x: 10, y: 700, width: 120, height: 44 },
    hittable: true,
  },
];

const AFTER_NODES = [
  { index: 0, type: 'Application', rect: { x: 0, y: 0, width: 390, height: 844 } },
  {
    index: 1,
    parentIndex: 0,
    type: 'Button',
    label: 'Next page',
    rect: { x: 10, y: 700, width: 120, height: 44 },
    hittable: true,
  },
];

type SettlePayload = {
  settled: boolean;
  captures: number;
  quietMs: number;
  timeoutMs: number;
  refsGeneration?: number;
  diff?: {
    summary: { additions: number; removals: number; unchanged: number };
    lines: Array<{ kind: string; text: string; ref?: string }>;
  };
  hint?: string;
};

const contextFromFlags = () => ({}) as never;

/** Every settle capture observes the post-action tree. */
function captureNodes(nodes: typeof BEFORE_NODES, onCapture?: (session: SessionState) => void) {
  mockCapture.mockImplementation(async (session, flags, sessionStore) => {
    onCapture?.(session);
    const snapshot = buildSnapshotState(
      { nodes, backend: 'xctest' as SnapshotBackend },
      (flags ?? {}) as CommandFlags,
    );
    setSessionSnapshot(session, snapshot);
    sessionStore.set(session.name, session);
    return snapshot;
  });
}

function seedSession(sessionName: string, sessionStore: SessionStore): SessionState {
  const session = makeIosSession(sessionName);
  setSessionSnapshot(session, buildSnapshotState({ nodes: BEFORE_NODES, backend: 'xctest' }, {}));
  // The seed emulates a snapshot response that issued these refs (ADR 0014).
  activateCompleteRefFrame(session);
  sessionStore.set(sessionName, session);
  return session;
}

async function runGeneric(params: {
  sessionName: string;
  sessionStore: SessionStore;
  command: string;
  positionals?: string[];
  flags?: CommandFlags;
}): Promise<DaemonResponse> {
  const session = params.sessionStore.get(params.sessionName) as SessionState;
  return await dispatchGenericCommand({
    req: {
      token: 't',
      session: params.sessionName,
      command: params.command,
      positionals: params.positionals ?? [],
      ...(params.flags ? { flags: params.flags } : {}),
    },
    session,
    sessionName: params.sessionName,
    logPath: '',
    sessionStore: params.sessionStore,
    contextFromFlags,
  });
}

function expectOkData(response: DaemonResponse): Record<string, unknown> {
  expect(response.ok).toBe(true);
  if (!response.ok) throw new Error('expected an ok daemon response');
  return (response.data ?? {}) as Record<string, unknown>;
}

const SETTLE_FLAGS = { settle: true, settleQuietMs: 25, timeoutMs: 2_000 } satisfies CommandFlags;

beforeEach(() => {
  mockDispatch.mockReset();
  mockDispatch.mockResolvedValue({});
  mockCapture.mockReset();
});

test('scroll --settle diffs the settled tree against the stored pre-action snapshot', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'generic-settle-scroll';
  seedSession(sessionName, sessionStore);
  captureNodes(AFTER_NODES);

  const response = await runGeneric({
    sessionName,
    sessionStore,
    command: 'scroll',
    positionals: ['down'],
    flags: { ...SETTLE_FLAGS },
  });

  const data = expectOkData(response);
  const settle = data.settle as SettlePayload;
  expect(settle.settled).toBe(true);
  expect(settle.quietMs).toBe(25);
  expect(settle.timeoutMs).toBe(2_000);
  // Baseline is the STORED pre-action tree, not a fresh resolution capture.
  expect(settle.diff?.summary).toEqual({ additions: 1, removals: 1, unchanged: 1 });
  expect(settle.diff?.lines.find((line) => line.kind === 'added')).toEqual({
    kind: 'added',
    text: expect.stringContaining('Next page'),
    ref: 'e2',
  });
  // The device action itself still ran, once.
  expect(mockDispatch.mock.calls.filter(([, command]) => command === 'scroll')).toHaveLength(1);
});

test('scroll --settle is ref-issuing: partial frame plus the stored tree generation', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'generic-settle-refs';
  seedSession(sessionName, sessionStore);
  captureNodes(AFTER_NODES);

  const response = await runGeneric({
    sessionName,
    sessionStore,
    command: 'scroll',
    positionals: ['down'],
    flags: { ...SETTLE_FLAGS },
  });

  const settle = expectOkData(response).settle as SettlePayload;
  const session = sessionStore.get(sessionName) as SessionState;
  expect(session.refFrameState).toBe('active');
  expect(settle.refsGeneration).toBe(session.snapshotGeneration);
  expect(session.snapshot?.nodes.some((node) => node.label === 'Next page')).toBe(true);
});

test('back --settle carries the settled observation on the navigation payload', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'generic-settle-back';
  seedSession(sessionName, sessionStore);
  mockDispatch.mockImplementation(async (_device, command) =>
    command === 'back' ? { action: 'back', mode: 'in-app', message: 'Back' } : {},
  );
  captureNodes(AFTER_NODES);

  const data = expectOkData(
    await runGeneric({
      sessionName,
      sessionStore,
      command: 'back',
      flags: { ...SETTLE_FLAGS, backMode: 'in-app' },
    }),
  );

  // The command's own payload survives alongside the additive observation.
  expect(data.action).toBe('back');
  expect(data.message).toBe('Back');
  expect((data.settle as SettlePayload).settled).toBe(true);
});

test('the settle capture runs after the post-gesture stabilization marker is placed', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'generic-settle-order';
  seedSession(sessionName, sessionStore);
  // #1542 ordering: settle's FIRST capture must be the one that folds the
  // pending stabilization, so the marker has to exist by the time it runs.
  const pendingAtCapture: boolean[] = [];
  captureNodes(AFTER_NODES, (session) => {
    pendingAtCapture.push(isPostGestureStabilizationPending(session));
  });

  await runGeneric({
    sessionName,
    sessionStore,
    command: 'scroll',
    positionals: ['down'],
    flags: { ...SETTLE_FLAGS },
  });

  expect(pendingAtCapture[0]).toBe(true);
});

test('scroll without --settle observes nothing', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'generic-no-settle';
  seedSession(sessionName, sessionStore);
  captureNodes(AFTER_NODES);

  const data = expectOkData(
    await runGeneric({ sessionName, sessionStore, command: 'scroll', positionals: ['down'] }),
  );

  expect(data.settle).toBeUndefined();
  expect(mockCapture).not.toHaveBeenCalled();
});

test('a generic command without the observation trait ignores a stray settle flag', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'generic-settle-untraited';
  seedSession(sessionName, sessionStore);
  captureNodes(AFTER_NODES);

  // `home` is a generic leaf with no post-action observation trait. The CLI
  // schema already refuses --settle for it; the daemon must not observe either.
  const data = expectOkData(
    await runGeneric({ sessionName, sessionStore, command: 'home', flags: { ...SETTLE_FLAGS } }),
  );

  expect(data.settle).toBeUndefined();
  expect(mockCapture).not.toHaveBeenCalled();
});

test('scroll --settle-quiet without --settle is rejected before the device action', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'generic-settle-orphan';
  seedSession(sessionName, sessionStore);

  const response = await runGeneric({
    sessionName,
    sessionStore,
    command: 'scroll',
    positionals: ['down'],
    flags: { settleQuietMs: 25 },
  });

  expect(response.ok).toBe(false);
  if (response.ok) throw new Error('expected a rejected daemon response');
  expect(response.error.code).toBe('INVALID_ARGS');
  expect(response.error.message).toMatch(/--settle-quiet requires --settle/);
  expect(mockDispatch).not.toHaveBeenCalled();
});

test('a failed settle observation never fails the action', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'generic-settle-broken';
  seedSession(sessionName, sessionStore);
  mockCapture.mockRejectedValue(new Error('AX bridge crashed'));

  const data = expectOkData(
    await runGeneric({
      sessionName,
      sessionStore,
      command: 'scroll',
      positionals: ['down'],
      flags: { ...SETTLE_FLAGS },
    }),
  );

  const settle = data.settle as SettlePayload;
  expect(settle.settled).toBe(false);
  expect(settle.diff).toBeUndefined();
  expect(settle.hint).toMatch(/Settle observation unavailable/);
  // The scroll itself was dispatched and reported success.
  expect(mockDispatch.mock.calls.filter(([, command]) => command === 'scroll')).toHaveLength(1);
  // Nothing was published, so the scroll's own leaf seam still owns the frame.
  expect(sessionStore.get(sessionName)?.refFrameState).toBe('expired');
});
