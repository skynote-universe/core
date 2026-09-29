/**
 * @file scene-spatial-index.test.ts
 * @description 分层空间索引 (ADR-114)：随机操作下检索结果不漏掉任何真实相交的节点、不多出外接矩形不相交的节点；
 *              移动容器只更新一个条目
 */

import { describe, it, expect, vi } from 'vitest';
import { SkyNoteEngine } from '../src/engine';
import { createSpatialIndex } from '../src/spatial';
import { applyMatrix, computeNodeWorldBounds, doBoundsIntersect, type RectBounds } from '../src/utils/geometry';
import type { NodeEntity } from '../src/types/node';

function createRandom(seed: number): () => number {
  let state = seed;
  return () => (state = (state * 16807) % 2147483647) / 2147483647;
}

/** 旋转后的真实框 (凸四边形) 与轴对齐查询区是否相交：分离轴定理 */
function boxIntersectsRect(engine: SkyNoteEngine, node: NodeEntity, rect: RectBounds): boolean {
  const m = engine.entityStore.getWorldTransform(node.id)!;
  const quad = [
    applyMatrix(m, 0, 0),
    applyMatrix(m, node.width, 0),
    applyMatrix(m, node.width, node.height),
    applyMatrix(m, 0, node.height)
  ];
  const rectCorners = [
    { x: rect.left, y: rect.top },
    { x: rect.right, y: rect.top },
    { x: rect.right, y: rect.bottom },
    { x: rect.left, y: rect.bottom }
  ];
  const axes = [
    { x: 1, y: 0 },
    { x: 0, y: 1 },
    { x: quad[1].x - quad[0].x, y: quad[1].y - quad[0].y },
    { x: quad[3].x - quad[0].x, y: quad[3].y - quad[0].y }
  ];
  const EPS = 1e-6;
  return axes.every((axis) => {
    const project = (points: { x: number; y: number }[]) => points.map((p) => p.x * axis.x + p.y * axis.y);
    const a = project(quad);
    const b = project(rectCorners);
    return Math.max(...a) >= Math.min(...b) - EPS && Math.max(...b) >= Math.min(...a) - EPS;
  });
}

/** 暴力检索：[必须检出的 (真实框相交)，允许检出的 (世界外接矩形相交)] */
function bruteForceSearch(engine: SkyNoteEngine, query: RectBounds): [string[], Set<string>] {
  const required: string[] = [];
  const allowed = new Set<string>();
  for (const runtimeNode of engine.entityStore.getAllNodes()) {
    const node = runtimeNode.entity;
    if (doBoundsIntersect(computeNodeWorldBounds(node, engine.entityStore.getWorldTransform(node.id)!), query)) {
      allowed.add(node.id);
      if (boxIntersectsRect(engine, node, query)) required.push(node.id);
    }
  }
  return [required, allowed];
}

function randomRect(random: () => number): RectBounds {
  const left = random() * 3000 - 500;
  const top = random() * 3000 - 500;
  const width = random() * 800;
  const height = random() * 800;
  return { left, top, right: left + width, bottom: top + height, width, height };
}

