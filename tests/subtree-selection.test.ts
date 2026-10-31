import { describe, expect, it, vi } from 'vitest';
import { SkyNoteEngine } from '../src/engine';
import { SessionStore } from '../src/state/session-store';
import type { NodeEntity } from '../src/types/node';

function node(id: string, x: number, y: number, extra: Partial<NodeEntity> = {}): NodeEntity {
  return {
    id,
    type: 'node',
    nodeType: 'shape',
    x,
    y,
    width: 40,
    height: 20,
    rotation: 0,
    locked: false,
    zIndex: 'a1',
    ...extra
  };
}
function setup() {
  const engine = new SkyNoteEngine();
  engine.layouts.register({ id: 'composite', label: '整体布局', selectableSubtree: true, arrange: () => new Map() });
  const store = engine.documentStore;
  store.addNode(node('root', 100, 100, { layout: { type: 'composite' } }));
  store.addNode(node('child', -80, 60, { parentId: 'root', layoutItem: {} }));
  store.addNode(node('other', 400, 0));
  store.clearHistory();
  return { engine, store, geometry: store.selectionGeometry };
}

describe('整体选区', () => {
  it('相同根ID切换范围仍通知，普通节点选择清除范围，部分更新和删除保留其他范围', () => {
    const session = new SessionStore();
    session.setSelection({ nodeIds: ['root', 'other'], subtreeNodeIds: ['root', 'missing'] });
    expect([...session.selectedSubtreeNodeIds]).toEqual(['root']);
    const listener = vi.fn();
    session.subscribe(listener);
    session.setSelection({ subtreeNodeIds: [] });
    expect(listener.mock.calls[0][0].toggledNodeIds.size).toBe(0);
    expect(listener.mock.calls[0][0].selectionScopeChanged).toBe(true);
    session.setSelection({ subtreeNodeIds: ['root'] });
    session.setSelection({ connectorIds: ['line'] });
    session.pruneSelection(new Set(['other']), new Set());
    expect([...session.selectedSubtreeNodeIds]).toEqual(['root']);
    session.setSelection({ nodeIds: ['root'] });
    expect(session.selectedSubtreeNodeIds.size).toBe(0);
    session.setSelection({ subtreeNodeIds: ['root'] });
    session.setReadOnly(true);
    expect(session.selectedSubtreeNodeIds.size).toBe(0);
  });

  it('子树外框缓存复用，后代变宽、移动、换父、删除及撤销使范围同步更新', () => {
    const { engine, store, geometry } = setup();
    try {
      const initial = geometry.getSubtreeBounds('root')!;
      expect(Object.isFrozen(initial)).toBe(true);
      expect(initial).toEqual({ left: 20, top: 100, right: 140, bottom: 180 });
      expect(geometry.getSubtreeBounds('root')).toBe(initial);
      store.updateNode('child', { width: 300 });
      expect(geometry.getSubtreeBounds('root')!.right).toBe(320);
      store.updateNode('child', { parentId: undefined, layoutItem: undefined });
      expect(geometry.getSubtreeBounds('root')).toEqual({ left: 100, top: 100, right: 140, bottom: 120 });
      store.undo();
      expect(geometry.getSubtreeBounds('root')!.right).toBe(320);
      store.removeEntities({ nodeIds: ['child'] });
      expect(geometry.getSubtreeBounds('root')!.bottom).toBe(120);
    } finally {
      engine.destroy();
    }
  });

  it('排列按整体外框计算，移动根及内部节点一次，作用域不写入历史', () => {
    const { engine, store, geometry } = setup();
    try {
      const before = structuredClone(store.getView().content);
      const record = store.alignNodes(['root', 'child', 'other'], 'left', { subtreeNodeIds: new Set(['root']) })!;
      expect(record).not.toBeNull();
      expect(geometry.getSubtreeBounds('root')!.left).toBe(20);
      expect(store.getNode('other')!.x).toBe(20);
      expect(store.getNode('child')!.x).toBe(-80);
      expect(JSON.stringify(record)).not.toContain('subtreeNodeIds');
      store.undo();
      expect(store.getView().content).toEqual(before);
      store.alignNodes(['root', 'other'], 'left');
      expect(store.getNode('other')!.x).toBe(100);
    } finally {
      engine.destroy();
    }
  });

  it('根布局取消或卸载后退出整体选中，不制造文档状态', () => {
    const { engine, store, geometry } = setup();
    try {
      engine.session.setSelection({ nodeIds: ['root'], subtreeNodeIds: ['root'] });
      expect(geometry.hitTestSubtree({ x: 80, y: 140 })).toBe('root');
      store.updateNode('root', { layout: undefined });
      expect(engine.session.selectedSubtreeNodeIds.size).toBe(0);
      expect(geometry.canSelectSubtree('root')).toBe(false);
      expect(engine.entityStore.getLayoutRootIds().has('root')).toBe(false);
      store.undo();
      engine.session.setSelection({ nodeIds: ['root'], subtreeNodeIds: ['root'] });
      engine.layouts.unregister(engine.layouts.get('composite')!);
      expect(engine.session.selectedSubtreeNodeIds.size).toBe(0);
    } finally {
      engine.destroy();
    }
  });

  it('等距和自动排列把整图作为一个外框，成员不重复移动', () => {
    const { engine, store, geometry } = setup();
    try {
      store.addNode(node('last', 1000, 250));
      const options = { subtreeNodeIds: new Set(['root']) };
      store.distributeNodes(['root', 'child', 'other', 'last'], 'horizontal', options);
      expect(store.getNode('other')!.x).toBe(550);
      expect(geometry.getSubtreeBounds('root')!.left).toBe(20);
      store.undo();
      store.autoArrangeNodes(['root', 'child', 'other', 'last'], {}, options);
      expect(geometry.getSubtreeBounds('root')).toMatchObject({ left: 80, top: 0 });
      expect(store.getNode('child')).toMatchObject({ x: -80, y: 60 });
    } finally {
      engine.destroy();
    }
  });
});
