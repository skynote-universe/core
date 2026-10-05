/**
 * @file document-store.test.ts
 * @description DocumentStore 与 EntityStore 聚合闭环测试
 */

import { describe, it, expect } from 'vitest';
import { DocumentStore } from '../src/state/document-store';
import type { NodeEntity } from '../src/types/node';

describe('DocumentStore & EntityStore', () => {
  it('初始化空画布文档并正确构建实体索引', () => {
    const store = new DocumentStore();
    const view = store.getView();

    expect(view.id).toBe('doc_root');
    // 视口与选区属于本地会话状态，不进入可持久化文档
    expect('viewport' in view).toBe(false);
    expect('selection' in view).toBe(false);
    expect(Object.keys(view.content.nodes)).toHaveLength(0);
    expect(store.entityStore.getAllNodes().length).toBe(0);
  });

  it('addNode 添加节点并自动注册信封与版本号', () => {
    const store = new DocumentStore();

    const node: NodeEntity = {
      id: 'node_1',
      type: 'node',
      nodeType: 'rect',
      x: 100,
      y: 200,
      width: 150,
      height: 80,
      rotation: 0,
      zIndex: 'a1',
      locked: false,
      style: { fill: '#ffffff' }
    };

    store.addNode(node);

    expect(Object.keys(store.getView().content.nodes)).toEqual(['node_1']);

    // 验证 EntityStore O(1) 索引与运行时信封
    const envelope = store.entityStore.getNode('node_1');
    expect(envelope).toBeDefined();
    expect(envelope?.entity.id).toBe('node_1');
    expect(envelope?.runtime.geomVersion).toBeGreaterThan(0);
    expect(envelope?.runtime.dataVersion).toBeGreaterThan(0);
  });

  it('moveNode 仅递增 geomVersion，不影响 dataVersion (双版本号守卫)', () => {
    const store = new DocumentStore();
    const node: NodeEntity = {
      id: 'node_1',
      type: 'node',
      nodeType: 'rect',
      x: 100,
      y: 200,
      width: 150,
      height: 80,
      rotation: 0,
      zIndex: 'a1',
      locked: false
    };

    store.addNode(node);
    const envelope = store.entityStore.getNode('node_1')!;
    const { geomVersion, dataVersion } = envelope.runtime;

    // 移动节点
    store.moveNodes(['node_1'], { x: 50, y: 30 });
    expect(store.getView().content.nodes.node_1.x).toBe(150);
    expect(store.getView().content.nodes.node_1.y).toBe(230);

    // 几何版本号递增，数据版本号保持不变！
    expect(envelope.runtime.geomVersion).toBeGreaterThan(geomVersion);
    expect(envelope.runtime.dataVersion).toBe(dataVersion);
  });

  it('修改样式内容仅递增 dataVersion', () => {
    const store = new DocumentStore();
    const node: NodeEntity = {
      id: 'node_1',
      type: 'node',
      nodeType: 'rect',
      x: 100,
      y: 200,
      width: 150,
      height: 80,
      rotation: 0,
      zIndex: 'a1',
      locked: false,
      style: { fill: '#ffffff' }
    };

    store.addNode(node);
    const envelope = store.entityStore.getNode('node_1')!;
    const { geomVersion, dataVersion } = envelope.runtime;

    // 通过 commit 提交颜色修改
    store.commit({
      label: '修改颜色',
      patches: [
        {
          op: 'set',
          path: ['content', 'nodes', 'node_1', 'style', 'fill'],
          value: '#ff0000'
        }
      ]
    });

    expect(store.getView().content.nodes.node_1.style?.fill).toBe('#ff0000');
    // dataVersion 递增，geomVersion 不变
    expect(envelope.runtime.geomVersion).toBe(geomVersion);
    expect(envelope.runtime.dataVersion).toBeGreaterThan(dataVersion);
  });

  it('removeNode 删除节点并级联清理选中态', () => {
    const store = new DocumentStore();
    const node: NodeEntity = {
      id: 'node_1',
      type: 'node',
      nodeType: 'rect',
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      rotation: 0,
      zIndex: 'a1',
      locked: false
    };

    store.addNode(node);

    store.removeNodes(['node_1']);
    expect(store.getView().content.nodes.node_1).toBeUndefined();
    expect(store.entityStore.hasNode('node_1')).toBe(false);

    // 撤销删除
    store.undo();
    expect(store.getView().content.nodes.node_1.id).toBe('node_1');
    expect(store.entityStore.hasNode('node_1')).toBe(true);
  });

  it('updateNode 语义化更新节点属性并支持样式浅合并', () => {
    const store = new DocumentStore();
    const node: NodeEntity = {
      id: 'node_1',
      type: 'node',
      nodeType: 'rect',
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      rotation: 0,
      zIndex: 'a1',
      locked: false,
      style: { fill: '#111111', stroke: '#222222', strokeWidth: 1 }
    };

    store.addNode(node);

    // 通过 updateNode 浅合并样式
    store.updateNode('node_1', {
      style: { fill: '#ffffff', strokeWidth: 3 }
    });

    const target = store.getView().content.nodes.node_1;
    expect(target.style?.fill).toBe('#ffffff');
    expect(target.style?.strokeWidth).toBe(3);
    expect(target.style?.stroke).toBe('#222222'); // 原属性保留

    // 撤销 updateNode
    store.undo();
    const restored = store.getView().content.nodes.node_1;
    expect(restored.style?.fill).toBe('#111111');
    expect(restored.style?.strokeWidth).toBe(1);
  });

  it('整包覆盖节点时双版本号同时自增防御', () => {
    const store = new DocumentStore();
    const node: NodeEntity = {
      id: 'node_1',
      type: 'node',
      nodeType: 'rect',
      x: 10,
      y: 10,
      width: 50,
      height: 50,
      rotation: 0,
      zIndex: 'a1',
      locked: false
    };

    store.addNode(node);
    const envelope = store.entityStore.getNode('node_1')!;
    const { geomVersion, dataVersion } = envelope.runtime;

    // 整包替换节点
    store.commit({
      label: '整包覆盖节点',
      patches: [
        {
          op: 'set',
          path: ['content', 'nodes', 'node_1'],
          value: { ...node, x: 100, width: 200, style: { fill: '#aabbcc' } }
        }
      ]
    });

    // 几何与数据版本均自增，且实体索引指向新对象
    expect(envelope.runtime.geomVersion).toBeGreaterThan(geomVersion);
    expect(envelope.runtime.dataVersion).toBeGreaterThan(dataVersion);
    expect(store.getNode('node_1')?.x).toBe(100);
  });

  it('补丁按 id 寻址：远端插入节点后撤销仍命中原节点', () => {
    const store = new DocumentStore();
    const make = (id: string): NodeEntity => ({
      id,
      type: 'node',
      nodeType: 'rect',
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      rotation: 0,
      zIndex: 'a1',
      locked: false
    });

    store.addNode(make('a'));
    store.addNode(make('b'));
    store.moveNodes(['b'], { x: 100 });

    store.commit({
      origin: 'remote',
      patches: [{ op: 'set', path: ['content', 'nodes', 'remote_1'], value: make('remote_1') }]
    });

    store.undo();
    const nodes = store.getView().content.nodes;
    expect(nodes.b.x).toBe(0);
    expect(nodes.a.x).toBe(0);
    expect(nodes.remote_1).toBeDefined();
  });

  it('updateNode 合并新样式键后撤销不残留', () => {
    const store = new DocumentStore();
    store.addNode({
      id: 'node_1',
      type: 'node',
      nodeType: 'rect',
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      rotation: 0,
      zIndex: 'a1',
      locked: false,
      style: {}
    });

    store.updateNode('node_1', { style: { fill: '#ff0000' } });
    store.undo();
    expect(store.getNode('node_1')?.style).toEqual({});
  });

  it('删除后撤销恢复的节点获得全新版本号', () => {
    const store = new DocumentStore();
    store.addNode({
      id: 'node_1',
      type: 'node',
      nodeType: 'rect',
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      rotation: 0,
      zIndex: 'a1',
      locked: false
    });
    const before = store.entityStore.getNode('node_1')!.runtime.geomVersion;

    store.removeNodes(['node_1']);
    store.undo();

    expect(store.entityStore.getNode('node_1')!.runtime.geomVersion).toBeGreaterThan(before);
  });

  it('提交不改写 meta.updatedAt，由宿主以非撤销的系统事务写入保存时间', async () => {
    const store = new DocumentStore();
    const initialUpdatedAt = store.getView().meta.updatedAt;

    // 稍微等待 2ms 确保时间戳不同
    await new Promise((resolve) => setTimeout(resolve, 2));

    store.addNode({
      id: 'node_1',
      type: 'node',
      nodeType: 'rect',
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      rotation: 0,
      zIndex: 'a1',
      locked: false
    });
    expect(store.getView().meta.updatedAt).toBe(initialUpdatedAt);

    const savedAt = Date.now();
    store.commit({
      label: '保存',
      source: 'system',
      undoable: false,
      patches: [{ op: 'set', path: ['meta', 'updatedAt'], value: savedAt }]
    });
    expect(store.getView().meta.updatedAt).toBe(savedAt);

    // 撤销的是添加节点，保存时间不回滚
    store.undo();
    expect(store.getView().meta.updatedAt).toBe(savedAt);
  });

  it('updateNodes 一次提交写入多个节点：可按节点计算各自字段，样式按字段合并，一步撤销', () => {
    const store = new DocumentStore();
    const base = {
      type: 'node',
      nodeType: 'rect',
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      rotation: 0,
      locked: false
    } as const;
    store.addNode({ ...base, id: 'a', zIndex: 'a1', style: { radius: 4, fill: '$red' } });
    store.addNode({ ...base, id: 'b', zIndex: 'a2', style: { radius: [1, 2, 3, 4] } });

    store.updateNodes(['a', 'b'], (node) => {
      const radius = node.style?.radius ?? 0;
      const corners = typeof radius === 'number' ? [radius, radius, radius, radius] : [...radius];
      corners[0] = 8;
      return { style: { radius: corners as [number, number, number, number] } };
    });
    expect(store.getNode('a')!.style).toEqual({ radius: [8, 4, 4, 4], fill: '$red' });
    expect(store.getNode('b')!.style).toEqual({ radius: [8, 2, 3, 4] });

    store.undo();
    expect(store.getNode('a')!.style).toEqual({ radius: 4, fill: '$red' });
    expect(store.getNode('b')!.style).toEqual({ radius: [1, 2, 3, 4] });
  });
});
