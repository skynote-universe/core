/**
 * @file nested-coordinates.test.ts
 * @description ADR-114 局部坐标：世界矩阵复合与缓存、旋转容器内的移动、改挂保持世界位姿、变更集与连线路由联动
 */

import { describe, it, expect } from 'vitest';
import { SkyNoteEngine } from '../src/engine';
import { compareHierarchicalNodes } from '../src/layout/layer-order';
import { applyMatrix, computeWorldFrame } from '../src/utils/geometry';
import type { NodeEntity } from '../src/types/node';
import type { ConnectorEntity } from '../src/types/connector';
import type { DocumentChangeSet } from '../src/types/change-set';

function makeNode(id: string, patch: Partial<NodeEntity> = {}): NodeEntity {
  return {
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
    ...patch
  };
}

function worldPoint(engine: SkyNoteEngine, id: string, x: number, y: number) {
  return applyMatrix(engine.entityStore.getWorldTransform(id)!, x, y);
}

describe('世界矩阵', () => {
  it('子节点世界位置 = 父世界矩阵 ∘ 自身局部矩阵，父容器旋转带动子节点绕父中心旋转', () => {
    const engine = new SkyNoteEngine();
    const store = engine.documentStore;
    store.addNode(makeNode('frame', { x: 100, y: 100, width: 200, height: 200, rotation: 90 }));
    store.addNode(makeNode('card', { x: 0, y: 0, width: 20, height: 20, parentId: 'frame' }));

    // 父框中心 (200, 200)，旋转 90° 后局部原点 (0,0) 落在世界 (300, 100)
    const origin = worldPoint(engine, 'card', 0, 0);
    expect(origin.x).toBeCloseTo(300);
    expect(origin.y).toBeCloseTo(100);
    const bounds = engine.getNodeWorldBounds('card')!;
    expect(bounds.left).toBeCloseTo(280);
    expect(bounds.top).toBeCloseTo(100);
  });

  it('世界矩阵缓存随祖先几何与改挂自动失效，未变化时返回同一引用', () => {
    const engine = new SkyNoteEngine();
    const store = engine.documentStore;
    store.addNode(makeNode('outer', { x: 10 }));
    store.addNode(makeNode('inner', { x: 5, parentId: 'outer' }));
    store.addNode(makeNode('leaf', { x: 1, parentId: 'inner' }));

    const first = engine.entityStore.getWorldTransform('leaf');
    expect(engine.entityStore.getWorldTransform('leaf')).toBe(first);
    expect(first!.e).toBe(16);

    store.updateNode('outer', { x: 110 });
    expect(engine.entityStore.getWorldTransform('leaf')!.e).toBe(116);

    // 原始字段补丁改挂 (如远端)：局部坐标不变，世界位置随新父级变化
    store.updateNode('inner', { parentId: undefined });
    expect(engine.entityStore.getWorldTransform('leaf')!.e).toBe(6);
  });
});

describe('语义操作', () => {
  it('moveNodes 在旋转容器内把世界位移换算为局部位移，拖拽方向与屏幕一致', () => {
    const engine = new SkyNoteEngine();
    const store = engine.documentStore;
    store.addNode(makeNode('frame', { width: 200, height: 200, rotation: 90 }));
    store.addNode(makeNode('card', { x: 10, y: 10, width: 20, height: 20, parentId: 'frame' }));

    const before = worldPoint(engine, 'card', 0, 0);
    store.moveNodes(['card'], { x: 30 });
    const after = worldPoint(engine, 'card', 0, 0);
    expect(after.x - before.x).toBeCloseTo(30);
    expect(after.y - before.y).toBeCloseTo(0);
    // 父容器顺时针旋转 90°：局部 +y 指向世界 -x，世界 +x 对应局部 -y
    expect(store.getNode('card')!.y).toBeCloseTo(-20);
  });

  it('reparentNodes 保持世界位姿不变，按原层叠顺序置于新容器最上层，撤销一步还原', () => {
    const engine = new SkyNoteEngine();
    const store = engine.documentStore;
    store.addNode(makeNode('frame', { x: 100, y: 100, width: 400, height: 400, rotation: 30 }));
    store.addNode(makeNode('existing', { parentId: 'frame', zIndex: 'a5' }));
    store.addNode(makeNode('a', { x: 150, y: 180, width: 40, height: 20, rotation: 10, zIndex: 'a1' }));
    store.addNode(makeNode('b', { x: 250, y: 260, zIndex: 'a0' }));

    const corner = (id: string) => worldPoint(engine, id, 40, 20);
    const beforeA = corner('a');
    const beforeB = corner('b');

    store.reparentNodes(['a', 'b'], 'frame');
    const a = store.getNode('a')!;
    expect(a.parentId).toBe('frame');
    expect(a.rotation).toBeCloseTo(-20);
    expect(corner('a').x).toBeCloseTo(beforeA.x);
    expect(corner('a').y).toBeCloseTo(beforeA.y);
    expect(corner('b').x).toBeCloseTo(beforeB.x);

    // 原先 b 在 a 下方，移入后仍保持，且都在容器原有子节点之上
    const siblings = [...engine.entityStore.getChildIds('frame')].map((id) => store.getNode(id)!);
    const order = siblings.sort((l, r) => compareHierarchicalNodes(l, r, (id) => store.getNode(id))).map((n) => n.id);
    expect(order).toEqual(['existing', 'b', 'a']);

    store.undo();
    expect(store.getNode('a')).toMatchObject({ x: 150, y: 180, rotation: 10, zIndex: 'a1' });
    expect(Object.hasOwn(store.getNode('a')!, 'parentId')).toBe(false);

    // 移出到根层级同样保持世界位姿
    store.redo();
    const inFrame = corner('a');
    store.reparentNodes(['a'], undefined);
    expect(store.getNode('a')!.parentId).toBeUndefined();
    expect(corner('a').x).toBeCloseTo(inFrame.x);
    expect(corner('a').y).toBeCloseTo(inFrame.y);
  });

  it('reparentNodes 拒绝改挂到自身后代 (成环)', () => {
    const engine = new SkyNoteEngine();
    const store = engine.documentStore;
    store.addNode(makeNode('outer'));
    store.addNode(makeNode('inner', { parentId: 'outer' }));
    const origError = console.error;
    console.error = () => {};
    try {
      expect(store.reparentNodes(['outer'], 'inner')).toBeNull();
    } finally {
      console.error = origError;
    }
    expect(store.getNode('outer')!.parentId).toBeUndefined();
  });
});

