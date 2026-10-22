/** 空间索引批量调度及深层边界：增量状态必须与同文档全量重建相同。 */
import { expect, it, vi } from 'vitest';
import { SkyNoteEngine } from '../src/engine';
import { createEmptyCanvasDocument } from '../src/state/document-store';
import { parseCanvasDocument } from '../src/serialization/document-schema';
import type { CanvasPatch } from '../src/types/operation';

function chainDocument(depth: number, reverse = false) {
  const doc = createEmptyCanvasDocument();
  const ids = Array.from({ length: depth }, (_, i) => `n${i}`);
  for (const id of reverse ? [...ids].reverse() : ids) {
    const i = Number(id.slice(1));
    doc.content.nodes[id] = {
      id,
      type: 'node',
      nodeType: 'rect',
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      rotation: 0,
      zIndex: 'a0',
      locked: false,
      ...(i ? { parentId: ids[i - 1] } : {})
    };
  }
  return { doc, ids };
}

function expectSameAsRebuild(engine: SkyNoteEngine): void {
  const fresh = new SkyNoteEngine({ initialDoc: JSON.parse(JSON.stringify(engine.documentStore.getView())) });
  try {
    expect(engine.spatialIndex.size).toBe(fresh.spatialIndex.size);
    expect(engine.spatialIndex.getContentBounds()).toEqual(fresh.spatialIndex.getContentBounds());
    for (const node of engine.entityStore.getAllNodes())
      expect(engine.spatialIndex.getBounds(node.entity.id)).toEqual(fresh.spatialIndex.getBounds(node.entity.id));
    for (const query of [
      { left: -100, top: -100, right: 500, bottom: 500 },
      { left: 45, top: 45, right: 55, bottom: 55 },
      { left: 300, top: 20, right: 400, bottom: 80 },
      { left: 900, top: -50, right: 1300, bottom: 200 }
    ])
      expect([...engine.spatialIndex.search(query)].sort()).toEqual([...fresh.spatialIndex.search(query)].sort());
  } finally {
    fresh.destroy();
  }
}

it.each([
  [200, false],
  [400, false],
  [200, true],
  [400, true]
] as const)('%s层同批旋转的范围解析与实体读取保持线性，反序=%s', (depth, reverse) => {
  const { doc, ids } = chainDocument(depth);
  const engine = new SkyNoteEngine({ initialDoc: doc });
  let extents = 0;
  engine.nodeTypes.register({
    type: 'rect',
    label: '矩形',
    defaultData: {},
    compose: () => [],
    extent: (node) => {
      extents++;
      return { left: 0, top: 0, right: node.width, bottom: node.height };
    }
  });
  const reads = vi.spyOn(engine.entityStore, 'getNode');
  try {
    extents = 0;
    engine.documentStore.updateNodes(reverse ? [...ids].reverse() : ids, { rotation: 1 });
    expect(extents).toBeLessThanOrEqual(depth * 2);
    expect(reads.mock.calls.length).toBeLessThan(depth * 20);
    reads.mockRestore();
    expectSameAsRebuild(engine);
    engine.documentStore.undo();
    expectSameAsRebuild(engine);
    engine.documentStore.redo();
    expectSameAsRebuild(engine);
  } finally {
    reads.mockRestore();
    engine.destroy();
  }
});

it.each([false, true])('12000层文档深度规划和查询不依赖调用栈，叶子在前=%s', (reverse) => {
  const { doc, ids } = chainDocument(12000, reverse);
  expect(parseCanvasDocument(JSON.parse(JSON.stringify(doc))).ok).toBe(true);
  const engine = new SkyNoteEngine({ initialDoc: doc });
  try {
    const query = { left: 40, top: 40, right: 60, bottom: 60 };
    expect(engine.spatialIndex.search(query)).toHaveLength(ids.length);
    expect(engine.spatialIndex.hitTest({ x: 50, y: 50 })).toHaveLength(ids.length);
    expect(engine.spatialIndex.getBounds(ids.at(-1)!)).toEqual({ left: 0, top: 0, right: 100, bottom: 100 });
    expect(engine.spatialIndex.getContentBounds()).toEqual({ left: 0, top: 0, right: 100, bottom: 100 });
  } finally {
    engine.destroy();
  }
});

it.each([false, true])('父子同批改挂、缩放及删除容器后的孤儿登记与重建一致，反序=%s', (reverse) => {
  const { doc } = chainDocument(4);
  doc.content.nodes.n0.width = 200;
  doc.content.nodes.n1.x = 250;
  doc.content.nodes.n2.x = 100;
  doc.content.nodes.n3.width = 10;
  const engine = new SkyNoteEngine({ initialDoc: doc });
  try {
    const patches: CanvasPatch[] = [
      { op: 'unset', path: 'content.nodes.n2.parentId' },
      { op: 'set', path: 'content.nodes.n2.x', value: 1000 },
      { op: 'set', path: 'content.nodes.n1.parentId', value: 'n2' },
      { op: 'set', path: 'content.nodes.n3.parentId', value: 'n0' },
      { op: 'set', path: 'content.nodes.n0.width', value: 50 }
    ];
    expect(engine.documentStore.commit({ patches: reverse ? [...patches].reverse() : patches })).not.toBeNull();
    expectSameAsRebuild(engine);
    engine.documentStore.undo();
    expectSameAsRebuild(engine);
    engine.documentStore.redo();
    expectSameAsRebuild(engine);
    engine.documentStore.commit({
      origin: 'remote',
      patches: [
        { op: 'unset', path: 'content.nodes.n0' },
        { op: 'unset', path: 'content.nodes.n2' }
      ]
    });
    expectSameAsRebuild(engine);
  } finally {
    engine.destroy();
  }
});

it('分支树中的批量改挂、移动和缩放持续与全量重建一致', () => {
  const { doc, ids } = chainDocument(50);
  for (const [i, id] of ids.entries()) {
    const node = doc.content.nodes[id];
    if (i) node.parentId = ids[Math.floor((i - 1) / 3)];
    node.x = (i % 7) * 37;
    node.y = (i % 5) * 29;
    node.width = 20 + (i % 6) * 10;
  }
  const engine = new SkyNoteEngine({ initialDoc: doc });
  let seed = 145;
  const random = (): number => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  try {
    for (let step = 0; step < 60; step++) {
      const patches: CanvasPatch[] = [];
      for (let j = 0; j < 4; j++) {
        const index = random() % ids.length;
        const path = ['content', 'nodes', ids[index]];
        patches.push({ op: 'set', path: [...path, 'x'], value: (random() % 400) - 100 });
        patches.push({ op: 'set', path: [...path, 'width'], value: 10 + (random() % 150) });
        patches.push({ op: 'set', path: [...path, 'rotation'], value: random() % 360 });
        if (index) patches.push({ op: 'set', path: [...path, 'parentId'], value: ids[random() % index] });
      }
      expect(engine.documentStore.commit({ patches })).not.toBeNull();
      expectSameAsRebuild(engine);
      if (step % 10 === 0) {
        engine.documentStore.undo();
        expectSameAsRebuild(engine);
        engine.documentStore.redo();
        expectSameAsRebuild(engine);
      }
    }
  } finally {
    engine.destroy();
  }
});
