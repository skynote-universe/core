/**
 * @file batch.test.ts
 * @description 批处理：多个语义操作合并为一步撤销、嵌套并入外层、异常整体撤回
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { DocumentStore } from '../src/state/document-store';
import type { NodeEntity } from '../src/types/node';

function makeNode(id: string, x = 0): NodeEntity {
  return {
    id,
    type: 'node',
    nodeType: 'rect',
    x,
    y: 0,
    width: 10,
    height: 10,
    rotation: 0,
    zIndex: 'a0',
    locked: false
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('DocumentStore.batch', () => {
  it('批内多个语义操作即时生效，并合并为一步撤销', () => {
    const store = new DocumentStore();
    store.addNode(makeNode('before'));

    store.batch(() => {
      store.addNode(makeNode('a'));
      // 后续操作能读到前序结果
      expect(store.getNode('a')).toBeDefined();
      store.moveEntities({ nodeIds: ['a'] }, { x: 50, y: 0 });
      store.updateNode('a', { width: 30 });
    }, '新建并调整');

    expect(store.getNode('a')).toMatchObject({ x: 50, width: 30 });
    expect(store.undoEntries.at(-1)!.label).toBe('新建并调整');

    store.undo();
    expect(store.getNode('a')).toBeUndefined();
    expect(store.getNode('before')).toBeDefined();
    store.redo();
    expect(store.getNode('a')).toMatchObject({ x: 50, width: 30 });
  });

  it('嵌套批处理并入最外层，批内拖拽的 groupId 不会拆出独立条目', () => {
    const store = new DocumentStore();
    store.batch(() => {
      store.addNode(makeNode('a'));
      store.batch(() => store.addNode(makeNode('b')));
      store.moveEntities({ nodeIds: ['a'] }, { x: 1, y: 0 }, { groupId: 'drag' });
      store.moveEntities({ nodeIds: ['a'] }, { x: 1, y: 0 }, { groupId: 'drag' });
    });
    expect(store.undoEntries).toHaveLength(1);
    store.undo();
    expect(store.getNode('a')).toBeUndefined();
    expect(store.getNode('b')).toBeUndefined();
  });

  it('fn 抛错时撤回本批已提交的改动，且不留下可重做条目', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = new DocumentStore();
    store.addNode(makeNode('before'));

    expect(() =>
      store.batch(() => {
        store.addNode(makeNode('a'));
        throw new Error('中途失败');
      })
    ).toThrow('中途失败');

    expect(store.getNode('a')).toBeUndefined();
    expect(store.getNode('before')).toBeDefined();
    expect(store.canRedo).toBe(false);
    expect(store.undoEntries).toHaveLength(1);

    // 批处理结束后恢复独立记录
    store.addNode(makeNode('c'));
    expect(store.undoEntries).toHaveLength(2);
  });
});
