/** Group 公开策略和实际变换共用的叶子遍历及失效广播均需支持深链。 */
import { expect, it, vi } from 'vitest';
import { DocumentStore, createEmptyCanvasDocument } from '../src/state/document-store';

function setup(depth: number): DocumentStore {
  const doc = createEmptyCanvasDocument();
  for (let i = 0; i <= depth; i++)
    doc.content.nodes[`n${i}`] = {
      id: `n${i}`,
      type: 'node',
      nodeType: i === depth ? 'shape' : 'group',
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      rotation: 0,
      zIndex: 'a0',
      locked: false,
      ...(i ? { parentId: `n${i - 1}` } : {})
    };
  return new DocumentStore(doc);
}

it('400 层 Group 自底向上派生后的世界失效只遍历子树并集', () => {
  const depth = 400;
  const store = setup(depth);
  const spy = vi.spyOn(store.entityStore, 'getChildIds');
  store.resizeNodes(['n0'], { width: 200, height: 200 });
  const calls = spy.mock.calls.length;
  spy.mockRestore();
  console.info('deep Group child queries', calls);
  expect(calls).toBeLessThan(depth * 20);
});

it('6000 层 Group 的公开策略、实际缩放及撤销重做不占调用栈', () => {
  const store = setup(6000);
  expect(store.getNodeResizePolicy('n0')).toMatchObject({ behavior: 'scale-contents', axes: 'both' });
  const before = structuredClone(store.getView().content);
  store.resizeNodes(['n0'], { width: 200, height: 200 });
  expect(store.getNode('n6000')!.width).toBe(200);
  expect(store.getNode('n0')!.width).toBe(200);
  store.undo();
  expect(store.getView().content).toEqual(before);
  store.redo();
  expect(store.getNode('n6000')!.width).toBe(200);
});

it('迭代叶子收集保持深度优先顺序，排除锁定子树及显式目标', () => {
  const doc = createEmptyCanvasDocument();
  for (const [id, parentId, nodeType, x, locked] of [
    ['root', undefined, 'group', 0, false],
    ['a', 'root', 'shape', 0, false],
    ['inner', 'root', 'group', 20, false],
    ['b', 'inner', 'shape', 0, false],
    ['locked', 'root', 'group', 40, true],
    ['hidden', 'locked', 'shape', 0, false],
    ['c', 'root', 'shape', 60, false]
  ] as const)
    doc.content.nodes[id] = {
      id,
      type: 'node',
      nodeType,
      x,
      y: 0,
      width: 10,
      height: 10,
      rotation: 0,
      zIndex: 'a0',
      locked,
      ...(parentId ? { parentId } : {})
    };
  const store = new DocumentStore(doc);
  const order: string[] = [];
  store.nodeTypes.register({
    type: 'shape',
    label: '叶子',
    defaultData: {},
    compose: () => [],
    applyContentScale(node) {
      order.push(node.id);
      return {};
    }
  });
  store.transformNodes([
    { id: 'root', frame: { cx: 10, cy: 10, width: 20, height: 20, rotation: 0 } },
    { id: 'a', frame: { cx: 5, cy: 5, width: 10, height: 10, rotation: 0 } }
  ]);
  expect(order).toEqual(['b', 'c']);
  expect(store.getNode('hidden')!.width).toBe(10);
  expect(store.getNode('a')!.width).toBe(10);
});
