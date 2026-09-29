/**
 * @file layer-order.ts
 * @description 同一容器兄弟间的层级调整 (纯函数)：上移一层、下移一层、置顶、置底
 *
 * 设计考量 (Why):
 * 1. 按列表顺序移动：上移/下移越过紧挨的一个未选中兄弟，与画面是否重叠无关 (与 Figma / PowerPoint 一致)。
 * 2. 只改被移动的节点：未选中节点保留原索引，被选中节点按新顺序在相邻未选中节点之间生成新键，
 *    多选时保持相对顺序；协同下不会覆盖他人对其他节点的层级调整。
 * 3. 容错：若相邻未选中节点的键因并发写入而相同或逆序，退化为对整组兄弟重新编号，仍在同一事务内完成。
 */

import type { NodeEntity } from '../types/node';
import type { CanvasPatch } from '../types/operation';
import {
  compareFractionalIndex,
  generateNKeysBetween,
  isValidFractionalIndex,
  type FractionalIndex
} from '../utils/fractional-index';

/** 层级调整方式 */
export type LayerMove = 'forward' | 'backward' | 'front' | 'back';

/** 兄弟节点按层叠顺序从下到上排序 (键相同按 id 决胜) */
export function sortSiblingsByLayer(siblings: readonly Readonly<NodeEntity>[]): Readonly<NodeEntity>[] {
  return [...siblings].sort((a, b) => compareFractionalIndex(a.zIndex, a.id, b.zIndex, b.id));
}

/** 按列表顺序计算移动后的新顺序 (自下而上的 id 列表) */
export function computeLayerOrder(order: readonly string[], selected: ReadonlySet<string>, move: LayerMove): string[] {
  const picked = order.filter((id) => selected.has(id));
  const rest = order.filter((id) => !selected.has(id));
  if (move === 'front') return [...rest, ...picked];
  if (move === 'back') return [...picked, ...rest];

  const next = [...order];
  if (move === 'forward') {
    // 自上而下扫描：选中者越过其上方紧挨的未选中者，连续的选中块整体上移一格
    for (let i = next.length - 2; i >= 0; i--) {
      if (selected.has(next[i]) && !selected.has(next[i + 1])) {
        [next[i], next[i + 1]] = [next[i + 1], next[i]];
      }
    }
  } else {
    for (let i = 1; i < next.length; i++) {
      if (selected.has(next[i]) && !selected.has(next[i - 1])) {
        [next[i], next[i - 1]] = [next[i - 1], next[i]];
      }
    }
  }
  return next;
}

/**
 * 为新顺序生成 zIndex 补丁：未选中节点保持原键，每段连续的选中节点在两侧未选中节点的键之间生成递增新键
 */
export function deriveLayerOrderPatches(
  siblings: readonly Readonly<NodeEntity>[],
  newOrder: readonly string[],
  selected: ReadonlySet<string>
): CanvasPatch[] {
  const keyOf = new Map(siblings.map((node) => [node.id, node.zIndex]));
  const assignments: [string, FractionalIndex][] = [];

  let runStart = 0;
  while (runStart < newOrder.length) {
    if (!selected.has(newOrder[runStart])) {
      runStart++;
      continue;
    }
    let runEnd = runStart;
    while (runEnd + 1 < newOrder.length && selected.has(newOrder[runEnd + 1])) runEnd++;

    const lower = runStart > 0 ? keyOf.get(newOrder[runStart - 1])! : null;
    const upper = runEnd + 1 < newOrder.length ? keyOf.get(newOrder[runEnd + 1])! : null;
    const boundsUsable =
      (lower === null || isValidFractionalIndex(lower)) &&
      (upper === null || isValidFractionalIndex(upper)) &&
      (lower === null || upper === null || lower < upper);
    if (!boundsUsable) {
      return renumberLayerOrder(siblings, newOrder);
    }

    const keys = generateNKeysBetween(lower, upper, runEnd - runStart + 1);
    for (let i = runStart; i <= runEnd; i++) {
      assignments.push([newOrder[i], keys[i - runStart]]);
    }
    runStart = runEnd + 1;
  }

  return assignments
    .filter(([id, key]) => keyOf.get(id) !== key)
    .map(([id, key]) => ({ op: 'set', path: ['content', 'nodes', id, 'zIndex'], value: key }));
}

/**
 * 按给定顺序为整组兄弟重新编号 (最短的均匀键)，用于键长异常或键冲突时整理
 */
export function renumberLayerOrder(siblings: readonly Readonly<NodeEntity>[], order: readonly string[]): CanvasPatch[] {
  const keyOf = new Map(siblings.map((node) => [node.id, node.zIndex]));
  const keys = generateNKeysBetween(null, null, order.length);
  const patches: CanvasPatch[] = [];
  for (let i = 0; i < order.length; i++) {
    if (keyOf.get(order[i]) !== keys[i]) {
      patches.push({ op: 'set', path: ['content', 'nodes', order[i], 'zIndex'], value: keys[i] });
    }
  }
  return patches;
}