describe('SceneSpatialIndex 分层空间索引', () => {
  for (const seed of [1, 42, 2024]) {
    it(`随机嵌套、移动、旋转、改挂、删除后，检索结果与暴力检索一致 (seed ${seed})`, () => {
      const random = createRandom(seed);
      const engine = new SkyNoteEngine();
      const store = engine.documentStore;
      const ids = () => Object.keys(engine.getView().content.nodes);
      const pick = () => {
        const all = ids();
        return all[Math.floor(random() * all.length)];
      };
      let seq = 0;
      const addNode = () => {
        const all = ids();
        const parentId = all.length > 0 && random() < 0.5 ? pick() : undefined;
        const node: NodeEntity = {
          id: `n${seq++}`,
          type: 'node',
          nodeType: 'rect',
          x: parentId ? random() * 300 - 50 : random() * 2500,
          y: parentId ? random() * 300 - 50 : random() * 2500,
          width: 20 + random() * 200,
          height: 20 + random() * 200,
          rotation: random() < 0.3 ? random() * 360 : 0,
          zIndex: store.createTopZIndex(parentId),
          locked: false,
          parentId
        };
        store.addNode(node);
      };
      for (let i = 0; i < 80; i++) addNode();

      const originalError = console.error;
      console.error = () => {};
      try {
        for (let step = 0; step < 300; step++) {
          const roll = random();
          if (roll < 0.25) {
            store.moveNodes([pick()], { x: random() * 400 - 200, y: random() * 400 - 200 });
          } else if (roll < 0.4) {
            store.updateNode(pick(), { rotation: random() * 360 });
          } else if (roll < 0.5) {
            store.updateNode(pick(), { width: 10 + random() * 400, height: 10 + random() * 400 });
          } else if (roll < 0.62) {
            store.reparentNodes([pick()], random() < 0.3 ? undefined : pick());
          } else if (roll < 0.7) {
            store.removeNodes([pick()]);
          } else if (roll < 0.75) {
            // 远端只删除容器、保留子节点：子节点回落根层级
            store.commit({ origin: 'remote', patches: [{ op: 'unset', path: ['content', 'nodes', pick()] }] });
          } else if (roll < 0.8) {
            store.undo();
          } else {
            addNode();
          }

          for (let q = 0; q < 3; q++) {
            const query = randomRect(random);
            const result = new Set(engine.spatialIndex.search(query));
            const [required, allowed] = bruteForceSearch(engine, query);
            expect(
              required.filter((id) => !result.has(id)),
              `step ${step} 漏检`
            ).toEqual([]);
            expect(
              [...result].filter((id) => !allowed.has(id)),
              `step ${step} 多检`
            ).toEqual([]);
            expect(result.size, `step ${step} 重复`).toBe(engine.spatialIndex.search(query).length);
          }
          expect(engine.spatialIndex.size).toBe(engine.entityStore.nodeCount);
        }
      } finally {
        console.error = originalError;
      }
    });
  }

  it('移动容器只更新它在父容器中的一个条目，后代零更新', () => {
    const updateSpy = vi.fn();
    const engine = new SkyNoteEngine({
      createNodeSpatialIndex: () => {
        const index = createSpatialIndex('rtree');
        const update = index.update.bind(index);
        index.update = (id, bounds) => {
          updateSpy(id);
          update(id, bounds);
        };
        return index;
      }
    });
    const store = engine.documentStore;
    store.addNode({
      id: 'frame',
      type: 'node',
      nodeType: 'rect',
      x: 0,
      y: 0,
      width: 500,
      height: 500,
      rotation: 0,
      zIndex: 'a0',
      locked: false
    });
    for (let i = 0; i < 50; i++) {
      store.addNode({
        id: `c${i}`,
        type: 'node',
        nodeType: 'rect',
        x: i * 5,
        y: i * 5,
        width: 20,
        height: 20,
        rotation: 0,
        zIndex: 'a0',
        locked: false,
        parentId: 'frame'
      });
    }
    updateSpy.mockClear();

    store.moveNodes(['frame'], { x: 100, y: 50 });
    expect(updateSpy.mock.calls).toEqual([['frame']]);
    expect(engine.spatialIndex.getBounds('c10')!.left).toBe(150);
    // 边界包含在内：c8 右下角与 c12 左上角恰好落在该点
    expect([...engine.spatialIndex.hitTest({ x: 160, y: 110 })].sort()).toEqual([
      'c10',
      'c11',
      'c12',
      'c8',
      'c9',
      'frame'
    ]);
  });

  it('子树包围盒随子节点收回而收缩，查询不再下钻无关容器', () => {
    const searched: string[] = [];
    const engine = new SkyNoteEngine({
      createNodeSpatialIndex: () => {
        const index = createSpatialIndex('rtree');
        const search = index.search.bind(index);
        index.search = (bounds) => {
          // 以容器内登记的节点标识被检索的容器索引
          searched.push(index.getBounds('child') ? 'frame-index' : 'root-index');
          return search(bounds);
        };
        return index;
      }
    });
    const store = engine.documentStore;
    store.addNode({
      id: 'frame',
      type: 'node',
      nodeType: 'rect',
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      rotation: 0,
      zIndex: 'a0',
      locked: false
    });
    store.addNode({
      id: 'child',
      type: 'node',
      nodeType: 'rect',
      x: 1000,
      y: 0,
      width: 10,
      height: 10,
      rotation: 0,
      zIndex: 'a0',
      locked: false,
      parentId: 'frame'
    });
    const far = { left: 990, top: -5, right: 1020, bottom: 20, width: 30, height: 25 };

    expect(engine.spatialIndex.search(far)).toEqual(['child']);
    store.moveNodes(['child'], { x: -990 });
    searched.length = 0;
    expect(engine.spatialIndex.search(far)).toEqual([]);
    expect(searched).toEqual(['root-index']);
  });
});
