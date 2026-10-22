/** 显式世界目标按同一事务最终父坐标换算，输入顺序和内容缩放不能改变结果。 */
import { describe, expect, it } from 'vitest';
import { SkyNoteEngine } from '../src/engine';
import { computeWorldFrame } from '../src/utils/geometry';
import type { NodeEntity } from '../src/types/node';
import type { NodeScaleSnapshot, NodeTransform } from '../src/state/document-store';

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

describe('最终父坐标几何规划', () => {
  it.each([
    [false, false, 0],
    [true, false, 0],
    [false, true, 0],
    [true, true, 0],
    [false, false, 90],
    [true, false, 90],
    [false, true, 90],
    [true, true, 90]
  ])('显式子节点世界目标保持，反序=%s、隔代=%s、旋转=%s', (reverse, indirect, rotation) => {
    const engine = new SkyNoteEngine();
    const store = engine.documentStore;
    store.addNode(node('f'));
    if (indirect) store.addNode(node('m', { parentId: 'f', x: 20, width: 20, height: 20 }));
    store.addNode(node('c', { parentId: indirect ? 'm' : 'f', x: 10, width: 10, height: 10 }));
    const before = structuredClone(store.getView().content);
    store.clearHistory();
    const transforms: NodeTransform[] = [
      { id: 'f', frame: { cx: 200, cy: 100, width: 200, height: 200, rotation }, scaleContents: true },
      { id: 'c', frame: { cx: 35, cy: 5, width: 10, height: 10, rotation: 0 } }
    ];
    store.transformNodes(reverse ? transforms.reverse() : transforms);
    const actual = computeWorldFrame(store.getNode('c')!, engine.entityStore.getWorldTransform('c')!);
    expect(actual.cx).toBeCloseTo(35);
    expect(actual.cy).toBeCloseTo(5);
    expect(actual.rotation).toBeCloseTo(0);
    expect(actual.width).toBe(10);
    if (indirect) expect(store.getNode('m')!.x).toBe(40);
    for (const item of Object.values(store.getView().content.nodes))
      for (const key of ['x', 'y', 'width', 'height', 'rotation'] as const)
        expect(Number.isInteger(item[key])).toBe(true);
    const after = structuredClone(store.getView().content);
    expect(store.undo()).toBe(true);
    expect(store.getView().content).toEqual(before);
    expect(store.redo()).toBe(true);
    expect(store.getView().content).toEqual(after);
  });

  it.each([false, true])('只调外框保留普通子节点，但不覆盖显式子目标，反序=%s', (reverse) => {
    const engine = new SkyNoteEngine();
    const store = engine.documentStore;
    store.addNode(node('f'));
    store.addNode(node('c', { parentId: 'f', x: 10, width: 10, height: 10 }));
    store.addNode(node('d', { parentId: 'f', x: 60, width: 10, height: 10 }));
    const snapshot: NodeScaleSnapshot = {
      nodes: new Map(
        ['f', 'c', 'd'].map((id) => {
          const item = structuredClone(store.getNode(id)!);
          return [id, { node: item, frame: computeWorldFrame(item, engine.entityStore.getWorldTransform(id)!) }];
        })
      ),
      connectors: new Map()
    };
    const transforms: NodeTransform[] = [
      {
        id: 'f',
        frame: { cx: 200, cy: 100, width: 200, height: 200, rotation: 0 },
        preserveContents: true,
        scaleSnapshot: snapshot
      },
      { id: 'c', frame: { cx: 35, cy: 5, width: 10, height: 10, rotation: 0 } }
    ];
    store.transformNodes(reverse ? transforms.reverse() : transforms);
    expect(engine.entityStore.getWorldTransform('c')!.e).toBe(30);
    expect(engine.entityStore.getWorldTransform('d')!.e).toBe(60);
  });

  it.each([false, true])('平移父容器不提前认领独立子容器的连线，反序=%s', (reverse) => {
    const engine = new SkyNoteEngine();
    const store = engine.documentStore;
    store.addNode(node('f'));
    store.addNode(node('c', { parentId: 'f', width: 50, height: 50 }));
    store.addNode(node('a', { parentId: 'c', width: 10, height: 10 }));
    store.addNode(node('b', { parentId: 'c', x: 30, width: 10, height: 10 }));
    const link = store.createConnector({ from: { nodeId: 'a' }, to: { nodeId: 'b' } })!;
    store.updateConnector(link, { controlPoints: [{ x: 20, y: 5 }] });
    const transforms: NodeTransform[] = [
      { id: 'f', frame: { cx: 150, cy: 50, width: 100, height: 100, rotation: 0 } },
      { id: 'c', frame: { cx: 55, cy: 25, width: 50, height: 50, rotation: 0 } }
    ];
    store.transformNodes(reverse ? transforms.reverse() : transforms);
    expect(engine.entityStore.getWorldTransform('c')!.e).toBe(30);
    expect(store.getConnector(link)!.controlPoints).toEqual([{ x: 50, y: 5 }]);
  });
});
