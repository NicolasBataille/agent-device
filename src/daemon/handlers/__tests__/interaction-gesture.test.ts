import assert from 'node:assert/strict';
import { beforeEach, test, vi } from 'vitest';
import { SWIPE_PAUSE_MAX_MS, SWIPE_REPEAT_COUNT_MAX } from '../../../contracts/scroll-gesture.ts';
import type { GesturePlan } from '../../../contracts/gesture-plan.ts';
import { dispatchGesturePlan, dispatchGestureViewport } from '../../../core/dispatch.ts';
import { makeAndroidSession } from '../../../__tests__/test-utils/session-factories.ts';
import { makeSessionStore } from '../../../__tests__/test-utils/store-factory.ts';
import { ensureAndroidBlockingSystemDialogReady } from '../../android-system-dialog.ts';
import { dispatchSwipeViaRuntime } from '../interaction-gesture.ts';

vi.mock('../../../core/dispatch.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../core/dispatch.ts')>();
  return {
    ...actual,
    dispatchGesturePlan: vi.fn(),
    dispatchGestureViewport: vi.fn(),
  };
});

vi.mock('../../android-system-dialog.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../android-system-dialog.ts')>()),
  ensureAndroidBlockingSystemDialogReady: vi.fn(async () => ({ status: 'clear' as const })),
}));

const mockDispatchGesturePlan = vi.mocked(dispatchGesturePlan);
const mockDispatchGestureViewport = vi.mocked(dispatchGestureViewport);
const mockEnsureAndroidBlockingSystemDialogReady = vi.mocked(
  ensureAndroidBlockingSystemDialogReady,
);

beforeEach(() => {
  mockDispatchGesturePlan.mockReset();
  mockDispatchGesturePlan.mockResolvedValue({
    backend: 'android-multitouch-helper',
    helperVersion: 'test',
  });
  mockDispatchGestureViewport.mockReset();
  mockDispatchGestureViewport.mockResolvedValue({ x: 0, y: 0, width: 400, height: 800 });
  mockEnsureAndroidBlockingSystemDialogReady.mockClear();
});

test('repeated Android coordinate swipes use the helper plan without accessibility recapture', async () => {
  const sessionName = 'android-coordinate-swipe';
  const sessionStore = makeSessionStore();
  sessionStore.set(
    sessionName,
    makeAndroidSession(sessionName, { appBundleId: 'com.example.App' }),
  );
  const plans: GesturePlan[] = [];
  let snapshotCaptureCount = 0;
  const captureSnapshotForSession = async () => {
    snapshotCaptureCount += 1;
    throw new Error('repeated coordinate swipe must not capture accessibility state');
  };
  mockDispatchGesturePlan.mockImplementation(async (_device, plan) => {
    plans.push(plan);
    return {
      backend: 'android-multitouch-helper',
      helperVersion: 'test',
    };
  });

  const response = await dispatchSwipeViaRuntime({
    req: {
      token: 'test',
      session: sessionName,
      command: 'swipe',
      positionals: [],
      input: {
        from: { x: 300, y: 400 },
        to: { x: 100, y: 400 },
        count: 3,
        pauseMs: 0,
        pattern: 'ping-pong',
      },
      flags: {},
    },
    sessionName,
    sessionStore,
    contextFromFlags: () => ({}),
    captureSnapshotForSession,
  });

  assert.equal(response.ok, true);
  if (!response.ok) return;
  assert.equal(response.data?.count, 3);
  assert.equal(response.data?.pauseMs, 0);
  assert.equal(response.data?.pattern, 'ping-pong');
  assert.equal(response.data?.backend, 'android-multitouch-helper');
  assert.equal(snapshotCaptureCount, 0);
  assert.equal(mockDispatchGestureViewport.mock.calls.length, 3);
  assert.deepEqual(
    plans.map((plan) => gestureEndpoints(plan)),
    [
      { from: { x: 300, y: 400 }, to: { x: 100, y: 400 } },
      { from: { x: 100, y: 400 }, to: { x: 300, y: 400 } },
      { from: { x: 300, y: 400 }, to: { x: 100, y: 400 } },
    ],
  );
  assert.equal(mockDispatchGesturePlan.mock.calls.length, 3);
});

test.each([
  ['count', { count: SWIPE_REPEAT_COUNT_MAX + 1 }],
  ['pauseMs', { pauseMs: SWIPE_PAUSE_MAX_MS + 1 }],
] as const)('rejects swipe %s above its safety bound before planning', async (_field, override) => {
  const sessionName = `android-invalid-${_field}`;
  const sessionStore = makeSessionStore();
  sessionStore.set(sessionName, makeAndroidSession(sessionName));
  let snapshotCaptureCount = 0;

  const response = await dispatchSwipeViaRuntime({
    req: {
      token: 'test',
      session: sessionName,
      command: 'swipe',
      positionals: [],
      input: {
        from: { x: 300, y: 400 },
        to: { x: 100, y: 400 },
        ...override,
      },
      flags: {},
    },
    sessionName,
    sessionStore,
    contextFromFlags: () => ({}),
    captureSnapshotForSession: async () => {
      snapshotCaptureCount += 1;
      throw new Error('invalid swipe must not capture accessibility state');
    },
  });

  assert.equal(response.ok, false);
  if (response.ok) return;
  assert.equal(response.error.code, 'INVALID_ARGS');
  assert.equal(snapshotCaptureCount, 0);
  assert.equal(mockDispatchGesturePlan.mock.calls.length, 0);
});

function gestureEndpoints(plan: GesturePlan) {
  const samples = plan.pointers[0]?.samples;
  return {
    from: samples?.[0]?.point,
    to: samples?.at(-1)?.point,
  };
}
