import type { RawSnapshotNode, Rect } from '@agent-device/kernel/snapshot';
import { isRectVisibleInViewport, rectContains } from '@agent-device/kernel/rect';
import { normalizeType } from '@agent-device/contracts/snapshot';
import {
  areRectsApproximatelyEqual,
  collectChildrenByParent,
  collectDescendants,
  findDescendant,
  isSemanticActionNode,
  isScrollableSnapshotType,
  mergeReplacement,
  type SnapshotTreeRuleContext,
} from '../tree.ts';

const ACTION_SHELF_MINIMUM_BUTTONS = 3;
const ACTION_SHELF_EDGE_TOLERANCE = 2;
const TITLE_PIECE_GAP_TOLERANCE = 12;

export function collectIosTransitionPresentation(
  nodes: RawSnapshotNode[],
  context: SnapshotTreeRuleContext,
): void {
  const childrenByParent = collectChildrenByParent(nodes);
  collectReplacedActionShelves(nodes, childrenByParent, context);
  collectNavigationTitleAffordances(nodes, childrenByParent, context);
}

function collectReplacedActionShelves(
  nodes: RawSnapshotNode[],
  childrenByParent: ReadonlyMap<number, RawSnapshotNode[]>,
  context: SnapshotTreeRuleContext,
): void {
  const positions = new Map(nodes.map((node, position) => [node.index, position]));
  for (const [shelfPosition, shelf] of nodes.entries()) {
    const transition = resolveReplacedActionShelf(
      nodes,
      positions,
      childrenByParent,
      shelf,
      context,
    );
    if (!transition) continue;

    suppressNodeAndDescendants(nodes, shelfPosition, context.suppressedIndexes);
    const shelfBand = expandRect(transition.shelfRect, ACTION_SHELF_EDGE_TOLERANCE);
    for (const sibling of transition.intermediateSiblings) {
      if (
        isTextInput(sibling) ||
        !sibling.rect ||
        !isRectVisibleInViewport(sibling.rect, shelfBand)
      ) {
        continue;
      }
      const position = positions.get(sibling.index);
      if (position !== undefined) {
        suppressNodeAndDescendants(nodes, position, context.suppressedIndexes);
      }
    }
  }
}

function resolveReplacedActionShelf(
  nodes: RawSnapshotNode[],
  positions: ReadonlyMap<number, number>,
  childrenByParent: ReadonlyMap<number, RawSnapshotNode[]>,
  shelf: RawSnapshotNode,
  context: SnapshotTreeRuleContext,
): { shelfRect: Rect; intermediateSiblings: RawSnapshotNode[] } | undefined {
  if (!isHorizontalActionShelf(shelf, childrenByParent.get(shelf.index) ?? [])) return undefined;
  const parent = findParent(shelf, context.sourceNodesByIndex);
  if (!parent?.rect) return undefined;

  const siblings = childrenByParent.get(parent.index) ?? [];
  const shelfPosition = siblings.findIndex((node) => node.index === shelf.index);
  if (shelfPosition < 1 || !hasIndependentLeadingAction(siblings, shelfPosition, shelf)) {
    return undefined;
  }
  const replacementPosition = findActionShelfReplacementPosition(
    nodes,
    positions,
    siblings,
    shelfPosition,
    parent,
  );
  if (replacementPosition < 0) return undefined;
  return {
    shelfRect: shelf.rect,
    intermediateSiblings: siblings.slice(shelfPosition + 1, replacementPosition),
  };
}

function findParent(
  node: RawSnapshotNode,
  nodesByIndex: ReadonlyMap<number, RawSnapshotNode>,
): RawSnapshotNode | undefined {
  return typeof node.parentIndex === 'number' ? nodesByIndex.get(node.parentIndex) : undefined;
}

function findActionShelfReplacementPosition(
  nodes: RawSnapshotNode[],
  positions: ReadonlyMap<number, number>,
  siblings: RawSnapshotNode[],
  shelfPosition: number,
  parent: RawSnapshotNode,
): number {
  return siblings.findIndex(
    (candidate, position) =>
      position > shelfPosition &&
      isActionShelfReplacement(nodes, positions.get(candidate.index), candidate, parent),
  );
}

function isHorizontalActionShelf(
  shelf: RawSnapshotNode,
  children: RawSnapshotNode[],
): shelf is RawSnapshotNode & { rect: Rect } {
  if (!isScrollableSnapshotType(shelf.type) || !shelf.rect) return false;
  const buttons = children.filter(
    (node) => normalizeType(node.type ?? '') === 'button' && node.rect,
  );
  if (buttons.length < ACTION_SHELF_MINIMUM_BUTTONS) return false;
  const centers = buttons.map((button) => button.rect!.x + button.rect!.width / 2);
  return (
    centers.every((center, index) => index === 0 || center > centers[index - 1]!) &&
    buttons.every((button) => isRectVisibleInViewport(button.rect!, shelf.rect!))
  );
}

function hasIndependentLeadingAction(
  siblings: RawSnapshotNode[],
  shelfPosition: number,
  shelf: RawSnapshotNode,
): boolean {
  if (!shelf.rect) return false;
  return siblings.slice(0, shelfPosition).some((candidate) => {
    if (!candidate.rect || !isSemanticActionNode(candidate)) return false;
    const centerX = candidate.rect.x + candidate.rect.width / 2;
    return (
      centerX < shelf.rect!.x &&
      verticallyOverlaps(candidate.rect, expandRect(shelf.rect!, ACTION_SHELF_EDGE_TOLERANCE))
    );
  });
}

