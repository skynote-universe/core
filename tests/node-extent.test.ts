/**
 * @file node-extent.test.ts
 * @description 节点占据范围 (extent)：框外装饰登记进空间索引，有无子节点、旋转时都可拾取；拾取可按条件过滤
 */

import { describe, it, expect } from 'vitest';
import { SkyNoteEngine } from '../src/engine';
import type { NodeEntity } from '../src/types/node';

function makeNode(id: string, patch: Partial<NodeEntity> = {}): NodeEntity {
  return {
    id,
    type: 'node',
    nodeType: 'tagged',
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    rotation: 0,
    zIndex: 'a0',
    locked: false,
    ...patch
  };
}

function createEngine(): SkyNoteEngine {
  const engine = new SkyNoteEngine();
  // 上方 20 的标签带属于节点
  engine.nodeTypes.register({
    type: 'tagged',
    label: '带标签',
    defaultData: {},
    extent: (node) => ({ left: 0, top: -20, right: node.width, bottom: node.height }),
    outline: (node) => [
      { x: 0, y: -20 },
      { x: node.width, y: -20 },
      { x: node.width, y: node.height },
      { x: 0, y: node.height }
    ]
  });
  return engine;
}

describe('节点占据范围', () => {
  it('框外标签带登记进空间索引并可拾取；有子节点时子树范围同样包含标签带', () => {
    const engine = createEngine();
    engine.documentStore.addNode(makeNode('n', { x: 100, y: 100 }));
    expect(engine.spatialIndex.getBounds('n')).toEqual({ left: 100, top: 80, right: 200, bottom: 200 });
    expect(engine.hitTestNode({ x: 110, y: 90 })?.id).toBe('n');

    engine.documentStore.addNode(
      makeNode('child', { nodeType: 'rect', parentId: 'n', x: 10, y: 10, width: 20, height: 20 })
    );
    expect(engine.hitTestNode({ x: 110, y: 90 })?.id).toBe('n');
    expect(engine.hitTestNode({ x: 115, y: 115 })?.id).toBe('child');
    expect(engine.spatialIndex.getContentBounds()).toMatchObject({ top: 80 });
  });

  it('旋转后标签带随节点旋转；拾取条件过滤掉的节点被跳过', () => {
    const engine = createEngine();
    engine.documentStore.addNode(makeNode('n', { x: 100, y: 100, rotation: 180 }));
    // 旋转 180°：标签带翻到下方
    expect(engine.hitTestNode({ x: 150, y: 210 })?.id).toBe('n');
    expect(engine.hitTestNode({ x: 150, y: 90 })).toBeUndefined();

    engine.documentStore.addNode(makeNode('top', { x: 120, y: 120, width: 10, height: 10, zIndex: 'a1' }));
    expect(engine.hitTestNode({ x: 125, y: 125 })?.id).toBe('top');
    expect(engine.hitTestNode({ x: 125, y: 125 }, (node) => node.id !== 'top')?.id).toBe('n');
  });
});
