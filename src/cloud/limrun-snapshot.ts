import fs from 'node:fs';
import path from 'node:path';
import type { AndroidElementNode } from '@limrun/api/instance-client';
import type { RawSnapshotNode } from '../utils/snapshot.ts';

type LimrunSelector = { key: 'id' | 'label' | 'text' | 'value'; value: string };

export type IosTreeNode = {
  elementType?: string;
  type?: string;
  label?: string;
  AXLabel?: string | null;
  identifier?: string;
  AXUniqueId?: string | null;
  value?: string;
  AXValue?: string | null;
  frame?: { x?: number; y?: number; width?: number; height?: number };
  rect?: { x?: number; y?: number; width?: number; height?: number };
  enabled?: boolean;
  role?: string;
  selected?: boolean;
  hittable?: boolean;
  children?: IosTreeNode[];
  nodes?: IosTreeNode[];
  elements?: IosTreeNode[];
};

export function flattenIosTree(input: IosTreeNode | IosTreeNode[]): RawSnapshotNode[] {
  const roots = Array.isArray(input) ? input : [input];
  const nodes: RawSnapshotNode[] = [];
  const visit = (node: IosTreeNode, depth: number, parentIndex?: number) => {
    const index = nodes.length;
    const rect = node.rect ?? node.frame;
    nodes.push({
      index,
      type: node.elementType ?? node.type,
      role: node.role ?? node.elementType ?? node.type,
      label: node.label ?? node.AXLabel ?? undefined,
      value: node.value ?? node.AXValue ?? undefined,
      identifier: node.identifier ?? node.AXUniqueId ?? undefined,
      rect:
        rect &&
        typeof rect.x === 'number' &&
        typeof rect.y === 'number' &&
        typeof rect.width === 'number' &&
        typeof rect.height === 'number'
          ? {
              x: rect.x,
              y: rect.y,
              width: rect.width,
              height: rect.height,
            }
          : undefined,
      enabled: node.enabled,
      selected: node.selected,
      hittable: node.hittable,
      depth,
      parentIndex,
    });
    for (const child of node.children ?? node.nodes ?? node.elements ?? []) {
      visit(child, depth + 1, index);
    }
  };
  for (const root of roots) visit(root, 0);
  return nodes;
}

export function mapAndroidNode(node: AndroidElementNode, index: number): RawSnapshotNode {
  const bounds = node.parsedBounds;
  return {
    index,
    type: node.className,
    role: node.className,
    label: node.text || node.contentDesc,
    value: node.text,
    identifier: node.resourceId,
    rect: bounds
      ? {
          x: bounds.left,
          y: bounds.top,
          width: Math.max(0, bounds.right - bounds.left),
          height: Math.max(0, bounds.bottom - bounds.top),
        }
      : undefined,
    enabled: node.enabled,
    selected: node.selected,
    hittable: node.clickable,
  };
}

export function toIosSelector(selector: LimrunSelector) {
  if (selector.key === 'id') return { accessibilityId: selector.value };
  if (selector.key === 'value') return { value: selector.value };
  return { label: selector.value };
}

export function toAndroidSelector(selector: LimrunSelector) {
  if (selector.key === 'id') return { resourceId: selector.value };
  return { text: selector.value };
}

export async function writeDataUriFile(filePath: string, dataUri: string): Promise<void> {
  const match = /^data:[^;]+;base64,(?<data>.+)$/u.exec(dataUri);
  await writeBase64File(filePath, match?.groups?.data ?? dataUri);
}

export async function writeBase64File(filePath: string, base64: string): Promise<void> {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, Buffer.from(base64, 'base64'));
}
