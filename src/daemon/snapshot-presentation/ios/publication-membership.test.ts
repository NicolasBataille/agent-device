import { expect, test } from 'vitest';
import { attachRefs, type RawSnapshotNode } from '@agent-device/kernel/snapshot';
import { presentIosInteractiveSnapshot } from './index.ts';

// End-to-end publication-membership contract for the acquire/present design (#1797, external
// review pass 4 finding 1). Runner presentation owns ELIGIBILITY (which nodes may appear at
// all); this daemon compaction layer owns PUBLICATION membership (what agents actually see).
// The four semantic-content cases pin the declared policy:
//   - label content   -> published (any type: a labeled image is meaningful content)
//   - value content   -> published
//   - interactive     -> published
//   - identifier-only STRUCTURAL `Other` (non-hittable, no label/value) -> ELIGIBLE but
//     SUPPRESSED at publication, deliberately: this is the React Native testID-wrapper shape
//     (see collectIosStructuralIdentifierSuppression in noise.ts), which would otherwise spam
//     agent output with non-actionable wrappers. Identifier-only nodes of other shapes are NOT
//     covered by that suppression and must survive.
function publish(nodes: RawSnapshotNode[]) {
  return attachRefs(presentIosInteractiveSnapshot(nodes));
}

const screen: RawSnapshotNode[] = [
  { index: 0, depth: 0, type: 'Application', label: 'ShopApp' },
  {
    index: 1,
    depth: 1,
    parentIndex: 0,
    type: 'Image',
    label: 'Red sneakers product photo',
    rect: { x: 16, y: 130, width: 80, height: 44 },
  },
  {
    index: 2,
    depth: 1,
    parentIndex: 0,
    type: 'Other',
    value: '3 items',
    rect: { x: 300, y: 130, width: 86, height: 44 },
  },
  {
    index: 3,
    depth: 1,
    parentIndex: 0,
    type: 'Other',
    identifier: 'promo-banner',
    rect: { x: 110, y: 130, width: 180, height: 44 },
  },
  {
    index: 4,
    depth: 1,
    parentIndex: 0,
    type: 'Button',
    label: 'Pay $42.00',
    hittable: true,
    rect: { x: 16, y: 696, width: 370, height: 56 },
  },
];

test('publication keeps label content, value content, and interactive nodes', () => {
  const published = publish(screen);
  const labels = published.map((node) => node.label ?? node.value ?? node.identifier);
  expect(labels).toContain('Red sneakers product photo');
  expect(labels).toContain('3 items');
  expect(labels).toContain('Pay $42.00');
});

test('publication suppresses identifier-only structural Other wrappers, by declared policy', () => {
  const published = publish(screen);
  expect(published.some((node) => node.identifier === 'promo-banner')).toBe(false);
});

test('identifier-only nodes outside the structural-Other shape survive publication', () => {
  const published = publish([
    { index: 0, depth: 0, type: 'Application', label: 'ShopApp' },
    // Hittable identifier-only Other: NOT structural noise — must survive.
    {
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'Other',
      identifier: 'submit-area',
      hittable: true,
      rect: { x: 16, y: 100, width: 370, height: 56 },
    },
  ]);
  expect(published.some((node) => node.identifier === 'submit-area')).toBe(true);
});
