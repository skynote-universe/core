/** 连线必须跟随实际变换成员，不能按逻辑组合全子树提前认领。 */
import { describe, expect, it } from 'vitest';
import { DocumentStore, createEmptyCanvasDocument } from '../src/state/document-store';
import type { NodeEntity } from '../src/types/node';
import type { NodeTransform } from '../src/state/document-store';

function setup() {
  const doc = createEmptyCanvasDocument();
  const add = (id: string, patch: Partial<NodeEntity>) => {
    doc.content.nodes[id] = {
      id,
      type: 'node',
      nodeType: 'shape',
      x: 0,
      y: 0,
      width: 50,
      height: 50,
      rotation: 0,
      zIndex: 'a0',
      locked: false,
      ...patch
    };
  };
  add('g', { nodeType: 'group', width: 200 });
  add('a', { parentId: 'g', locked: true });
  add('b', { parentId: 'g', x: 75, locked: true, zIndex: 'a1' });
  add('c', { parentId: 'g', x: 150, zIndex: 'a2' });
  const store = new DocumentStore(doc);
  const link = (a: string, b: string) => {
    const id = store.createConnector({ from: { nodeId: a }, to: { nodeId: b } })!;
    store.updateConnector(id, {
      controlPoints: [{ x: 60, y: 25 }],
      textBlocks: [{ id: 'label', position: 0.5, style: { fontSize: 18 }, runs: [{ text: '标注' }] }]
    });
    return id;
  };
  return { store, link };
}

describe('连线实际变换作用域', () => {
  it('全部叶子锁定时不提供缩放，也不产生空通知或历史', () => {
    const { store } = setup();
    store.updateNode('c', { locked: true });
    store.clearHistory();
    let notices = 0;
    const off = store.subscribe(() => {
      notices++;
    });
    expect(store.getNodeResizePolicy('g').axes).toBe('none');
    expect(store.resizeNodes(['g'], { width: 400, height: 100 })).toBeNull();
    expect(
      store.transformNodes([{ id: 'g', frame: { cx: 200, cy: 50, width: 400, height: 100, rotation: 0 } }])
    ).toBeNull();
    expect(notices).toBe(0);
    expect(store.canUndo).toBe(false);
    off();
  });

  it('含排除成员的逻辑组合不替自身边界连线认领统一矩阵', () => {
    const { store, link } = setup();
    store.updateNode('a', { width: 150, height: 100 });
    const id = link('g', 'c');
    const before = structuredClone(store.getConnector(id));
    store.resizeNodes(['g'], { width: 400, height: 200 });
    expect(store.getNode('g')!.height).toBe(100);
    expect(store.getConnector(id)).toEqual(before);
  });

  it('容器整体缩放不覆盖独立显式子节点的尺寸和文字', () => {
    const { store } = setup();
    store.updateNode('g', { nodeType: 'frame' });
    store.updateNode('a', { locked: false, textBlocks: [{ id: 'body', runs: [{ text: '独立文字', fontSize: 18 }] }] });
    const text = structuredClone(store.getNode('a')!.textBlocks);
    store.transformNodes([
      { id: 'g', frame: { cx: 200, cy: 50, width: 400, height: 100, rotation: 0 }, scaleContents: true },
      { id: 'a', frame: { cx: 25, cy: 25, width: 50, height: 50, rotation: 0 } }
    ]);
    expect(store.getNode('a')!.width).toBe(50);
    expect(store.getNode('a')!.textBlocks).toEqual(text);
    expect(store.getNode('b')!.width).toBe(100);
  });

  it('锁定叶子之间及跨锁定/活动成员的连线保持原样，撤销重做一致', () => {
    const { store, link } = setup();
    const locked = link('a', 'b');
    const mixed = link('b', 'c');
    const before = structuredClone(store.getView().content);
    store.clearHistory();
    store.resizeNodes(['g'], { width: 400, height: 100 });
    expect(store.getNode('a')).toEqual(before.nodes.a);
    expect(store.getNode('b')).toEqual(before.nodes.b);
    expect(store.getNode('c')!.width).toBe(100);
    expect(store.getConnector(locked)).toEqual(before.connectors[locked]);
    expect(store.getConnector(mixed)).toEqual(before.connectors[mixed]);
    const after = structuredClone(store.getView().content);
    store.undo();
    expect(store.getView().content).toEqual(before);
    store.redo();
    expect(store.getView().content).toEqual(after);
  });

  it('锁定子组合的全部后代连线也排除', () => {
    const { store, link } = setup();
    store.updateNodes(['a', 'b'], { locked: false });
    const nested = store.groupNodes(['a', 'b'])!;
    store.updateNode(nested, { locked: true });
    const id = link('a', 'b');
    const before = structuredClone(store.getConnector(id));
    store.resizeNodes(['g'], { width: 400, height: 100 });
    expect(store.getConnector(id)).toEqual(before);
  });

  it.each([false, true])('独立容器采用自身倍率且不受输入顺序影响，反序=%s', (reverse) => {
    const { store, link } = setup();
    store.nodeTypes.register({
      type: 'frame',
      label: '容器',
      defaultData: {},
      supportsContentScale: true,
      compose: () => []
    });
    store.addNode({
      id: 'f',
      type: 'node',
      nodeType: 'frame',
      parentId: 'g',
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      rotation: 0,
      zIndex: 'a0',
      locked: false
    });
    store.updateNode('a', { parentId: 'f', locked: false, width: 10, height: 10 });
    store.updateNode('b', { parentId: 'f', locked: false, width: 10, height: 10, x: 50 });
    const id = link('a', 'b');
    const transforms: NodeTransform[] = [
      { id: 'g', frame: { cx: 200, cy: 100, width: 400, height: 200, rotation: 0 } },
      { id: 'f', frame: { cx: 150, cy: 150, width: 300, height: 300, rotation: 0 }, scaleContents: true }
    ];
    const before = structuredClone(store.getView().content);
    store.clearHistory();
    store.transformNodes(reverse ? transforms.reverse() : transforms);
    expect(store.getNode('a')!.width).toBe(30);
    expect(store.getConnector(id)!.controlPoints).toEqual([{ x: 180, y: 75 }]);
    expect(store.getConnector(id)!.textBlocks![0].style!.fontSize).toBe(54);
    store.undo();
    expect(store.getView().content).toEqual(before);
  });
});
