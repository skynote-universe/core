/**
 * @file layer-order.test.ts
 * @description 层级调整：按列表顺序移动、只改被移动节点、多选保序、按容器分组、键冲突容错、索引校验与整理
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DocumentStore } from '../src/state/document-store';
import { sortSiblingsByLayer } from '../src/layout/layer-order';
import type { NodeEntity } from '../src/types/node';

function makeNode(id: string, zIndex: string, parentId?: string): NodeEntity {
  return {
    id,
    type: 'node',
    nodeType: 'rect',
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    rotation: 0,
    zIndex,
    locked: false,
    parentId
  };
}

/** 读取某容器内自下而上的顺序 */
function layerOrder(store: DocumentStore, parentId?: string): string[] {
  const nodes = store.getView().content.nodes;
  return sortSiblingsByLayer([...store.entityStore.getChildIds(parentId)].map((id) => nodes[id] as NodeEntity)).map(
    (node) => node.id
  );
}

function createStore(): DocumentStore {
  const store = new DocumentStore();
  for (const [id, key] of [
    ['A', 'a0'],
    ['B', 'a1'],
    ['C', 'a2'],
    ['D', 'a3']
  ]) {
    store.addNode(makeNode(id, key));
  }
  return store;
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('层级调整', () => {
  it('上移一层 / 下移一层 / 置顶 / 置底 按列表顺序移动，且只改被移动节点的索引', () => {
    const store = createStore();

    const forward = store.moveLayers(['B'], 'forward')!;
    expect(layerOrder(store)).toEqual(['A', 'C', 'B', 'D']);
    expect(forward.patches.map((p) => p.path)).toEqual([['content', 'nodes', 'B', 'zIndex']]);

    store.moveLayers(['B'], 'backward');
    expect(layerOrder(store)).toEqual(['A', 'B', 'C', 'D']);

    store.moveLayers(['A'], 'front');
    expect(layerOrder(store)).toEqual(['B', 'C', 'D', 'A']);

    store.moveLayers(['A'], 'back');
    expect(layerOrder(store)).toEqual(['A', 'B', 'C', 'D']);
  });

  it('已在最上层时上移 / 置顶不产生事务，撤销一步还原', () => {
    const store = createStore();
    expect(store.moveLayers(['D'], 'forward')).toBeNull();
    expect(store.moveLayers(['D'], 'front')).toBeNull();

    store.moveLayers(['A'], 'front');
    store.undo();
    expect(layerOrder(store)).toEqual(['A', 'B', 'C', 'D']);
  });

  it('多选保持相对顺序：连续块整体上移一格，分散选中各自上移', () => {
    const store = createStore();
    store.moveLayers(['A', 'B'], 'forward');
    expect(layerOrder(store)).toEqual(['C', 'A', 'B', 'D']);

    const scattered = createStore();
    scattered.moveLayers(['A', 'C'], 'forward');
    expect(layerOrder(scattered)).toEqual(['B', 'A', 'D', 'C']);

    const toFront = createStore();
    toFront.moveLayers(['C', 'A'], 'front');
    expect(layerOrder(toFront)).toEqual(['B', 'D', 'A', 'C']);
  });

  it('按容器分组：只在同一 parentId 的兄弟之间移动，不越出容器', () => {
    const store = createStore();
    store.addNode(makeNode('child1', 'a0', 'A'));
    store.addNode(makeNode('child2', 'a1', 'A'));

    store.moveLayers(['child1', 'B'], 'front');
    expect(layerOrder(store, 'A')).toEqual(['child2', 'child1']);
    expect(layerOrder(store)).toEqual(['A', 'C', 'D', 'B']);
  });

  it('createTopZIndex 生成容器内的最上层索引', () => {
    const store = createStore();
    store.addNode(makeNode('E', store.createTopZIndex()));
    expect(layerOrder(store).at(-1)).toBe('E');
    expect(store.createTopZIndex('A')).toBe('a0');
  });

  it('键相同 (并发写入) 时仍能移动：退化为整组重新编号', () => {
    const store = new DocumentStore();
    for (const id of ['A', 'B', 'C']) store.addNode(makeNode(id, 'a1'));
    expect(layerOrder(store)).toEqual(['A', 'B', 'C']);

    store.moveLayers(['A'], 'forward');
    expect(layerOrder(store)).toEqual(['B', 'A', 'C']);
    const keys = layerOrder(store).map((id) => store.getNode(id)!.zIndex);
    expect(new Set(keys).size).toBe(3);
  });

  it('提交入口拒绝非法 zIndex (数字、非法字符、尾随 0)', () => {
    const store = createStore();
    expect(store.updateNode('A', { zIndex: 3 as unknown as string })).toBeNull();
    expect(store.updateNode('A', { zIndex: 'a1!' })).toBeNull();
    expect(store.addNode(makeNode('E', 'a10'))).toBeNull();
    expect(store.getNode('A')?.zIndex).toBe('a0');
  });

  it('renumberLayers 整理过长索引且画面顺序不变', () => {
    const store = createStore();
    for (let i = 0; i < 40; i++) {
      store.moveLayers(['B'], i % 2 === 0 ? 'forward' : 'backward');
    }
    const before = layerOrder(store);
    store.renumberLayers();
    expect(layerOrder(store)).toEqual(before);
    expect(before.every((id) => store.getNode(id)!.zIndex.length <= 2)).toBe(true);
  });
});
