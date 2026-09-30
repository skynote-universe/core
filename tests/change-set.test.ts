/**
 * @file change-set.test.ts
 * @description 数据一致性底线与增量变更集：严格寻址、写入隔离、撤销冲突、级联删除、ChangeSet 归类与引擎增量索引
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SkyNoteEngine } from '../src/engine';
import { DocumentStore } from '../src/state/document-store';
import { RTreeSpatialIndex } from '../src/spatial';
import type { DocumentChangeSet } from '../src/types/change-set';
import type { NodeEntity } from '../src/types/node';
import type { ConnectorEntity } from '../src/types/connector';

function makeNode(id: string, x = 0, extra?: Partial<NodeEntity>): NodeEntity {
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
    style: {},
    ...extra
  };
}

function makeConnector(id: string, fromNodeId: string, toNodeId: string): ConnectorEntity {
  return {
    id,
    type: 'connector',
    connectorType: 'straight',
    from: { nodeId: fromNodeId },
    to: { nodeId: toNodeId },
    zIndex: 'a0',
    locked: false
  };
}

function captureChanges(store: DocumentStore): DocumentChangeSet[] {
  const list: DocumentChangeSet[] = [];
  store.subscribe((_view, _record, changes) => list.push(changes));
  return list;
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('数据一致性底线', () => {
  it('针对已删除实体的迟到补丁整体失败，绝不凭空造出残缺实体', () => {
    const engine = new SkyNoteEngine();
    const record = engine.documentStore.commit({
      origin: 'remote',
      patches: [{ op: 'set', path: ['content', 'nodes', 'ghost', 'x'], value: 5 }]
    });

    expect(record).toBeNull();
    expect(Object.hasOwn(engine.documentStore.getView().content.nodes, 'ghost')).toBe(false);
    expect(engine.spatialIndex.size).toBe(0);
  });

  it('远端删除后本地撤销冲突：条目作废、历史状态广播，文档不被污染', () => {
    const store = new DocumentStore();
    store.addNode(makeNode('b'));
    store.moveNodes(['b'], { x: 100 });
    store.commit({ origin: 'remote', patches: [{ op: 'unset', path: ['content', 'nodes', 'b'] }] });

    const historyStates: boolean[] = [];
    store.onHistoryChange((state) => historyStates.push(state.canUndo));

    expect(store.undo()).toBe(false);
    expect(Object.hasOwn(store.getView().content.nodes, 'b')).toBe(false);
    // 订阅时的初始通知 + 作废后的通知
    expect(historyStates.length).toBe(2);
    // 下一条历史（新增 b）仍可正常撤销：unset 不存在的实体是幂等的
    expect(store.undo()).toBe(true);
  });

  it('调用方事后修改传入对象，不会绕过事务篡改文档', () => {
    const engine = new SkyNoteEngine();
    const node = makeNode('a');
    engine.documentStore.addNode(node);

    node.x = 999;
    (node.style as Record<string, unknown>).fill = 'red';

    expect(engine.documentStore.getView().content.nodes.a.x).toBe(0);
    expect(engine.documentStore.getView().content.nodes.a.style).toEqual({});
  });

  it('文档后续的就地修改不会回写撤销栈中的历史补丁', () => {
    const store = new DocumentStore();
    store.addNode(makeNode('a'));
    const addEntry = store.undoEntries[0];

    store.moveNodes(['a'], { x: 50 });
    store.updateNode('a', { style: { fill: 'red' } });

    const recorded = (addEntry.patches[0] as { value: NodeEntity }).value;
    expect(recorded.x).toBe(0);
    expect(recorded.style).toEqual({});
  });

  it('初始文档经深拷贝净化，调用方持有的引用与危险键均被隔离', () => {
    const initialDoc = JSON.parse(
      '{"id":"d","name":"n","meta":{"version":1,"createdAt":0,"updatedAt":0},' +
        '"viewport":{"x":0,"y":0,"zoom":1},"selection":{"nodeIds":[],"connectorIds":[]},' +
        '"content":{"nodes":{"a":{"id":"a","type":"node","nodeType":"rect","x":0,"y":0,"width":1,"height":1,' +
        '"rotation":0,"zIndex":"a0","locked":false,"data":{"__proto__":{"polluted":1}}}},"connectors":{}}}'
    );
    const store = new DocumentStore(initialDoc);
    initialDoc.content.nodes.a.x = 42;

    const node = store.getView().content.nodes.a;
    expect(node.x).toBe(0);
    expect((node.data as { polluted?: number }).polluted).toBeUndefined();
  });

  it('越界的切片与文本 Delta 判定失败并整批回滚', () => {
    const store = new DocumentStore();
    store.addNode(makeNode('a', 0, { anchors: [] }));

    const spliceResult = store.commit({
      patches: [
        { op: 'set', path: ['content', 'nodes', 'a', 'x'], value: 7 },
        { op: 'splice', path: ['content', 'nodes', 'a', 'anchors'], index: 3, deleteCount: 0, items: [] }
      ]
    });
    expect(spliceResult).toBeNull();
    expect(store.getNode('a')?.x).toBe(0);
  });

  it('addNode 拒绝覆盖已存在的 id', () => {
    const store = new DocumentStore();
    store.addNode(makeNode('a'));
    expect(store.addNode(makeNode('a', 100))).toBeNull();
    expect(store.getNode('a')?.x).toBe(0);
  });

  it('removeNode 级联删除依附连线，引擎同步剔除失效选区，撤销恢复实体', () => {
    const engine = new SkyNoteEngine();
    const store = engine.documentStore;
    store.addNode(makeNode('a'));
    store.addNode(makeNode('b', 100));
    store.commit({
      patches: [{ op: 'set', path: ['content', 'connectors', 'c1'], value: makeConnector('c1', 'a', 'b') }]
    });
    engine.session.setSelection({ nodeIds: ['a', 'b'], connectorIds: ['c1'] });

    store.removeNodes(['a']);
    const view = engine.documentStore.getView();
    expect(Object.keys(view.content.connectors)).toEqual([]);
    expect([...engine.session.selectedNodeIds]).toEqual(['b']);
    expect(engine.session.selectedConnectorIds.size).toBe(0);
    expect(engine.connectorSpatialIndex.size).toBe(0);
    expect(store.entityStore.getConnectorIdsOfNode('b').size).toBe(0);

    store.undo();
    expect(Object.keys(engine.documentStore.getView().content.connectors)).toEqual(['c1']);
    expect(store.entityStore.getConnectorIdsOfNode('a').has('c1')).toBe(true);
    expect(engine.connectorSpatialIndex.size).toBe(1);
  });
});

describe('实体索引读写分离', () => {
  it('对外只暴露只读视图：类型层面禁止写入索引与就地改写实体', () => {
    const engine = new SkyNoteEngine();
    engine.documentStore.addNode(makeNode('a'));
    const runtimeNode = engine.entityStore.getNode('a')!;

    // @ts-expect-error 写入方法只供 DocumentStore 内部使用
    expect(engine.entityStore.syncNode).toBeTypeOf('function');
    // @ts-expect-error 实体字段只读，变更必须走事务
    const assignX = () => (runtimeNode.entity.x = 1);
    // @ts-expect-error 版本号只读
    const assignVersion = () => (runtimeNode.runtime.geomVersion = 0);
    expect([assignX, assignVersion]).toHaveLength(2);
  });
});

describe('DocumentChangeSet 归类', () => {
  it('字段级补丁按几何/数据/层级精确归类', () => {
    const store = new DocumentStore();
    store.addNode(makeNode('a'));
    const changes = captureChanges(store);

    store.moveNodes(['a'], { x: 5 });
    store.updateNode('a', { style: { fill: 'red' } });
    store.updateNode('a', { zIndex: 'a3' });

    const [move, style, z] = changes;
    expect([...move.nodes.geometry]).toEqual(['a']);
    expect(move.nodes.data.size).toBe(0);
    expect(move.orderChanged).toBe(false);

    expect([...style.nodes.data]).toEqual(['a']);
    expect(style.nodes.geometry.size).toBe(0);

    expect(z.orderChanged).toBe(true);
    expect(changes).toHaveLength(3);
  });

  it('实体级增删与整体替换进入 added/removed，并标记层级变化', () => {
    const store = new DocumentStore();
    const changes = captureChanges(store);

    store.addNode(makeNode('a'));
    store.commit({ patches: [{ op: 'set', path: ['content', 'nodes', 'a'], value: makeNode('a', 50) }] });
    store.removeNodes(['a']);

    const [added, replaced, removed] = changes;
    expect([...added.nodes.added]).toEqual(['a']);
    expect(added.nodes.geometry.has('a')).toBe(true);
    expect(added.orderChanged).toBe(true);

    expect(replaced.nodes.added.size).toBe(0);
    expect(replaced.nodes.geometry.has('a')).toBe(true);
    expect(replaced.nodes.data.has('a')).toBe(true);

    expect([...removed.nodes.removed]).toEqual(['a']);
    expect(removed.nodes.geometry.size).toBe(0);
  });

  it('对实体本身做字典合并时按合并字段归类并递增对应版本号', () => {
    const store = new DocumentStore();
    store.addNode(makeNode('a'));
    const runtime = store.entityStore.getNode('a')!.runtime;
    const { geomVersion, dataVersion } = runtime;
    const changes = captureChanges(store);

    store.commit({ patches: [{ op: 'set', path: ['content', 'nodes', 'a'], merge: true, value: { x: 20 } }] });

    expect(changes[0].nodes.geometry.has('a')).toBe(true);
    expect(changes[0].nodes.data.size).toBe(0);
    expect(runtime.geomVersion).toBeGreaterThan(geomVersion);
    expect(runtime.dataVersion).toBe(dataVersion);
  });

  it('节点移动时依附连线并入 connectors.geometry，端点就地改绑刷新邻接索引', () => {
    const store = new DocumentStore();
    store.addNode(makeNode('a'));
    store.addNode(makeNode('b', 100));
    store.addNode(makeNode('c', 200));
    store.commit({
      patches: [{ op: 'set', path: ['content', 'connectors', 'c1'], value: makeConnector('c1', 'a', 'b') }]
    });
    const changes = captureChanges(store);

    store.moveNodes(['b'], { x: 10 });
    expect([...changes[0].connectors.geometry]).toEqual(['c1']);

    store.commit({ patches: [{ op: 'set', path: ['content', 'connectors', 'c1', 'to', 'nodeId'], value: 'c' }] });
    expect(changes[1].orderChanged).toBe(true);
    expect(store.entityStore.getConnectorIdsOfNode('b').size).toBe(0);
    expect(store.entityStore.getConnectorIdsOfNode('c').has('c1')).toBe(true);
  });
});

describe('引擎增量维护空间索引', () => {
  it('视口、选区与样式变更不触达空间索引；移动只更新变更节点', () => {
    const updateSpy = vi.fn();
    const engine = new SkyNoteEngine({
      createNodeSpatialIndex: () => {
        const index = new RTreeSpatialIndex();
        const update = index.update.bind(index);
        index.update = (id, bounds) => {
          updateSpy(id, bounds);
          update(id, bounds);
        };
        return index;
      }
    });
    const store = engine.documentStore;
    for (let i = 0; i < 100; i++) {
      store.addNode(makeNode(`n${i}`, i * 20));
    }
    updateSpy.mockClear();
    engine.session.setViewport({ x: 10 });
    engine.session.setSelection({ nodeIds: ['n1'] });
    store.updateNode('n1', { style: { fill: 'red' } });
    expect(updateSpy).not.toHaveBeenCalled();

    store.moveNodes(['n5'], { x: 1 });
    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(updateSpy.mock.calls[0][0]).toBe('n5');
  });

  it('连线随端点节点移动更新空间索引', () => {
    const engine = new SkyNoteEngine();
    const store = engine.documentStore;
    store.addNode(makeNode('a'));
    store.addNode(makeNode('b', 100));
    store.commit({
      patches: [{ op: 'set', path: ['content', 'connectors', 'c1'], value: makeConnector('c1', 'a', 'b') }]
    });

    // 包围盒取真实路由：直线路由连接两端节点中心 (5 → 105)
    expect(engine.connectorSpatialIndex.getBounds('c1')?.right).toBe(105);
    const routeBefore = engine.getConnectorRoute('c1');
    store.moveNodes(['b'], { x: 400 });
    expect(engine.connectorSpatialIndex.getBounds('c1')?.right).toBe(505);
    // 路由整体替换，下游按引用即可判定失效
    expect(engine.getConnectorRoute('c1')).not.toBe(routeBefore);
    expect(engine.getConnectorRoute('c1')?.totalLength).toBe(500);
  });

  it('样式等数据变更不重算路由；删除端点节点后连线随之删除并清出路由缓存', () => {
    const engine = new SkyNoteEngine();
    const store = engine.documentStore;
    store.addNode(makeNode('a'));
    store.addNode(makeNode('b', 100));
    store.commit({
      patches: [{ op: 'set', path: ['content', 'connectors', 'c1'], value: makeConnector('c1', 'a', 'b') }]
    });
    const route = engine.getConnectorRoute('c1');

    store.updateNode('a', { style: { fill: 'red' } });
    expect(engine.getConnectorRoute('c1')).toBe(route);

    store.removeNodes(['a']);
    expect(engine.getConnectorRoute('c1')).toBeUndefined();
    expect(engine.connectorSpatialIndex.size).toBe(0);
  });

  it('插件晚于文档注册路由器时，自动重算该类型连线的路由与空间索引', () => {
    const engine = new SkyNoteEngine();
    const store = engine.documentStore;
    store.addNode(makeNode('a'));
    store.addNode(makeNode('b', 100));
    store.commit({
      patches: [
        {
          op: 'set',
          path: ['content', 'connectors', 'c1'],
          value: { ...makeConnector('c1', 'a', 'b'), connectorType: 'detour' }
        }
      ]
    });
    // 未注册时回退直线
    expect(engine.getConnectorRoute('c1')?.points).toHaveLength(2);

    engine.routers.register({
      id: 'detour',
      label: '绕行',
      route: ({ startPoint, endPoint }) => ({
        points: [startPoint, { x: startPoint.x, y: 300 }, { x: endPoint.x, y: 300 }, endPoint]
      })
    });
    expect(engine.getConnectorRoute('c1')?.points).toHaveLength(4);
    expect(engine.connectorSpatialIndex.getBounds('c1')?.bottom).toBe(300);
  });
});
