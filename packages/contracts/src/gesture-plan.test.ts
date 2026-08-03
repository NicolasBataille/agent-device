import assert from 'node:assert/strict';
import { test } from 'vitest';
import { buildHoldDragGesturePlan } from './gesture-plan.ts';

test('hold drag keeps one pointer down through source hold, movement, and destination hold', () => {
  const plan = buildHoldDragGesturePlan(
    {
      from: { x: 20, y: 30 },
      to: { x: 120, y: 230 },
      sourceHoldMs: 800,
      moveMs: 700,
      destinationHoldMs: 250,
    },
    { x: 0, y: 0, width: 400, height: 800 },
    'ios',
  );

  assert.equal(plan.topology, 'single');
  assert.equal(plan.durationMs, 1_750);
  assert.deepEqual(plan.pointers[0]?.samples[0], { offsetMs: 0, point: { x: 20, y: 30 } });
  assert.deepEqual(plan.pointers[0]?.samples[1], { offsetMs: 800, point: { x: 20, y: 30 } });
  assert.deepEqual(plan.pointers[0]?.samples.at(-2), {
    offsetMs: 1_500,
    point: { x: 120, y: 230 },
  });
  assert.deepEqual(plan.pointers[0]?.samples.at(-1), {
    offsetMs: 1_750,
    point: { x: 120, y: 230 },
  });
});

test('hold drag rejects a combined duration above the backend ceiling', () => {
  assert.throws(
    () =>
      buildHoldDragGesturePlan(
        {
          from: { x: 20, y: 30 },
          to: { x: 120, y: 230 },
          sourceHoldMs: 5_000,
          moveMs: 5_000,
          destinationHoldMs: 1,
        },
        { x: 0, y: 0, width: 400, height: 800 },
      ),
    { code: 'INVALID_ARGS', message: 'gesture drag total duration must be at most 10000' },
  );
});
