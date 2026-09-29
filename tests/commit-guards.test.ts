/**
 * @file commit-guards.test.ts
 * @description 提交守卫与容器语义：零 Base64、容器无环、级联移动与级联删除
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SkyNoteEngine } from '../src/engine';
import { DocumentStore, createEmptyCanvasDocument } from '../src/state/document-store';
import type { NodeEntity } from '../src/types/node';

function makeNode(id: string, x: number, parentId?: string): NodeEntity {
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
    locked: false,
    parentId
  };
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('零 Base64 守卫', () => {
  it('拒绝在任意层级内联 data: / blob: 媒体地址的事务', () => {
    const store = new DocumentStore();
    store.addNode(makeNode('a', 0));

    expect(store.updateNode('a', { data: { cover: { src: 'data:image/png;base64,iVBORw0KGgo=' } } })).toBeNull();
    expect(store.addNode({ ...makeNode('b', 0), data: { src: 'blob:https://app/123' } })).toBeNull();
    expect(store.getNode('a')?.data).toBeUndefined();
    expect(Object.hasOwn(store.getView().content.nodes, 'b')).toBe(false);

    expect(store.updateNode('a', { data: { assetId: 'asset_1' } })).not.toBeNull();
  });

  it('不误伤普通文字：以 "Data:" / "blob:" 开头的文本与文字编辑差量均放行', () => {
    const store = new DocumentStore();
    const note = {
      ...makeNode('note', 0),
      textBlocks: [{ id: 't', runs: [{ text: 'Data: Q3 营收增长 12%' }, { text: 'blob: 待办' }] }]
    };
    expect(store.addNode(note)).not.toBeNull();
    expect(
      store.commit({
        patches: [
          {
            op: 'text',
            path: ['content', 'nodes', 'note', 'textBlocks', 0, 'runs', 0, 'text'],
            deltas: [{ insert: 'data:image/png;base64,AAAA ' }]
          }
        ]
      })
    ).not.toBeNull();
    // blob: 后跟非来源格式的文字同样放行，真实 blob 地址才拒绝
    expect(store.updateNode('note', { data: { src: 'blob:https://app.example/123' } })).toBeNull();
  });

  it('导入含内联媒体的文档时直接抛错', () => {
    const doc = createEmptyCanvasDocument();
    doc.content.nodes.a = { ...makeNode('a', 0), data: { src: 'data:image/png;base64,AAAA' } };
    expect(() => new DocumentStore(doc)).toThrow(/content\.nodes\.a\.data\.src/);
  });
});

describe('容器无环守卫', () => {
  it('拒绝自指与多级成环，同一事务内交换父子关系同样拦截', () => {
    const store = new DocumentStore();
    store.addNode(makeNode('a', 0));
    store.addNode(makeNode('b', 0, 'a'));
    store.addNode(makeNode('c', 0, 'b'));

    expect(store.updateNode('a', { parentId: 'a' })).toBeNull();
    expect(store.updateNode('a', { parentId: 'c' })).toBeNull();
    expect(
      store.commit({
        patches: [
          { op: 'unset', path: ['content', 'nodes', 'b', 'parentId'] },
          { op: 'set', path: ['content', 'nodes', 'a', 'parentId'], value: 'b' },
          { op: 'set', path: ['content', 'nodes', 'b', 'parentId'], value: 'a' }
        ]
      })
    ).toBeNull();
    expect(store.getNode('a')?.parentId).toBeUndefined();

    // 合法的改挂：把 c 移出 b 挂到 a 下
    expect(store.updateNode('c', { parentId: 'a' })).not.toBeNull();
    expect([...store.entityStore.getChildIds('a')].sort()).toEqual(['b', 'c']);
    expect(store.entityStore.getChildIds('b').size).toBe(0);
  });

  it('导入容器成环的文档时直接抛错', () => {
    const doc = createEmptyCanvasDocument();
    doc.content.nodes.a = makeNode('a', 0, 'b');
    doc.content.nodes.b = makeNode('b', 0, 'a');
    expect(() => new DocumentStore(doc)).toThrow(/形成环/);
  });
});

describe('容器语义', () => {
  it('移动容器只改容器自身，后代坐标相对容器随之整体移动，撤销整体还原 (ADR-114)', () => {
    const engine = new SkyNoteEngine();
    const store = engine.documentStore;
    store.addNode(makeNode('frame', 0));
    store.addNode(makeNode('card', 20, 'frame'));
    store.addNode(makeNode('badge', 5, 'card'));
    store.addNode(makeNode('outside', 500));

    const record = store.moveNodes(['frame'], { x: 100 })!;
    expect(record.patches.map((p) => p.path)).toEqual([['content', 'nodes', 'frame', 'x']]);
    const nodes = engine.getView().content.nodes;
    expect([nodes.frame.x, nodes.card.x, nodes.badge.x, nodes.outside.x]).toEqual([100, 20, 5, 500]);
    // 后代没有补丁，但空间索引按世界坐标同步更新
    expect(engine.spatialIndex.getBounds('badge')?.left).toBe(125);

    store.undo();
    expect(nodes.frame.x).toBe(0);
    expect(engine.spatialIndex.getBounds('badge')?.left).toBe(25);
  });

  it('删除容器级联删除全部后代及其依附连线，撤销整体恢复', () => {
    const store = new DocumentStore();
    store.addNode(makeNode('frame', 0));
    store.addNode(makeNode('card', 20, 'frame'));
    store.addNode(makeNode('badge', 25, 'card'));
    store.addNode(makeNode('outside', 500));
    store.commit({
      patches: [
        {
          op: 'set',
          path: ['content', 'connectors', 'c1'],
          value: {
            id: 'c1',
            type: 'connector',
            connectorType: 'straight',
            from: { nodeId: 'badge' },
            to: { nodeId: 'outside' },
            zIndex: 'a0',
            locked: false
          }
        }
      ]
    });

    store.removeNodes(['frame']);
    const { nodes, connectors } = store.getView().content;
    expect(Object.keys(nodes)).toEqual(['outside']);
    expect(Object.keys(connectors)).toEqual([]);

    store.undo();
    expect(Object.keys(store.getView().content.nodes).sort()).toEqual(['badge', 'card', 'frame', 'outside']);
    expect(store.entityStore.collectDescendantIds('frame').sort()).toEqual(['badge', 'card']);
    expect(Object.keys(store.getView().content.connectors)).toEqual(['c1']);
  });

  it('多选移动：同时选中容器与其子节点时子节点不再单独移动，一步撤销', () => {
    const store = new DocumentStore();
    store.addNode(makeNode('frame', 0));
    store.addNode(makeNode('card', 20, 'frame'));
    store.addNode(makeNode('solo', 500));

    store.moveNodes(['card', 'frame', 'solo'], { x: 100 });
    const nodes = store.getView().content.nodes;
    expect([nodes.frame.x, nodes.card.x, nodes.solo.x]).toEqual([100, 20, 600]);
    expect(store.entityStore.getWorldTransform('card')!.e).toBe(120);
    expect(store.coordinator.getUndoEntries()).toHaveLength(4);

    store.undo();
    expect([nodes.frame.x, nodes.card.x, nodes.solo.x]).toEqual([0, 20, 500]);
  });

  it('多选删除：一个事务一步撤销，已被容器覆盖的子节点不重复处理', () => {
    const store = new DocumentStore();
    store.addNode(makeNode('frame', 0));
    store.addNode(makeNode('card', 20, 'frame'));
    store.addNode(makeNode('a', 300));
    store.addNode(makeNode('b', 400));
    const depth = store.coordinator.getUndoEntries().length;

    store.removeNodes(['card', 'frame', 'a', 'missing']);
    expect(Object.keys(store.getView().content.nodes)).toEqual(['b']);
    expect(store.coordinator.getUndoEntries()).toHaveLength(depth + 1);

    store.undo();
    expect(Object.keys(store.getView().content.nodes).sort()).toEqual(['a', 'b', 'card', 'frame']);
  });
});
