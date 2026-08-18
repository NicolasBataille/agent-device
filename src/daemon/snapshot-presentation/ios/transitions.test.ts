import { expect, test } from 'vitest';
import { makeSnapshotState } from '../../../__tests__/test-utils/index.ts';
import { createInteractionDevice } from '../../../commands/interaction/runtime/__tests__/test-utils/index.ts';
import { presentIosInteractiveSnapshot } from './index.ts';
import {
  closedComposerWithRetainedActionShelfNodes,
  navigationTitleWithAppProvidedDetailsAffordanceNodes,
} from './transitions.fixtures.ts';

test('iOS presentation removes a retained alternative-action shelf after its replacement is shown', () => {
  const nodes = presentIosInteractiveSnapshot(closedComposerWithRetainedActionShelfNodes);
  const labels = nodes.map((node) => node.label).filter(Boolean);

  expect(labels).toEqual(['Fixture app', 'Attachment', 'Attachment', 'Voice input', 'Voice input']);
  expect(nodes.some((node) => node.identifier === 'ComposerTextInput')).toBe(true);
});

test('iOS presentation keeps a horizontal action shelf when no replacement presentation exists', () => {
  const withoutReplacement = closedComposerWithRetainedActionShelfNodes.filter(
    (node) => node.index !== 15 && node.index !== 16,
  );

  expect(
    presentIosInteractiveSnapshot(withoutReplacement).some(
      (node) => node.label === 'First alternative',
    ),
  ).toBe(true);
});

test('iOS presentation promotes an app-provided navigation title affordance without stealing a content action', () => {
  const nodes = presentIosInteractiveSnapshot(navigationTitleWithAppProvidedDetailsAffordanceNodes);
  const titleActions = nodes.filter(
    (node) => node.type === 'Button' && node.label === 'Fixture room',
  );

  expect(titleActions).toHaveLength(2);
  expect(titleActions[0]).toEqual(
    expect.objectContaining({ identifier: 'TitleField', enabled: true }),
  );
  expect(titleActions[0]?.rect).toEqual(expect.objectContaining({ x: 81, y: 58.33, height: 40 }));
  expect(titleActions[0]?.rect?.width).toBeCloseTo(223.67);
  expect(titleActions[1]?.rect).toEqual({ x: 20, y: 200.33, width: 362, height: 26.67 });
  expect(nodes.some((node) => node.type === 'StaticText' && node.label === 'Fixture room')).toBe(
    false,
  );
  expect(nodes.some((node) => node.identifier === 'DetailsAffordanceImage')).toBe(false);
});

test('promoted navigation title dispatches as its presented button semantics, not its disabled source field', async () => {
  const snapshot = makeSnapshotState(
    presentIosInteractiveSnapshot(navigationTitleWithAppProvidedDetailsAffordanceNodes),
  );
  const title = snapshot.nodes.find((node) => node.identifier === 'TitleField');
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
    node.identifier === 'DetailsAffordanceImage' ? { ...node, identifier: undefined } : node,
  );

  const nodes = presentIosInteractiveSnapshot(withoutNamedAffordance);
  expect(nodes.some((node) => node.type === 'TextField' && node.identifier === 'TitleField')).toBe(
    true,
  );
  expect(nodes.some((node) => node.type === 'Button' && node.identifier === 'TitleField')).toBe(
    false,
  );
});
