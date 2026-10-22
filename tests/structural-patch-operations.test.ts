/** 字符串类型不等于可编辑文字；结构字段只接受明确的赋值与删除操作。 */
import { describe, expect, it } from 'vitest';
import { DocumentStore, createEmptyCanvasDocument } from '../src/state/document-store';
import { findCommitViolation } from '../src/state/commit-guards';
import type { CanvasPatch } from '../src/types/operation';

function setup(): DocumentStore {
  const doc = createEmptyCanvasDocument();
  for (const id of ['a', 'b', 'c'])
    doc.content.nodes[id] = {
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
      ...(id === 'a' ? { parentId: 'c' } : id === 'b' ? { parentId: 'a' } : {})
    };
  return new DocumentStore(doc);
}

describe('结构字段操作约束', () => {
  it.each(['text', 'splice'] as const)('%s 不能通过 parentId 路径绕过成环守卫', (op) => {
    const store = setup();
    const patch: CanvasPatch =
      op === 'text'
        ? { op, path: 'content.nodes.a.parentId', deltas: [{ delete: 1 }, { insert: 'b' }] }
        : { op, path: ['content', 'nodes', 'a', 'parentId'], index: 0, deleteCount: 1, items: ['b'] };
    const before = structuredClone(store.getView().content);
    expect(store.commit({ patches: [patch] })).toBeNull();
    expect(store.getView().content).toEqual(before);
    expect(store.canUndo).toBe(false);
  });

  it.each(['nodes', 'connectors'] as const)('%s 的 zIndex 不接受文字差量或数组操作', (kind) => {
    for (const op of ['text', 'splice'] as const) {
      const patch: CanvasPatch =
        op === 'text'
          ? { op, path: ['content', kind, 'a', 'zIndex'], deltas: [{ delete: 2 }, { insert: '非法' }] }
          : { op, path: ['content', kind, 'a', 'zIndex'], index: 0, deleteCount: 1 };
      expect(findCommitViolation(createEmptyCanvasDocument(), [patch])).toMatch(/zIndex 仅支持/);
    }
  });

  it('结构操作契约不因后续覆盖而放行文字补丁，普通文字不受影响', () => {
    const store = setup();
    expect(
      store.commit({
        patches: [
          { op: 'text', path: ['content', 'nodes', 'a', 'parentId'], deltas: [{ delete: 1 }, { insert: 'b' }] },
          { op: 'unset', path: ['content', 'nodes', 'a', 'parentId'] }
        ]
      })
    ).toBeNull();
    expect(store.commit({ patches: [{ op: 'text', path: ['name'], deltas: [{ insert: '新' }] }] })).not.toBeNull();
    expect(store.getView().name.startsWith('新')).toBe(true);
    expect(store.undo()).toBe(true);
    expect(store.getView().name.startsWith('新')).toBe(false);
  });

  it('合法 set/unset 改挂仍支持最终无环及撤销重做', () => {
    const store = setup();
    const before = structuredClone(store.getView().content);
    expect(
      store.commit({
        patches: [
          { op: 'set', path: ['content', 'nodes', 'a', 'parentId'], value: 'b' },
          { op: 'unset', path: ['content', 'nodes', 'b', 'parentId'] }
        ]
      })
    ).not.toBeNull();
    const after = structuredClone(store.getView().content);
    store.undo();
    expect(store.getView().content).toEqual(before);
    store.redo();
    expect(store.getView().content).toEqual(after);
  });
});
