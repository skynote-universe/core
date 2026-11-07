import { describe, expect, it } from 'vitest';
import { SkyNoteEngine } from '../src/engine';
import { createEmptyCanvasDocument } from '../src/state/document-store';
import { parseCanvasDocument } from '../src/serialization/document-schema';
import type { NodeEntity } from '../src/types/node';

function node(id: string, fields: Partial<NodeEntity> = {}): NodeEntity {
  return {
    id,
    type: 'node',
    nodeType: 'custom',
    x: 0,
    y: 0,
    width: 100,
    height: 50,
    rotation: 0,
    zIndex: 'a0',
    locked: false,
    ...fields
  };
}
function setup() {
  const doc = createEmptyCanvasDocument();
  doc.content.nodes = {
    root: node('root', { layout: { type: 'tree' }, layoutState: { collapsed: true } }),
    child: node('child', { parentId: 'root', layoutItem: {} }),
    content: node('content', { parentId: 'root' }),
    leaf: node('leaf', { parentId: 'child', layoutItem: {} })
  };
  const engine = new SkyNoteEngine({ initialDoc: doc });
  return { engine, store: engine.documentStore };
}

describe('通用布局可见性', () => {
  it('布局显式声明能力后才解释折叠，晚注册/卸载立即更新且不产生历史', () => {
    const { engine, store } = setup();
    expect(engine.visibility.isNodeVisible('leaf')).toBe(true);
    engine.layouts.register({ id: 'tree', label: '树', collapsible: true, arrange: () => new Map() });
    expect(engine.visibility.isNodeVisible('child')).toBe(false);
    expect(engine.visibility.isNodeVisible('leaf')).toBe(false);
    expect(engine.visibility.isNodeVisible('content')).toBe(true);
    expect(store.selectionGeometry.getSubtreeBounds('child')).toBeUndefined();
    expect(store.undoEntries).toHaveLength(0);
    engine.layouts.unregister(engine.layouts.get('tree')!);
    expect(engine.visibility.isNodeVisible('leaf')).toBe(true);
    engine.destroy();
  });

  it('嵌套布局的子主题按自己的能力解释折叠；外层折叠仍隐藏整棵嵌套树', () => {
    const { engine, store } = setup();
    engine.layouts.register({ id: 'tree', label: '树', collapsible: true, arrange: () => new Map() });
    store.updateNode('root', { layoutState: { collapsed: false } });
    store.updateNode('child', { layout: { type: 'plain' }, layoutState: { collapsed: true } });
    expect(engine.visibility.isNodeVisible('leaf')).toBe(true);
    engine.layouts.register({ id: 'plain', label: '可折叠树', collapsible: true, arrange: () => new Map() });
    expect(engine.visibility.isNodeVisible('leaf')).toBe(false);
    store.updateNode('child', { layoutState: { collapsed: false } });
    expect(engine.visibility.isNodeVisible('leaf')).toBe(true);
    store.updateNode('root', { layoutState: { collapsed: true } });
    expect(engine.visibility.isNodeVisible('child')).toBe(false);
    expect(engine.visibility.isNodeVisible('leaf')).toBe(false);
    engine.destroy();
  });

  it('失败事务不会污染可见性缓存；整体替换和撤销恢复折叠状态', () => {
    const { engine, store } = setup();
    engine.layouts.register({ id: 'tree', label: '树', collapsible: true, arrange: () => new Map() });
    expect(engine.visibility.isNodeVisible('leaf')).toBe(false);
    expect(() =>
      store.batch(() => {
        store.updateNode('root', { layoutState: { collapsed: false } });
        throw new Error('取消');
      }, '取消事务')
    ).toThrow('取消');
    expect(engine.visibility.isNodeVisible('leaf')).toBe(false);
    store.commit({ label: '替换', patches: [{ op: 'set', path: ['content'], value: { nodes: {}, connectors: {} } }] });
    expect(engine.visibility.hasCollapsed).toBe(false);
    store.undo();
    expect(store.getNode('leaf')).toBeDefined();
    expect(engine.visibility.isNodeVisible('leaf')).toBe(false);
    engine.destroy();
  });

  it('折叠字段显式校验：只接受布尔值，保存与解析保留有效状态', () => {
    const { engine, store } = setup();
    const raw = JSON.parse(JSON.stringify(store.getView()));
    const parsed = parseCanvasDocument(raw);
    expect(parsed.ok && parsed.value.content.nodes.root.layoutState).toEqual({ collapsed: true });
    for (const value of ['true', 1, null]) {
      raw.content.nodes.root.layoutState.collapsed = value;
      expect(parseCanvasDocument(raw).ok).toBe(false);
    }
    engine.destroy();
  });
});