describe('变更集与派生状态', () => {
  it('容器移动：geometry 只含容器，worldGeometry 含全部后代；依附后代的连线路由随之更新', () => {
    const engine = new SkyNoteEngine();
    const store = engine.documentStore;
    store.addNode(makeNode('frame'));
    store.addNode(makeNode('card', { x: 10, y: 10, width: 20, height: 20, parentId: 'frame' }));
    store.addNode(makeNode('badge', { width: 4, height: 4, parentId: 'card' }));
    store.addNode(makeNode('outside', { x: 500 }));
    const connector: ConnectorEntity = {
      id: 'c1',
      type: 'connector',
      connectorType: 'straight',
      from: { nodeId: 'badge' },
      to: { nodeId: 'outside' },
      zIndex: 'a0',
      locked: false
    };
    store.commit({ patches: [{ op: 'set', path: ['content', 'connectors', 'c1'], value: connector }] });
    expect(engine.getConnectorRoute('c1')!.points[0]).toEqual({ x: 12, y: 12 });

    let changes: DocumentChangeSet | null = null;
    store.subscribe((_view, _record, c) => (changes = c));
    store.moveNodes(['frame'], { x: 100 });

    expect([...changes!.nodes.geometry]).toEqual(['frame']);
    expect([...changes!.nodes.worldGeometry].sort()).toEqual(['badge', 'card', 'frame']);
    expect(changes!.connectors.geometry.has('c1')).toBe(true);
    expect(engine.getConnectorRoute('c1')!.points[0]).toEqual({ x: 112, y: 12 });
  });

  it('远端删除容器而未删除子节点时，子节点回落到根层级，世界几何与空间索引随之更新', () => {
    const engine = new SkyNoteEngine();
    const store = engine.documentStore;
    store.addNode(makeNode('frame', { x: 100 }));
    store.addNode(makeNode('card', { x: 10, parentId: 'frame' }));
    expect(engine.spatialIndex.getBounds('card')!.left).toBe(110);

    store.commit({ origin: 'remote', patches: [{ op: 'unset', path: ['content', 'nodes', 'frame'] }] });
    expect(engine.entityStore.getWorldTransform('card')!.e).toBe(10);
    expect(engine.spatialIndex.getBounds('card')!.left).toBe(10);
  });
});

describe('变换节点 (transformNodes)', () => {
  it('世界外框换算为旋转容器内的局部坐标；只写有变化的字段，后代不产生补丁', () => {
    const engine = new SkyNoteEngine();
    const store = engine.documentStore;
    store.addNode(makeNode('frame', { x: 100, y: 100, width: 400, height: 300, rotation: 90 }));
    store.addNode(makeNode('card', { parentId: 'frame', x: 20, y: 30, width: 40, height: 20 }));
    store.addNode(makeNode('inner', { parentId: 'card', x: 5, y: 5, width: 10, height: 10 }));

    const before = computeWorldFrame(store.getNode('card')!, engine.entityStore.getWorldTransform('card')!);
    const record = store.transformNodes([{ id: 'card', frame: { ...before, width: 80 } }], { label: '缩放' })!;

    // 中心与朝向在世界中不变，局部坐标按容器旋转换算：宽度增加 40 → 局部 x 左移 20
    expect(store.getNode('card')).toMatchObject({ x: 0, y: 30, width: 80, height: 20, rotation: 0 });
    const after = computeWorldFrame(store.getNode('card')!, engine.entityStore.getWorldTransform('card')!);
    expect(after.cx).toBeCloseTo(before.cx);
    expect(after.cy).toBeCloseTo(before.cy);
    expect(record.patches.map((p) => (p.path as string[]).at(-1)).sort()).toEqual(['width', 'x']);

    // 同一事务写入节点类型给出的其他字段
    store.transformNodes([{ id: 'card', frame: after, fields: { style: { fill: '#ff0000' } } }]);
    expect(store.getNode('card')!.style).toEqual({ fill: '#ff0000' });
    engine.destroy();
  });
});

