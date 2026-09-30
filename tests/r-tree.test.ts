/**
 * @file r-tree.test.ts
 * @description R-Tree 结构不变量与长时编辑不退化：随机增删改对拍暴力检索，并逐步校验树形
 */

import type { RectBounds } from '../src/types/geometry';
import { describe, it, expect } from 'vitest';
import { RTreeSpatialIndex } from '../src/spatial/r-tree';

interface InspectableNode {
  isLeaf: boolean;
  bounds: RectBounds;
  children: (InspectableNode | { id: string; bounds: RectBounds })[];
  parent?: InspectableNode;
}

/** 以只读方式窥探内部树形，校验不变量 */
function inspect(tree: RTreeSpatialIndex): { root: InspectableNode; itemMap: Map<string, { leaf: InspectableNode }> } {
  return tree as unknown as { root: InspectableNode; itemMap: Map<string, { leaf: InspectableNode }> };
}

function rect(x: number, y: number, w = 20, h = 20): RectBounds {
  return { left: x, top: y, right: x + w, bottom: y + h };
}

function intersects(a: RectBounds, b: RectBounds): boolean {
  return !(a.right < b.left || a.left > b.right || a.bottom < b.top || a.top > b.bottom);
}

function createRandom(seed: number): () => number {
  let state = seed;
  return () => (state = (state * 16807) % 2147483647) / 2147483647;
}

/** 校验：非根节点不为空、包围盒恰好等于子项并集、父指针与叶子直达映射一致；返回节点总数 */
function assertInvariants(tree: RTreeSpatialIndex): number {
  const { root, itemMap } = inspect(tree);
  let nodeCount = 0;
  let entryCount = 0;

  const walk = (node: InspectableNode): void => {
    nodeCount++;
    if (node !== root) {
      expect(node.children.length).toBeGreaterThan(0);
    }
    if (node.children.length > 0) {
      const union = node.children.reduce(
        (acc, child) => ({
          left: Math.min(acc.left, child.bounds.left),
          top: Math.min(acc.top, child.bounds.top),
          right: Math.max(acc.right, child.bounds.right),
          bottom: Math.max(acc.bottom, child.bounds.bottom)
        }),
        { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity }
      );
      expect(node.bounds.left).toBe(union.left);
      expect(node.bounds.top).toBe(union.top);
      expect(node.bounds.right).toBe(union.right);
      expect(node.bounds.bottom).toBe(union.bottom);
    }
    for (const child of node.children) {
      if (node.isLeaf) {
        entryCount++;
        expect(itemMap.get((child as { id: string }).id)?.leaf).toBe(node);
      } else {
        expect((child as InspectableNode).parent).toBe(node);
        walk(child as InspectableNode);
      }
    }
  };

  walk(root);
  expect(entryCount).toBe(tree.size);
  return nodeCount;
}

describe('RTreeSpatialIndex 结构不变量', () => {
  it('随机增删改与暴力检索结果一致，且每步保持树形不变量', () => {
    const random = createRandom(42);
    const tree = new RTreeSpatialIndex();
    const truth = new Map<string, RectBounds>();

    for (let step = 0; step < 3000; step++) {
      const id = `n${Math.floor(random() * 300)}`;
      const roll = random();
      if (roll < 0.15) {
        tree.remove(id);
        truth.delete(id);
      } else if (roll < 0.6 && truth.has(id)) {
        // 小步拖拽：大概率命中就地更新快速路径
        const old = truth.get(id)!;
        const next = rect(old.left + (random() - 0.5) * 10, old.top + (random() - 0.5) * 10);
        tree.update(id, next);
        truth.set(id, next);
      } else {
        const next = rect(random() * 5000, random() * 5000, 5 + random() * 200, 5 + random() * 200);
        tree.update(id, next);
        truth.set(id, next);
      }

      if (step % 100 === 0) {
        assertInvariants(tree);
        const query = rect(random() * 4000, random() * 4000, 800, 600);
        const expected = [...truth]
          .filter(([, b]) => intersects(b, query))
          .map(([k]) => k)
          .sort();
        expect([...tree.search(query)].sort()).toEqual(expected);
      }
    }
    assertInvariants(tree);
  });

  it('长时间反复拖拽后树规模不膨胀，根包围盒不被空节点拉向原点', () => {
    const random = createRandom(7);
    const tree = new RTreeSpatialIndex();
    const positions: [number, number][] = [];
    for (let i = 0; i < 2000; i++) {
      positions.push([(i % 50) * 30 + 1000, Math.floor(i / 50) * 30 + 1000]);
      tree.update(`n${i}`, rect(...positions[i]));
    }
    const initialNodes = assertInvariants(tree);

    for (let k = 0; k < 40000; k++) {
      const i = Math.floor(random() * positions.length);
      positions[i] = [positions[i][0] + (random() - 0.5) * 300, positions[i][1] + (random() - 0.5) * 300];
      tree.update(`n${i}`, rect(...positions[i]));
    }

    const finalNodes = assertInvariants(tree);
    expect(finalNodes).toBeLessThan(initialNodes * 2);
    const minLeft = Math.min(...positions.map(([x]) => x));
    expect(inspect(tree).root.bounds.left).toBe(minLeft);
  });

  it('STR 批量装载与逐条插入检索结果一致，删空后恢复为空叶子根', () => {
    const random = createRandom(3);
    const entries: [string, RectBounds][] = [];
    for (let i = 0; i < 5000; i++) {
      entries.push([`n${i}`, rect(random() * 20000, random() * 20000, 10 + random() * 100, 10 + random() * 100)]);
    }

    const bulk = new RTreeSpatialIndex();
    bulk.load(entries);
    const incremental = new RTreeSpatialIndex();
    for (const [id, bounds] of entries) incremental.update(id, bounds);

    assertInvariants(bulk);
    expect(bulk.size).toBe(5000);
    for (let q = 0; q < 50; q++) {
      const query = rect(random() * 18000, random() * 18000, 2000, 1500);
      expect([...bulk.search(query)].sort()).toEqual([...incremental.search(query)].sort());
    }

    for (const [id] of entries) bulk.remove(id);
    expect(bulk.size).toBe(0);
    expect(inspect(bulk).root.isLeaf).toBe(true);
    expect(bulk.search(rect(-1e9, -1e9, 2e9, 2e9))).toEqual([]);
  });
});
