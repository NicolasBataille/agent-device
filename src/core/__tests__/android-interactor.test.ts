import assert from 'node:assert/strict';
import { beforeEach, test, vi } from 'vitest';
import { ANDROID_EMULATOR } from '../../__tests__/test-utils/index.ts';

const { mockGetAndroidGestureViewport } = vi.hoisted(() => ({
  mockGetAndroidGestureViewport: vi.fn(),
}));

vi.mock('../../platforms/android/display-geometry.ts', () => ({
  getAndroidGestureViewport: mockGetAndroidGestureViewport,
}));

import { createAndroidInteractor } from '../interactors/android.ts';

beforeEach(() => {
  mockGetAndroidGestureViewport.mockReset();
  mockGetAndroidGestureViewport.mockResolvedValue({
    x: 0,
    y: 0,
    width: 1080,
    height: 1920,
  });
});

test('Android gesture viewport uses current display geometry and keeps the gesture executor', async () => {
  const interactor = createAndroidInteractor(ANDROID_EMULATOR);

  assert.equal(typeof interactor.performGesture, 'function');
  assert.deepEqual(await interactor.gestureViewport?.(), {
    x: 0,
    y: 0,
    width: 1080,
    height: 1920,
  });
  assert.deepEqual(mockGetAndroidGestureViewport.mock.calls, [[ANDROID_EMULATOR]]);
});