describe('尺寸面板与增量旋转 (resizeNodes / rotateNodes)', () => {
  it('resizeNodes 保持世界左上角不动 (含旋转节点)；比例锁定时只给一边另一边联动；一步撤销', () => {
    const engine = new SkyNoteEngine();
    const store = engine.documentStore;
    store.addNode(makeNode('a', { x: 100, y: 100, width: 100, height: 50, rotation: 30 }));
    store.addNode(makeNode('b', { x: 0, y: 0, width: 100, height: 50, aspectLocked: true }));
    const before = worldPoint(engine, 'a', 0, 0);

    store.resizeNodes(['a', 'b'], { width: 200 });
    expect(store.getNode('a')).toMatchObject({ width: 200, height: 50, rotation: 30 });
    const after = worldPoint(engine, 'a', 0, 0);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
    expect(store.getNode('b')).toMatchObject({ x: 0, y: 0, width: 200, height: 100 });

    store.undo();
    expect(store.getNode('a')).toMatchObject({ width: 100, height: 50 });
    expect(store.getNode('b')).toMatchObject({ width: 100, height: 50 });
  });

  it('rotateNodes 绕整体外接框中心旋转；只变换最顶层节点', () => {
    const engine = new SkyNoteEngine();
    const store = engine.documentStore;
    store.addNode(makeNode('l', { x: 0, y: 0 }));
    store.addNode(makeNode('r', { x: 200, y: 0 }));
    store.addNode(makeNode('child', { x: 10, y: 10, width: 10, height: 10, parentId: 'r' }));

    // 整体外接框 (0,0)-(300,100) 中心 (150, 50)；转 90° 后 l 的中心 (50,50) → (150,-50)
    const record = store.rotateNodes(['l', 'r', 'child'], 90)!;
    const l = computeWorldFrame(store.getNode('l')!, engine.entityStore.getWorldTransform('l')!);
    expect(l.cx).toBeCloseTo(150);
    expect(l.cy).toBeCloseTo(-50);
    expect(l.rotation).toBeCloseTo(90);
    expect(record.patches.some((p) => p.path.includes('child'))).toBe(false);
  });
});

describe('创建副本 (duplicateNodes)', () => {
  it('容器连同后代与内部连线一起复制，只偏移最顶层；外部连线不复制；一步撤销', () => {
    const engine = new SkyNoteEngine();
    const store = engine.documentStore;
    store.addNode(makeNode('frame', { x: 100, y: 100, width: 200, height: 200, rotation: 90 }));
    store.addNode(makeNode('a', { x: 10, y: 10, width: 20, height: 20, parentId: 'frame' }));
    store.addNode(makeNode('b', { x: 50, y: 50, width: 20, height: 20, parentId: 'frame' }));
    store.addNode(makeNode('outside', { x: 500, y: 0 }));
    const connector = (id: string, from: string, to: string): ConnectorEntity => ({
      id,
      type: 'connector',
      connectorType: 'default',
      from: { nodeId: from },
      to: { nodeId: to },
      zIndex: 'a0',
      locked: false,
      controlPoints: [{ x: 0, y: 0 }]
    });
    store.commit({
      patches: [
        { op: 'set', path: ['content', 'connectors', 'inner'], value: connector('inner', 'a', 'b') },
        { op: 'set', path: ['content', 'connectors', 'cross'], value: connector('cross', 'a', 'outside') }
      ]
    });
    const before = engine.getNodeWorldBounds('frame')!;

    const [copyId] = store.duplicateNodes(['frame', 'a'], { x: 20, y: 30 });
    const copy = store.getNode(copyId)!;
    const after = engine.getNodeWorldBounds(copyId)!;
    expect(after.left).toBeCloseTo(before.left + 20);
    expect(after.top).toBeCloseTo(before.top + 30);
    expect(copy.zIndex > store.getNode('outside')!.zIndex).toBe(true);

    const children = [...engine.entityStore.getChildIds(copyId)];
    expect(children).toHaveLength(2);
    expect(children.map((id) => store.getNode(id)!.x).sort()).toEqual([10, 50]);
    const connectors = Object.values(store.getView().content.connectors);
    expect(connectors).toHaveLength(3);
    const copied = connectors.find((c) => c.id !== 'inner' && c.id !== 'cross')!;
    expect(children).toContain(copied.from.nodeId);
    expect(children).toContain(copied.to.nodeId);
    expect(copied.controlPoints).toEqual([{ x: 20, y: 30 }]);

    store.undo();
    expect(store.getNode(copyId)).toBeUndefined();
    expect(Object.keys(store.getView().content.connectors)).toHaveLength(2);
  });
});
