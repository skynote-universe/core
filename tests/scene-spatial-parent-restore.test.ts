/** 父节点恢复只重新挂载直接孤儿，查询结果应与同文档重建一致。 */
import { expect, it, vi } from 'vitest';
import { SkyNoteEngine } from '../src/engine';
import { createEmptyCanvasDocument } from '../src/state/document-store';
import type { NodeEntity } from '../src/types/node';
import type { CanvasPatch } from '../src/types/operation';

function node(id: string, x: number, parentId?: string): NodeEntity {
  return {
    id,
    type: 'node',
    nodeType: 'rect',
    x,
    y: 0,
    width: 100,
    height: 100,
    rotation: 0,
    zIndex: 'a0',
    locked: false,
    ...(parentId === undefined ? {} : { parentId })
  };
}

function expectRebuilt(engine: SkyNoteEngine): void {
  const fresh = new SkyNoteEngine({ initialDoc: JSON.parse(JSON.stringify(engine.documentStore.getView())) });
  try {
    expect(engine.spatialIndex.size).toBe(fresh.spatialIndex.size);
    expect(engine.spatialIndex.getContentBounds()).toEqual(fresh.spatialIndex.getContentBounds());
    for (const { entity } of engine.entityStore.getAllNodes())
      expect(engine.spatialIndex.getBounds(entity.id)).toEqual(fresh.spatialIndex.getBounds(entity.id));
    for (const x of [0, 200, 450, 1000, 1200, 1450, 2000]) {
      const query = { left: x, top: -10, right: x + 100, bottom: 110 };
      expect([...engine.spatialIndex.search(query)].sort()).toEqual([...fresh.spatialIndex.search(query)].sort());
      expect([...engine.spatialIndex.hitTest({ x: x + 50, y: 50 })].sort()).toEqual(
        [...fresh.spatialIndex.hitTest({ x: x + 50, y: 50 })].sort()
      );
    }
  } finally {
    fresh.destroy();
  }
}

it.each(['remote', 'undo', 'late'] as const)('父容器%s恢复后，孤儿及其后代与重建一致', (mode) => {
  const doc = createEmptyCanvasDocument();
  const parent = node('p', 1000);
  if (mode !== 'late') doc.content.nodes.p = parent;
  doc.content.nodes.c = node('c', 200, 'p');
  doc.content.nodes.g = node('g', 250, 'c');
  const engine = new SkyNoteEngine({ initialDoc: doc });
  try {
    if (mode !== 'late') {
      expect(
        engine.documentStore.commit({
          origin: mode === 'remote' ? 'remote' : 'local',
          patches: [{ op: 'unset', path: 'content.nodes.p' }]
        })
      ).not.toBeNull();
    }
    expectRebuilt(engine);
    expect(engine.spatialIndex.getBounds('c')?.left).toBe(200);
    if (mode === 'undo') engine.documentStore.undo();
    else
      expect(
        engine.documentStore.commit({
          origin: 'remote',
          patches: [{ op: 'set', path: 'content.nodes.p', value: parent }]
        })
      ).not.toBeNull();
    expect(engine.spatialIndex.getBounds('c')?.left).toBe(1200);
    expect(engine.spatialIndex.getBounds('g')?.left).toBe(1450);
    expectRebuilt(engine);
    if (mode === 'undo') {
      engine.documentStore.redo();
      expectRebuilt(engine);
      engine.documentStore.undo();
      expectRebuilt(engine);
    }
  } finally {
    engine.destroy();
  }
});

it.each([false, true])('父链同批到达与子节点改挂、删除按最终关系登记，反序=%s', (reverse) => {
  const doc = createEmptyCanvasDocument();
  doc.content.nodes.c = node('c', 200, 'p');
  doc.content.nodes.g = node('g', 250, 'c');
  doc.content.nodes.moved = node('moved', 200, 'p');
  doc.content.nodes.deleted = node('deleted', 300, 'p');
  doc.content.nodes.other = node('other', 2000);
  const engine = new SkyNoteEngine({ initialDoc: doc });
  try {
    const patches: CanvasPatch[] = [
      { op: 'set', path: 'content.nodes.p', value: node('p', 300, 'a') },
      { op: 'set', path: 'content.nodes.a', value: node('a', 700) },
      { op: 'set', path: 'content.nodes.moved.parentId', value: 'other' },
      { op: 'unset', path: 'content.nodes.deleted' },
      { op: 'set', path: 'content.nodes.new', value: node('new', 50, 'p') }
    ];
    expect(engine.documentStore.commit({ patches: reverse ? [...patches].reverse() : patches })).not.toBeNull();
    expectRebuilt(engine);
    engine.documentStore.undo();
    expectRebuilt(engine);
    engine.documentStore.redo();
    expectRebuilt(engine);
  } finally {
    engine.destroy();
  }
});

it('恢复父容器不扫描画布或重新登记孤儿的后代', () => {
  const doc = createEmptyCanvasDocument();
  doc.content.nodes.c = node('c', 200, 'p');
  for (let i = 0; i < 500; i++) doc.content.nodes[`g${i}`] = node(`g${i}`, i, 'c');
  for (let i = 0; i < 2000; i++) doc.content.nodes[`u${i}`] = node(`u${i}`, i * 100);
  const engine = new SkyNoteEngine({ initialDoc: doc });
  let extents = 0;
  engine.nodeTypes.register({
    type: 'rect',
    label: '矩形',
    defaultData: {},
    compose: () => [],
    extent: (entity) => {
      extents++;
      return { left: 0, top: 0, right: entity.width, bottom: entity.height };
    }
  });
  const allNodes = vi.spyOn(engine.entityStore, 'getAllNodes');
  try {
    extents = 0;
    expect(
      engine.documentStore.commit({
        origin: 'remote',
        patches: [{ op: 'set', path: 'content.nodes.p', value: node('p', 1000) }]
      })
    ).not.toBeNull();
    expect(allNodes).not.toHaveBeenCalled();
    expect(extents).toBe(2);
    allNodes.mockRestore();
    expectRebuilt(engine);
  } finally {
    allNodes.mockRestore();
    engine.destroy();
  }
});