function isActionShelfReplacement(
  nodes: RawSnapshotNode[],
  position: number | undefined,
  candidate: RawSnapshotNode,
  parent: RawSnapshotNode,
): boolean {
  return (
    position !== undefined &&
    normalizeType(candidate.type ?? '') === 'other' &&
    areRectsApproximatelyEqual(candidate.rect, parent.rect) &&
    Boolean(findDescendant(nodes, position, isSemanticActionNode))
  );
}

function suppressNodeAndDescendants(
  nodes: RawSnapshotNode[],
  position: number,
  suppressedIndexes: Set<number>,
): void {
  const node = nodes[position];
  if (!node) return;
  suppressedIndexes.add(node.index);
  for (const descendant of collectDescendants(nodes, position)) {
    suppressedIndexes.add(descendant.index);
  }
}

function isTextInput(node: RawSnapshotNode): boolean {
  const type = normalizeType(node.type ?? '');
  return (
    type === 'textfield' ||
    type === 'securetextfield' ||
    type === 'searchfield' ||
    type === 'textview'
  );
}

function collectNavigationTitleAffordances(
  nodes: RawSnapshotNode[],
  childrenByParent: ReadonlyMap<number, RawSnapshotNode[]>,
  context: SnapshotTreeRuleContext,
): void {
  for (const bar of nodes) {
    if (normalizeType(bar.type ?? '') !== 'navigationbar' || !bar.rect) continue;
    const children = childrenByParent.get(bar.index) ?? [];
    const candidates = children.flatMap((field) =>
      resolveNavigationTitleAffordance(field, children, bar.rect!),
    );
    if (candidates.length !== 1) continue;
    const { field, title, image } = candidates[0]!;
    mergeReplacement(context.replacements, field, {
      type: 'Button',
      enabled: true,
      rect: unionRects([image.rect!, field.rect!, title.rect!]),
    });
    context.semanticRepresentativeIndexes.add(field.index);
    context.suppressedIndexes.add(title.index);
    context.suppressedIndexes.add(image.index);
  }
}

function resolveNavigationTitleAffordance(
  field: RawSnapshotNode,
  siblings: RawSnapshotNode[],
  barRect: Rect,
): Array<{ field: RawSnapshotNode; title: RawSnapshotNode; image: RawSnapshotNode }> {
  const label = field.label?.trim();
  if (!isDisabledNavigationTitleField(field, label)) return [];
  const title = uniqueSibling(siblings, (node) => isMatchingTitle(node, label));
  const image = uniqueSibling(siblings, isNamedImage);
  return title?.rect &&
    image?.rect &&
    formsNavigationTitleAffordance(image.rect, field.rect!, title.rect, barRect)
    ? [{ field, title, image }]
    : [];
}

function isDisabledNavigationTitleField(
  field: RawSnapshotNode,
  label: string | undefined,
): label is string {
  return (
    normalizeType(field.type ?? '') === 'textfield' &&
    field.enabled === false &&
    Boolean(field.rect) &&
    Boolean(label) &&
    field.value?.trim() === label
  );
}

function isMatchingTitle(node: RawSnapshotNode, label: string): boolean {
  return (
    normalizeType(node.type ?? '') === 'statictext' &&
    node.label?.trim() === label &&
    Boolean(node.rect)
  );
}

function isNamedImage(node: RawSnapshotNode): boolean {
  return (
    normalizeType(node.type ?? '') === 'image' &&
    Boolean(node.identifier?.trim()) &&
    Boolean(node.rect)
  );
}

function uniqueSibling(
  siblings: RawSnapshotNode[],
  predicate: (node: RawSnapshotNode) => boolean,
): RawSnapshotNode | undefined {
  const matches = siblings.filter(predicate);
  return matches.length === 1 ? matches[0] : undefined;
}

function formsNavigationTitleAffordance(image: Rect, field: Rect, title: Rect, bar: Rect): boolean {
  const imageGap = field.x - (image.x + image.width);
  const titleGap = title.x - (field.x + field.width);
  return (
    rectContains(bar, image) &&
    rectContains(bar, field) &&
    rectContains(bar, title) &&
    imageGap >= 0 &&
    imageGap <= TITLE_PIECE_GAP_TOLERANCE &&
    titleGap >= 0 &&
    titleGap <= TITLE_PIECE_GAP_TOLERANCE &&
    verticallyOverlaps(image, field) &&
    verticallyOverlaps(field, title)
  );
}

function expandRect(rect: Rect, amount: number): Rect {
  return {
    x: rect.x - amount,
    y: rect.y - amount,
    width: rect.width + amount * 2,
    height: rect.height + amount * 2,
  };
}

function verticallyOverlaps(left: Rect, right: Rect): boolean {
  return Math.max(left.y, right.y) <= Math.min(left.y + left.height, right.y + right.height);
}

function unionRects(rects: Rect[]): Rect {
  const x = Math.min(...rects.map((rect) => rect.x));
  const y = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
  return { x, y, width: right - x, height: bottom - y };
}
