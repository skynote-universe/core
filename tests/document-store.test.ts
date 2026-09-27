/**
 * @file document-store.test.ts
 * @description DocumentStore 与 EntityStore 聚合闭环测试
 */

import { describe, it, expect } from 'vitest';
import { DocumentStore, createEmptyCanvasDocument } from '../src/state/document-store';
import type { NodeEntity } from '../src/types/node';

describe('DocumentStore & EntityStore', () => {
  it('初始化空画布文档并正确构建实体索引', () => {
    const store = new DocumentStore();
    const view = store.getView();

    expect(view.id).toBe('doc_root');
    expect(view.viewport.zoom).toBe(1);
    expect(view.content.nodes.length).toBe(0);
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
      zIndex: 1,
      locked: false,
      style: { fill: '#ffffff' }
    };

    store.addNode(node);

    expect(store.getView().content.nodes.length).toBe(1);
    expect(store.getView().content.nodes[0].id).toBe('node_1');

    // 验证 EntityStore O(1) 索引与运行时信封
    const envelope = store.entityStore.getNode('node_1');
    expect(envelope).toBeDefined();
    expect(envelope?.entity.id).toBe('node_1');
    expect(envelope?.runtime.geomVersion).toBe(1);
    expect(envelope?.runtime.dataVersion).toBe(1);
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
      zIndex: 1,
      locked: false
    };

    store.addNode(node);
    const envelope = store.entityStore.getNode('node_1')!;
    expect(envelope.runtime.geomVersion).toBe(1);
    expect(envelope.runtime.dataVersion).toBe(1);

    // 移动节点
    store.moveNode('node_1', { x: 50, y: 30 });
    expect(store.getView().content.nodes[0].x).toBe(150);
    expect(store.getView().content.nodes[0].y).toBe(230);

    // 几何版本号递增，数据版本号保持不变！
    expect(envelope.runtime.geomVersion).toBe(2);
    expect(envelope.runtime.dataVersion).toBe(1);
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
      zIndex: 1,
      locked: false,
      style: { fill: '#ffffff' }
    };

    store.addNode(node);
    const envelope = store.entityStore.getNode('node_1')!;

    // 通过 commit 提交颜色修改
    store.commit({
      label: '修改颜色',
      patches: [
        {
          op: 'set',
          path: ['content', 'nodes', 0, 'style', 'fill'],
          value: '#ff0000'
        }
      ]
    });

    expect(store.getView().content.nodes[0].style?.fill).toBe('#ff0000');
    // dataVersion 递增，geomVersion 不变
    expect(envelope.runtime.geomVersion).toBe(1);
    expect(envelope.runtime.dataVersion).toBe(2);
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
      zIndex: 1,
      locked: false
    };

    store.addNode(node);
    store.setSelection({ nodeIds: ['node_1'] });
    expect(store.getSelection().nodeIds).toContain('node_1');

    store.removeNode('node_1');
    expect(store.getView().content.nodes.length).toBe(0);
    expect(store.entityStore.hasNode('node_1')).toBe(false);
    expect(store.getSelection().nodeIds).not.toContain('node_1');

    // 撤销删除
    store.undo();
    expect(store.getView().content.nodes.length).toBe(1);
    expect(store.entityStore.hasNode('node_1')).toBe(true);
  });

  it('setViewport 变更视口且默认不污染历史栈', () => {
    const store = new DocumentStore();
    store.setViewport({ x: 500, y: 300, zoom: 1.5 });

    const vp = store.getViewport();
    expect(vp.x).toBe(500);
    expect(vp.y).toBe(300);
    expect(vp.zoom).toBe(1.5);
    expect(store.canUndo).toBe(false);
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
      zIndex: 1,
      locked: false,
      style: { fill: '#111111', stroke: '#222222', strokeWidth: 1 }
    };

    store.addNode(node);

    // 通过 updateNode 浅合并样式
    store.updateNode('node_1', {
      style: { fill: '#ffffff', strokeWidth: 3 }
    });

    const target = store.getView().content.nodes[0];
    expect(target.style?.fill).toBe('#ffffff');
    expect(target.style?.strokeWidth).toBe(3);
    expect(target.style?.stroke).toBe('#222222'); // 原属性保留

    // 撤销 updateNode
    store.undo();
    const restored = store.getView().content.nodes[0];
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
      zIndex: 1,
      locked: false
    };

    store.addNode(node);
    const envelope = store.entityStore.getNode('node_1')!;
    expect(envelope.runtime.geomVersion).toBe(1);
    expect(envelope.runtime.dataVersion).toBe(1);

    // 整包替换 nodes[0]
    store.commit({
      label: '整包覆盖节点',
      patches: [
        {
          op: 'set',
          path: ['content', 'nodes', 0],
          value: { ...node, x: 100, width: 200, style: { fill: '#aabbcc' } }
        }
      ]
    });

    // 几何与数据版本均自增
    expect(envelope.runtime.geomVersion).toBe(2);
    expect(envelope.runtime.dataVersion).toBe(2);
  });

  it('本地操作自动更新 doc.meta.updatedAt', async () => {
    const store = new DocumentStore();
    const initialUpdatedAt = store.getView().meta.updatedAt;

    // 稍微等待 2ms 确保时间戳不同
    await new Promise((resolve) => setTimeout(resolve, 2));

    store.setViewport({ zoom: 2 });
    expect(store.getView().meta.updatedAt).toBeGreaterThanOrEqual(initialUpdatedAt);
  });
});

