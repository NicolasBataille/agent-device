import { expect, test } from 'vitest';
import { makeSnapshotState } from '../../../__tests__/test-utils/index.ts';
import { createInteractionDevice } from '../../../commands/interaction/runtime/__tests__/test-utils/index.ts';
import { presentIosInteractiveSnapshot } from './index.ts';
import {
  closedComposerWithRetainedActionShelfNodes,
  navigationTitleWithAppProvidedDetailsAffordanceNodes,
  openComposerActionShelfNodes,
} from './transitions.fixtures.ts';

test('iOS presentation removes an action shelf whose child actions moved outside its viewport', () => {
  const nodes = presentIosInteractiveSnapshot(closedComposerWithRetainedActionShelfNodes);
  const labels = nodes.map((node) => node.label).filter(Boolean);

  expect(labels).toEqual([
    'Fixture app',
    'Upload',
    'Upload',
    'Record Voice Message',
    'Record Voice Message',
  ]);
  expect(nodes.some((node) => node.identifier === 'GrowingTextView')).toBe(true);
});

test('iOS presentation keeps an action shelf whose child actions are inside its viewport', () => {
  const nodes = presentIosInteractiveSnapshot(openComposerActionShelfNodes);
  const actionLabels = nodes
    .map((node) => node.label)
    .filter((label) => label?.startsWith('action '));

  expect(actionLabels).toEqual([
    'action media library',
    'action media library',
    'action sticker',
    'action file',
    'action poll',
    'action location',
    'action camera',
  ]);
});

test('iOS presentation promotes an app-provided navigation title affordance without stealing a content action', () => {
  const nodes = presentIosInteractiveSnapshot(navigationTitleWithAppProvidedDetailsAffordanceNodes);
  const titleActions = nodes.filter(
    (node) => node.type === 'Button' && node.label === 'Team Standup',
  );

  expect(titleActions).toHaveLength(2);
  expect(titleActions[0]).toEqual(
    expect.objectContaining({ identifier: 'DisplayNameTextField', enabled: true }),
  );
  expect(titleActions[0]?.rect).toEqual(expect.objectContaining({ x: 81, y: 58.33, height: 40 }));
  expect(titleActions[0]?.rect?.width).toBeCloseTo(223.67);
  expect(titleActions[1]?.rect).toEqual({ x: 20, y: 200.33, width: 362, height: 26.67 });
  expect(nodes.some((node) => node.type === 'StaticText' && node.label === 'Team Standup')).toBe(
    false,
  );
  expect(nodes.some((node) => node.identifier === 'RoomDetailsIconImageView')).toBe(false);
});

test('promoted navigation title dispatches as its presented button semantics, not its disabled source field', async () => {
  const snapshot = makeSnapshotState(
    presentIosInteractiveSnapshot(navigationTitleWithAppProvidedDetailsAffordanceNodes),
  );
  const title = snapshot.nodes.find((node) => node.identifier === 'DisplayNameTextField');
  expect(title).toEqual(expect.objectContaining({ type: 'Button', enabled: true }));

  let tappedPoint: { x: number; y: number } | undefined;
  const device = createInteractionDevice(snapshot, {
    tap: async (_context, point) => {
      tappedPoint = point;
    },
  });

  await device.interactions.click({ kind: 'ref', ref: `@${title!.ref}` }, { session: 'default' });

  expect(tappedPoint).toEqual({ x: 193, y: 78 });
});

test('iOS presentation leaves a disabled navigation title field alone without a named app affordance', () => {
  const withoutNamedAffordance = navigationTitleWithAppProvidedDetailsAffordanceNodes.map((node) =>
    node.identifier === 'RoomDetailsIconImageView' ? { ...node, identifier: undefined } : node,
  );

  const nodes = presentIosInteractiveSnapshot(withoutNamedAffordance);
  expect(
    nodes.some((node) => node.type === 'TextField' && node.identifier === 'DisplayNameTextField'),
  ).toBe(true);
  expect(
    nodes.some((node) => node.type === 'Button' && node.identifier === 'DisplayNameTextField'),
  ).toBe(false);
});
