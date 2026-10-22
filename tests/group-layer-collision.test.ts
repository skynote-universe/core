/** 合法重复层级键按 id 决胜，成组必须保持该顺序并可精确撤销。 */
import { describe, expect, it } from 'vitest';
import { DocumentStore, createEmptyCanvasDocument } from '../src/state/document-store';
import { sortSiblingsByLayer } from '../src/layout/layer-order';

describe('成组层级键冲突', () => {
  it.each([false, true])('同键成组保留上方兄弟，嵌套=%s', (nested) => {
    const doc = createEmptyCanvasDocument();
    const base = {
      type: 'node' as const,
      nodeType: 'shape',
      x: 0,
      y: 0,
      width: 50,
      height: 50,
      rotation: 0,
      zIndex: 'a0',
      locked: false
    };
    if (nested) doc.content.nodes.p = { ...base, id: 'p', nodeType: 'frame', width: 500, height: 400 };
    for (const [id, x] of [
      ['a', 0],
      ['b', 60],
      ['c', 120]
    ] as const)
      doc.content.nodes[id] = { ...base, id, x, ...(nested ? { parentId: 'p' } : {}) };
    const store = new DocumentStore(doc);
    const before = structuredClone(store.getView().content);
    const group = store.groupNodes(['a', 'b'])!;
    expect(group).toBeTypeOf('string');
    const siblings = [...store.entityStore.getChildIds(nested ? 'p' : undefined)].map((id) => store.getNode(id)!);
    expect(sortSiblingsByLayer(siblings).map((node) => node.id)).toEqual([group, 'c']);
    const after = structuredClone(store.getView().content);
    store.undo();
    expect(store.getView().content).toEqual(before);
    expect(store.canUndo).toBe(false);
    store.redo();
    expect(store.getView().content).toEqual(after);
  });

  it('正常索引不重编号无关兄弟', () => {
    const store = new DocumentStore();
    for (const [id, zIndex] of [
      ['a', 'a0'],
      ['b', 'a1'],
      ['c', 'a2']
    ] as const)
      store.addNode({
        id,
        type: 'node',
        nodeType: 'shape',
        x: 0,
        y: 0,
        width: 50,
        height: 50,
        rotation: 0,
        zIndex,
        locked: false
      });
    const before = structuredClone(store.getNode('c'));
    expect(store.groupNodes(['a', 'b'])).not.toBeNull();
    expect(store.getNode('c')).toEqual(before);
  });
});
