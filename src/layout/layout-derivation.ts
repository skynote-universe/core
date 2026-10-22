/**
 * @file layout-derivation.ts
 * @description 单棵布局树的纯函数排版；输入已包含更深层容器的最新派生尺寸 (ADR-130, ADR-145)
 */

import type { NodeEntity } from '../types/node';
import type { Point } from '../types/geometry';
import type { CanvasPatch } from '../types/operation';
import type { LayoutMember } from '../protocols/layout.protocol';
import type { LayoutRegistry } from '../registry/layout-registry';
import { sortSiblingsByLayer } from './layer-order';
import { buildLayoutTree } from './layout-tree';

export interface LayoutDerivationContext {
  readonly layouts: LayoutRegistry;
  childrenOf(parentId: string): readonly Readonly<NodeEntity>[];
  /** 托管成员仍占槽位，但交互期间不回写其位置和旋转 */
  isHeld?(nodeId: string): boolean;
}
const POSITION_EPSILON = 1e-6;

export function deriveLayoutPatches(root: Readonly<NodeEntity>, context: LayoutDerivationContext): CanvasPatch[] {
  const definition = context.layouts.get(root.layout!.type);
  if (!definition) return [];
  const tree = buildLayoutTree(root, (id) => sortSiblingsByLayer(context.childrenOf(id)), definition);
  const targets = definition.arrange(tree);
  const patches: CanvasPatch[] = [];
  const appendSize = (node: Readonly<NodeEntity>): void => {
    const target = targets.get(node.id);
    for (const key of ['width', 'height'] as const) {
      const value = target?.[key];
      if (value !== undefined && Math.abs(value - node[key]) > POSITION_EPSILON)
        patches.push({ op: 'set', path: ['content', 'nodes', node.id, key], value });
    }
  };
  appendSize(root);
  const placed = new Map<string, Point>([[root.id, { x: 0, y: 0 }]]);
  const placeOf = (member: LayoutMember): Point => {
    let point = placed.get(member.node.id);
    if (!point) {
      const parent = placeOf(member.parent!);
      point = targets.get(member.node.id) ?? { x: parent.x + member.node.x, y: parent.y + member.node.y };
      placed.set(member.node.id, point);
    }
    return point;
  };
  const visit = (member: LayoutMember): void => {
    for (const child of member.children) {
      if (!context.isHeld?.(child.node.id)) {
        const target = placeOf(child);
        const parent = placeOf(member);
        const next = {
          x: target.x - parent.x,
          y: target.y - parent.y,
          rotation: targets.get(child.node.id)?.rotation ?? 0
        };
        for (const key of ['x', 'y', 'rotation'] as const) {
          if (Math.abs(next[key] - child.node[key]) > POSITION_EPSILON)
            patches.push({ op: 'set', path: ['content', 'nodes', child.node.id, key], value: next[key] });
        }
      }
      appendSize(child.node);
      visit(child);
    }
  };
  visit(tree.root);
  return patches;
}
