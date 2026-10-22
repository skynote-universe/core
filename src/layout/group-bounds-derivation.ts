/**
 * @file group-bounds-derivation.ts
 * @description 单个组合的外框派生；容器依赖顺序由事务内几何管线统一调度 (ADR-145)
 */

import type { NodeEntity } from '../types/node';
import type { RectBounds } from '../types/geometry';
import type { CanvasPatch } from '../types/operation';
import {
  applyMatrix,
  computeNodeLocalMatrix,
  computeNodeWorldBounds,
  roundPersisted,
  unionBounds
} from '../utils/geometry';

export const GROUP_NODE_TYPE = 'group';
const GEOMETRY_EPSILON = 1e-6;

export function deriveGroupBoundsPatches(
  group: Readonly<NodeEntity>,
  children: readonly Readonly<NodeEntity>[]
): CanvasPatch[] {
  if (children.length === 0) return [{ op: 'unset', path: ['content', 'nodes', group.id] }];
  let bounds: RectBounds | null = null;
  for (const child of children) {
    const childBounds = computeNodeWorldBounds(child, computeNodeLocalMatrix(child));
    bounds = bounds ? unionBounds(bounds, childBounds) : childBounds;
  }
  // 外框向外取整，旋转成员也不能使尺寸面板重新出现小数或裁掉边缘。
  const dx = Math.floor(roundPersisted(bounds!.left));
  const dy = Math.floor(roundPersisted(bounds!.top));
  const width = Math.max(1, Math.ceil(roundPersisted(bounds!.right)) - dx);
  const height = Math.max(1, Math.ceil(roundPersisted(bounds!.bottom)) - dy);
  const offsetChanged = Math.abs(dx) > GEOMETRY_EPSILON || Math.abs(dy) > GEOMETRY_EPSILON;
  if (
    !offsetChanged &&
    Math.abs(width - group.width) <= GEOMETRY_EPSILON &&
    Math.abs(height - group.height) <= GEOMETRY_EPSILON
  )
    return [];

  // 旋转绕节点中心：把新外框中心映射到父坐标系，再补偿直接子节点，保持其世界位姿不漂移。
  const center = applyMatrix(computeNodeLocalMatrix(group), dx + width / 2, dy + height / 2);
  const next = { x: Math.round(center.x - width / 2), y: Math.round(center.y - height / 2), width, height };
  const patches: CanvasPatch[] = [];
  for (const key of ['x', 'y', 'width', 'height'] as const) {
    if (Math.abs(next[key] - group[key]) > GEOMETRY_EPSILON)
      patches.push({ op: 'set', path: ['content', 'nodes', group.id, key], value: next[key] });
  }
  if (offsetChanged) {
    for (const child of children) {
      for (const [key, offset] of [
        ['x', dx],
        ['y', dy]
      ] as const) {
        const value = roundPersisted(child[key] - offset);
        if (Math.abs(value - child[key]) > GEOMETRY_EPSILON)
          patches.push({ op: 'set', path: ['content', 'nodes', child.id, key], value });
      }
    }
  }
  return patches;
}
