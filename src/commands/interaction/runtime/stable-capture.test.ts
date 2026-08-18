import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { SnapshotState } from '@agent-device/kernel/snapshot';
import type { AgentDeviceBackend } from '../../../backend.ts';
import { createLocalArtifactAdapter } from '../../../io.ts';
import {
  createAgentDevice,
  createMemorySessionStore,
  localCommandPolicy,
} from '../../../runtime.ts';
import { runStableCaptureLoop } from './stable-capture.ts';
import {
  elementSettingsSnapshot,
  elementSettledRoomSnapshot,
  elementThreadsNoticeSnapshot,
  elementTransientRoomSnapshot,
} from './stable-capture.fixtures.ts';

test('regular captures settle from visible semantics while offscreen rows churn', async () => {
  let elapsedMs = 0;
  const clock = {
    now: () => elapsedMs,
    sleep: async (ms: number) => {
      elapsedMs += ms;
    },
  };
  const snapshots = [
    elementSettingsSnapshot([1_138, 1_423, 2_144, 2_434]),
    elementSettingsSnapshot([1_187, 1_423, 1_858, 2_144, 2_261]),
  ];
  let captures = 0;
  const runtime = createAgentDevice({
    backend: {
      platform: 'ios',
      captureSnapshot: async () => ({ snapshot: snapshots[captures++ % snapshots.length]! }),
    } satisfies AgentDeviceBackend,
    artifacts: createLocalArtifactAdapter(),
    sessions: createMemorySessionStore(),
    policy: localCommandPolicy(),
    clock,
  });

  const outcome = await runStableCaptureLoop(
    runtime,
    { session: 'default' },
    { quietMs: 100, timeoutMs: 1_000 },
  );

  assert.equal(outcome.settled, true);
  assert.equal(outcome.captures, 2);
  assert.ok(outcome.waitedMs < 200, `settled after ${outcome.waitedMs}ms`);
});

test('settle confirms a broad screen replacement beyond a self-consistent transitional tree', async () => {
  const { runtime } = transitionRuntime();

  const outcome = await runStableCaptureLoop(
    runtime,
    { session: 'default' },
    { quietMs: 500, timeoutMs: 5_000, confirmBroadTransition: true },
  );

  assert.equal(outcome.settled, true);
  assert.equal(
    outcome.lastCapture?.snapshot.nodes.some((node) => node.label === 'action file'),
    false,
  );
  assert.ok(outcome.waitedMs >= 1_500, `settled transitional tree after ${outcome.waitedMs}ms`);
});

test('settle confirms a broad screen replacement when capture recovers to private AX', async () => {
  const { runtime } = transitionRuntime({ captureBackend: 'private-ax' });

  const outcome = await runStableCaptureLoop(
    runtime,
    { session: 'default' },
    { quietMs: 500, timeoutMs: 5_000, confirmBroadTransition: true },
  );

  assert.equal(outcome.settled, true);
  assert.equal(
    outcome.lastCapture?.snapshot.nodes.some((node) => node.label === 'action file'),
    false,
  );
  assert.ok(outcome.waitedMs >= 1_500, `settled transitional tree after ${outcome.waitedMs}ms`);
});

test('settle confirms a broad replacement that begins after the first post-action capture', async () => {
  const { runtime } = transitionRuntime({
    captureBackend: 'private-ax',
    firstCaptureKeepsBaseline: true,
    settledAtMs: 1_200,
  });

  const outcome = await runStableCaptureLoop(
    runtime,
    { session: 'default' },
    { quietMs: 500, timeoutMs: 5_000, confirmBroadTransition: true },
  );

  assert.equal(outcome.settled, true);
  assert.equal(
    outcome.lastCapture?.snapshot.nodes.some((node) => node.label === 'action file'),
    false,
  );
  assert.ok(outcome.waitedMs >= 1_500, `settled delayed transition after ${outcome.waitedMs}ms`);
});

test('settle honors an explicitly shorter quiet window across a broad replacement', async () => {
  const { runtime } = transitionRuntime();

  const outcome = await runStableCaptureLoop(
    runtime,
    { session: 'default' },
    { quietMs: 25, timeoutMs: 5_000, confirmBroadTransition: true },
  );

  assert.equal(outcome.settled, true);
  assert.ok(outcome.captures <= 3, `short quiet window spent ${outcome.captures} captures`);
  assert.ok(outcome.waitedMs < 800, `short quiet window settled after ${outcome.waitedMs}ms`);
});

function transitionRuntime(
  options: {
    captureBackend?: 'tree' | 'private-ax';
    firstCaptureKeepsBaseline?: boolean;
    settledAtMs?: number;
  } = {},
) {
  const captureBackend = options.captureBackend ?? 'tree';
  const settledAtMs = options.settledAtMs ?? 800;
  let elapsedMs = 0;
  let captures = 0;
  const clock = {
    now: () => elapsedMs,
    sleep: async (ms: number) => {
      elapsedMs += ms;
    },
  };
  const runtime = createAgentDevice({
    backend: {
      platform: 'ios',
      captureSnapshot: async () => {
        const keepsBaseline = options.firstCaptureKeepsBaseline === true && captures === 0;
        captures += 1;
        return {
          snapshot: keepsBaseline
            ? elementThreadsNoticeSnapshot
            : withCaptureBackend(
                elapsedMs < settledAtMs ? elementTransientRoomSnapshot : elementSettledRoomSnapshot,
                captureBackend,
              ),
        };
      },
    } satisfies AgentDeviceBackend,
    artifacts: createLocalArtifactAdapter(),
    sessions: createMemorySessionStore([
      { name: 'default', snapshot: elementThreadsNoticeSnapshot },
    ]),
    policy: localCommandPolicy(),
    clock,
  });
  return { runtime };
}

function withCaptureBackend(
  snapshot: SnapshotState,
  backend: 'tree' | 'private-ax',
): SnapshotState {
  return {
    ...snapshot,
    snapshotQuality:
      backend === 'tree'
        ? snapshot.snapshotQuality
        : ({ state: 'recovered', backend: 'private-ax' } as const),
  };
}
