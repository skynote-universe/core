/** 连续旋转只对起始连线几何取绝对变换，持久化整数不参与下一帧累计。 */
import { describe, expect, it } from 'vitest';
import { SkyNoteEngine } from '../src/engine';
import { computeWorldFrame } from '../src/utils/geometry';
import type { NodeEntity } from '../src/types/node';
import type { NodeConnectorTransformSnapshot, NodeTransform } from '../src/state/document-store';

function node(id: string, patch: Partial<NodeEntity> = {}): NodeEntity {
  return {
    id,
    type: 'node',
    nodeType: 'frame',
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

function snapshot(engine: SkyNoteEngine, id: string): NodeConnectorTransformSnapshot {
  const nodeIds = [id, ...engine.entityStore.collectDescendantIds(id)];
  return {
    frame: computeWorldFrame(engine.documentStore.getNode(id)!, engine.entityStore.getWorldTransform(id)!),
    nodeIds,
    controlPoints: new Map(
      Object.values(engine.documentStore.getView().content.connectors)
        .filter((c) => nodeIds.includes(c.from.nodeId!) && nodeIds.includes(c.to.nodeId!))
        .map((c) => [c.id, c.controlPoints?.map((point) => ({ ...point }))])
    )
  };
}

describe('旋转连线起始几何', () => {
  it('捕获排除独立子目标子树，其内部及跨作用域连线不被父目标认领', () => {
    const engine = new SkyNoteEngine();
    const store = engine.documentStore;
    for (const n of [
      node('f'),
      node('c', { parentId: 'f' }),
      node('a', { parentId: 'c' }),
      node('b', { parentId: 'c' }),
      node('outside', { parentId: 'f' })
    ])
      store.addNode(n);
    const internal = store.createConnector({ from: { nodeId: 'a' }, to: { nodeId: 'b' } })!;
    const crossing = store.createConnector({ from: { nodeId: 'a' }, to: { nodeId: 'outside' } })!;
    store.updateConnector(internal, { controlPoints: [{ x: 10, y: 20 }] });
    const excluded = new Set(['f', 'c']);
    const frame = computeWorldFrame(store.getNode('f')!, engine.entityStore.getWorldTransform('f')!);
    const parent = store.captureConnectorTransformSnapshot(['f'], frame, excluded);
    const child = store.captureConnectorTransformSnapshot(['c'], frame, excluded);
    expect(parent.nodeIds).toEqual(['f', 'outside']);
    expect(parent.controlPoints.size).toBe(0);
    expect(child.nodeIds).toEqual(['c', 'a', 'b']);
    expect(child.controlPoints.get(internal)).toEqual([{ x: 10, y: 20 }]);
    expect(child.controlPoints.has(crossing)).toBe(false);
    store.updateConnector(internal, { controlPoints: [{ x: 30, y: 40 }] });
    expect(child.controlPoints.get(internal)).toEqual([{ x: 10, y: 20 }]);
    const full = store.captureConnectorTransformSnapshot(['f'], frame);
    expect(full.nodeIds).toHaveLength(5);
    expect(full.controlPoints.has(crossing)).toBe(true);
    engine.destroy();
  });

  it('90 次细步旋转、往返和单步撤销重做均无累计误差', () => {
    const engine = new SkyNoteEngine();
    const store = engine.documentStore;
    store.addNode(node('f'));
    store.addNode(node('a', { parentId: 'f', width: 10, height: 10 }));
    store.addNode(node('b', { parentId: 'f', x: 80, width: 10, height: 10 }));
    const link = store.createConnector({ from: { nodeId: 'a' }, to: { nodeId: 'b' } })!;
    store.updateConnector(link, { controlPoints: [{ x: 60, y: 50 }] });
    const source = snapshot(engine, 'f');
    const before = structuredClone(store.getView().content);
    store.clearHistory();
    const rotate = (rotation: number): void => {
      store.transformNodes([{ id: 'f', frame: { ...source.frame, rotation }, connectorSnapshot: source }], {
        groupId: 'rotate'
      });
      expect(store.getConnector(link)!.controlPoints).toEqual([
        {
          x: Math.round(50 + 10 * Math.cos((rotation * Math.PI) / 180)),
          y: Math.round(50 + 10 * Math.sin((rotation * Math.PI) / 180))
        }
      ]);
    };
    for (let i = 1; i <= 90; i++) rotate(i);
    const after = structuredClone(store.getView().content);
    store.undo();
    expect(store.getView().content).toEqual(before);
    expect(store.canUndo).toBe(false);
    store.redo();
    expect(store.getView().content).toEqual(after);
    for (let i = 89; i >= 0; i--) rotate(i);
    expect(store.getView().content).toEqual(before);
    expect(source.controlPoints.get(link)).toEqual([{ x: 60, y: 50 }]);
    engine.destroy();
  });

  it.each([false, true])('独立父子目标仍按各自起始连线几何处理，反序=%s', (reverse) => {
    const engine = new SkyNoteEngine();
    const store = engine.documentStore;
    store.addNode(node('f'));
    store.addNode(node('c', { parentId: 'f', width: 50, height: 50 }));
    store.addNode(node('a', { parentId: 'c', width: 10, height: 10 }));
    store.addNode(node('b', { parentId: 'c', x: 30, width: 10, height: 10 }));
    const link = store.createConnector({ from: { nodeId: 'a' }, to: { nodeId: 'b' } })!;
    store.updateConnector(link, { controlPoints: [{ x: 20, y: 5 }] });
    const transforms: NodeTransform[] = [
      {
        id: 'f',
        frame: { cx: 50, cy: 50, width: 100, height: 100, rotation: 90 },
        connectorSnapshot: snapshot(engine, 'f')
      },
      {
        id: 'c',
        frame: { cx: 55, cy: 25, width: 50, height: 50, rotation: 0 },
        connectorSnapshot: snapshot(engine, 'c')
      }
    ];
    store.transformNodes(reverse ? transforms.reverse() : transforms);
    expect(store.getConnector(link)!.controlPoints).toEqual([{ x: 50, y: 5 }]);
    engine.destroy();
  });

  it('100个共同目标只遍历一次共享成员，不因根数量重复扫描', () => {
    const engine = new SkyNoteEngine();
    const store = engine.documentStore;
    for (let i = 0; i < 100; i++) store.addNode(node(`n${i}`, { x: i * 100 }));
    const ids = Array.from({ length: 100 }, (_, i) => `n${i}`);
    const source = store.captureConnectorTransformSnapshot(ids, {
      cx: 5000,
      cy: 50,
      width: 10000,
      height: 100,
      rotation: 0
    });
    let iterations = 0;
    source.nodeIds = new Proxy([...source.nodeIds], {
      get(target, key) {
        if (key === Symbol.iterator) iterations++;
        return Reflect.get(target, key);
      }
    });
    const connectorTransform = { snapshot: source, matrix: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 } };
    store.clearHistory();
    expect(
      store.transformNodes(
        ids.map((id) => ({
          id,
          frame: computeWorldFrame(store.getNode(id)!, engine.entityStore.getWorldTransform(id)!),
          connectorTransform
        }))
      )
    ).toBeNull();
    expect(iterations).toBeLessThanOrEqual(2);
    expect(store.canUndo).toBe(false);
    engine.destroy();
  });

  it('同一共享快照声明冲突矩阵时整体拒绝，不产生部分写入', () => {
    const engine = new SkyNoteEngine();
    const store = engine.documentStore;
    store.addNode(node('a'));
    store.addNode(node('b', { x: 200 }));
    const source = store.captureConnectorTransformSnapshot(['a', 'b'], {
      cx: 150,
      cy: 50,
      width: 300,
      height: 100,
      rotation: 0
    });
    const before = structuredClone(store.getView().content);
    store.clearHistory();
    expect(
      store.transformNodes(
        ['a', 'b'].map((id, i) => ({
          id,
          frame: { ...computeWorldFrame(store.getNode(id)!, engine.entityStore.getWorldTransform(id)!), rotation: 90 },
          connectorTransform: { snapshot: source, matrix: { a: 0, b: 1, c: -1, d: 0, e: i * 10, f: 0 } }
        }))
      )
    ).toBeNull();
    expect(store.getView().content).toEqual(before);
    expect(store.canUndo).toBe(false);
    engine.destroy();
  });
});
