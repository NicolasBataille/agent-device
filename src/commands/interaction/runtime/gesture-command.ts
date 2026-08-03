import type { AgentDeviceRuntime, CommandContext } from '../../../runtime-contract.ts';
import type {
  DragGestureTargetInput,
  GestureIntent,
  GestureSemanticInput,
  PublicGestureSemanticInput,
} from '@agent-device/contracts/interaction';
import { buildGesturePlan, buildHoldDragGesturePlan } from '@agent-device/contracts/interaction';
import type { Point, Rect } from '@agent-device/kernel/snapshot';
import { AppError } from '@agent-device/kernel/errors';
import { successText } from '../../../utils/success-text.ts';
import { toBackendContext } from '../../runtime-common.ts';
import {
  toBackendResult,
  type BackendResultEnvelope,
  type RuntimeCommand,
} from '../../runtime-types.ts';
import {
  assertSupportedInteractionSurface,
  captureInteractionSnapshot,
  resolveInteractionTarget,
} from './resolution.ts';
import { resolveVisibleSnapshotViewport } from './viewport.ts';

export type GestureCommandOptions = CommandContext & {
  gesture: PublicGestureSemanticInput;
};

export type GestureCommandResult = {
  kind: GestureIntent | 'drag';
  durationMs: number;
  pointerCount: 1 | 2;
  from: Point;
  to: Point;
} & BackendResultEnvelope;

export const gestureCommand: RuntimeCommand<GestureCommandOptions, GestureCommandResult> = async (
  runtime,
  options,
) => {
  if (!runtime.backend.performGesture) {
    throw new AppError('UNSUPPORTED_OPERATION', 'gesture is not supported by this backend');
  }
  const supportedIntent = options.gesture.intent === 'drag' ? 'pan' : options.gesture.intent;
  await assertSupportedInteractionSurface(runtime, options, supportedIntent);
  const viewport = await captureGestureViewport(runtime, options);
  const plan =
    options.gesture.intent === 'drag'
      ? await buildResolvedHoldDragPlan(runtime, options, options.gesture, viewport)
      : buildGesturePlan(options.gesture, viewport, runtime.backend.platform);
  const backendResult = await runtime.backend.performGesture(
    toBackendContext(runtime, options),
    plan,
  );
  const formattedBackendResult = toBackendResult(backendResult);
  const from = centroidAt(plan.pointers, 0);
  const to = centroidAt(plan.pointers, -1);
  return {
    kind: options.gesture.intent,
    durationMs: plan.durationMs,
    pointerCount: plan.topology === 'single' ? 1 : 2,
    from,
    to,
    ...(formattedBackendResult ? { backendResult: formattedBackendResult } : {}),
    ...successText(
      options.gesture.intent === 'drag'
        ? dragGestureMessage(options.gesture)
        : gestureMessage(options.gesture, from, to),
    ),
  };
};

async function buildResolvedHoldDragPlan(
  runtime: AgentDeviceRuntime,
  options: GestureCommandOptions,
  gesture: DragGestureTargetInput,
  viewport: Rect,
) {
  const source = await resolveDragTarget(runtime, options, gesture.source, 'source');
  const destination = await resolveDragTarget(runtime, options, gesture.destination, 'destination');
  return buildHoldDragGesturePlan(
    {
      from: source,
      to: destination,
      sourceHoldMs: gesture.sourceHoldMs,
      moveMs: gesture.moveMs,
      destinationHoldMs: gesture.destinationHoldMs,
    },
    viewport,
    runtime.backend.platform,
  );
}

async function resolveDragTarget(
  runtime: AgentDeviceRuntime,
  options: GestureCommandOptions,
  target: string,
  role: 'source' | 'destination',
): Promise<Point> {
  const resolved = await resolveInteractionTarget(
    runtime,
    {
      ...options,
      target: target.startsWith('@')
        ? { kind: 'ref', ref: target }
        : { kind: 'selector', selector: target },
    },
    {
      action: 'pan',
      requireInteractive: false,
      promoteToHittableAncestor: false,
    },
  );
  if (!resolved.point) {
    throw new AppError('COMMAND_FAILED', `gesture drag ${role} resolved without coordinates`);
  }
  return resolved.point;
}

async function captureGestureViewport(
  runtime: AgentDeviceRuntime,
  options: GestureCommandOptions,
): Promise<Rect> {
  const backendViewport = await runtime.backend.resolveGestureViewport?.(
    toBackendContext(runtime, options),
  );
  if (backendViewport) return backendViewport;
  const capture = await captureInteractionSnapshot(runtime, options, false);
  return resolveVisibleSnapshotViewport(capture.snapshot.nodes, 'gesture');
}

function centroidAt(
  pointers: readonly { samples: readonly { point: Point }[] }[],
  index: 0 | -1,
): Point {
  const points = pointers.map((pointer) =>
    index === 0 ? pointer.samples[0]?.point : pointer.samples.at(-1)?.point,
  );
  if (points.some((point) => point === undefined)) {
    throw new AppError('COMMAND_FAILED', 'Gesture plan did not contain endpoint samples.');
  }
  const defined = points as Point[];
  return {
    x: defined.reduce((sum, point) => sum + point.x, 0) / defined.length,
    y: defined.reduce((sum, point) => sum + point.y, 0) / defined.length,
  };
}

function dragGestureMessage(input: DragGestureTargetInput): string {
  return `Dragged ${input.source} to ${input.destination}`;
}

function gestureMessage(input: GestureSemanticInput, from: Point, to: Point): string {
  switch (input.intent) {
    case 'pan': {
      const origin = 'preset' in input ? from : input.origin;
      const delta = 'preset' in input ? { x: to.x - from.x, y: to.y - from.y } : input.delta;
      return `Panned (${origin.x}, ${origin.y}) by (${delta.x}, ${delta.y})`;
    }
    case 'fling':
      return 'direction' in input ? `Flung ${input.direction}` : 'Flung';
    case 'pinch':
      return `Pinched to scale ${input.scale}`;
    case 'rotate':
      return `Rotated gesture ${input.degrees} degrees`;
    case 'transform':
      return `Requested transform gesture by (${input.delta.x}, ${input.delta.y}), scale ${input.scale}, rotate ${input.degrees} degrees`;
  }
}
