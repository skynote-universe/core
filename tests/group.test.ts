/**
 * @file group.test.ts
 * @description ADR-145 组合 (Group) 事务内自底向上外框派生、成组/解组、旋转坐标系偏移补偿、空组自动清理与缩放传播测试
 */

import { describe, it, expect } from 'vitest';
import { SkyNoteEngine } from '../src/engine';
import { GROUP_NODE_TYPE } from '../src/layout/group-bounds-derivation';
import { applyMatrix } from '../src/utils/geometry';
import type { NodeEntity } from '../src/types/node';

function makeNode(id: string, patch: Partial<NodeEntity> = {}): NodeEntity {
  return {
    id,
    type: 'node',
    nodeType: 'rect',
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

function worldPoint(engine: SkyNoteEngine, id: string, x: number, y: number) {
  return applyMatrix(engine.entityStore.getWorldTransform(id)!, x, y);
}

describe('ADR-145 组合 (Group) 事务内派生与命令闭环', () => {
  it('groupNodes 与 ungroupNodes 保持子节点世界位姿不变，支持一步 undo/redo', () => {
    const engine = new SkyNoteEngine();
    const store = engine.documentStore;
    store.addNode(makeNode('a', { x: 100, y: 120, width: 80, height: 60, zIndex: 'a0' }));
    store.addNode(makeNode('b', { x: 240, y: 200, width: 60, height: 100, zIndex: 'a2' }));
    store.clearHistory();

    const beforeA = worldPoint(engine, 'a', 0, 0);
    const beforeB = worldPoint(engine, 'b', 60, 100);

    const groupId = store.groupNodes(['a', 'b']);
    expect(groupId).not.toBeNull();
    const group = store.getNode(groupId!)!;
    expect(group.nodeType).toBe(GROUP_NODE_TYPE);
    expect(group.x).toBe(100);
    expect(group.y).toBe(120);
    expect(group.width).toBe(200); // 100..300
    expect(group.height).toBe(180); // 120..300

    // 子节点转为局部坐标，世界坐标保持完全不变
    expect(store.getNode('a')).toMatchObject({ parentId: groupId, x: 0, y: 0 });
    expect(store.getNode('b')).toMatchObject({ parentId: groupId, x: 140, y: 80 });
    expect(worldPoint(engine, 'a', 0, 0)).toEqual(beforeA);
    expect(worldPoint(engine, 'b', 60, 100)).toEqual(beforeB);

    // 一步撤销恢复成组前状态
    store.undo();
    expect(store.getNode(groupId!)).toBeUndefined();
    expect(store.getNode('a')?.parentId).toBeUndefined();
    expect(store.getNode('b')?.parentId).toBeUndefined();
    expect(store.getNode('a')).toMatchObject({ x: 100, y: 120 });
    expect(store.getNode('b')).toMatchObject({ x: 240, y: 200 });

    // 一步重做重新成组
    store.redo();
    expect(store.getNode(groupId!)?.width).toBe(200);
    expect(store.getNode('a')?.parentId).toBe(groupId);

    // 解组恢复到父层级并删除组合节点
    const ungrouped = store.ungroupNodes([groupId!]);
    expect(ungrouped.sort()).toEqual(['a', 'b']);
    expect(store.getNode(groupId!)).toBeUndefined();
    expect(store.getNode('a')).toMatchObject({ x: 100, y: 120 });
    expect(store.getNode('b')).toMatchObject({ x: 240, y: 200 });
  });

  it('组合内子节点向左上移动 (x < 0, y < 0) 时自动紧缩外框并补偿兄弟节点局部坐标，兄弟世界坐标零漂移', () => {
    const engine = new SkyNoteEngine();
    const store = engine.documentStore;
    store.addNode(makeNode('a', { x: 100, y: 100, width: 50, height: 50, zIndex: 'a0' }));
    store.addNode(makeNode('b', { x: 200, y: 200, width: 50, height: 50, zIndex: 'a1' }));
    const groupId = store.groupNodes(['a', 'b'])!;

    const beforeB = worldPoint(engine, 'b', 0, 0);
    // 将 a 向左上移动 (-40, -30)，此时 a 的世界左上角变为 (60, 70)
    store.moveEntities({ nodeIds: ['a'] }, { x: -40, y: -30 });

    const group = store.getNode(groupId)!;
    expect(group).toMatchObject({ x: 60, y: 70, width: 190, height: 180 });
    expect(store.getNode('a')).toMatchObject({ x: 0, y: 0 });
    // b 的局部坐标自动补偿 (+40, +30)，世界坐标保持 (200, 200)
    expect(store.getNode('b')).toMatchObject({ x: 140, y: 130 });
    expect(worldPoint(engine, 'b', 0, 0)).toEqual(beforeB);
  });

  it('嵌套组合 (Group in Group) 在同一事务内自底向上收敛所有祖先组合外框', () => {
    const engine = new SkyNoteEngine();
    const store = engine.documentStore;
    store.addNode(makeNode('a', { x: 100, y: 100, width: 50, height: 50, zIndex: 'a0' }));
    store.addNode(makeNode('b', { x: 200, y: 100, width: 50, height: 50, zIndex: 'a1' }));
    store.addNode(makeNode('c', { x: 100, y: 250, width: 50, height: 50, zIndex: 'a2' }));

    const innerGroupId = store.groupNodes(['a', 'b'])!;
    const outerGroupId = store.groupNodes([innerGroupId, 'c'])!;
    store.clearHistory();

    // 移动内层子节点 b 向右扩展 100px
    store.moveEntities({ nodeIds: ['b'] }, { x: 100, y: 0 });

    expect(store.getNode(innerGroupId)).toMatchObject({ x: 0, y: 0, width: 250, height: 50 });
    expect(store.getNode(outerGroupId)).toMatchObject({ x: 100, y: 100, width: 250, height: 200 });

    // 一步撤销同时还原内层、外层与叶子节点
    store.undo();
    expect(store.getNode(innerGroupId)).toMatchObject({ x: 0, y: 0, width: 150, height: 50 });
    expect(store.getNode(outerGroupId)).toMatchObject({ x: 100, y: 100, width: 150, height: 200 });
  });

  it('带旋转角度的组合内移动子节点时，外框绕旋转轴正确换算，兄弟节点世界位姿不变', () => {
    const engine = new SkyNoteEngine();
    const store = engine.documentStore;
    store.addNode(makeNode('a', { x: 100, y: 100, width: 40, height: 40, zIndex: 'a0' }));
    store.addNode(makeNode('b', { x: 200, y: 160, width: 60, height: 40, zIndex: 'a1' }));
    const groupId = store.groupNodes(['a', 'b'])!;

    // 将组合旋转 90 度
    store.rotateNodes([groupId], 90);
    const beforeBTopLeft = worldPoint(engine, 'b', 0, 0);
    const beforeBBottomRight = worldPoint(engine, 'b', 60, 40);
    const beforeATopLeft = worldPoint(engine, 'a', 0, 0);

    // 沿世界坐标移动子节点 a (+30, -20)
    store.moveEntities({ nodeIds: ['a'] }, { x: 30, y: -20 });

    const afterATopLeft = worldPoint(engine, 'a', 0, 0);
    expect(afterATopLeft.x).toBeCloseTo(beforeATopLeft.x + 30, 1);
    expect(afterATopLeft.y).toBeCloseTo(beforeATopLeft.y - 20, 1);

    // 兄弟节点 b 的世界坐标不因外框重算而发生漂移
    const afterBTopLeft = worldPoint(engine, 'b', 0, 0);
    const afterBBottomRight = worldPoint(engine, 'b', 60, 40);
    expect(afterBTopLeft.x).toBeCloseTo(beforeBTopLeft.x, 1);
    expect(afterBTopLeft.y).toBeCloseTo(beforeBTopLeft.y, 1);
    expect(afterBBottomRight.x).toBeCloseTo(beforeBBottomRight.x, 1);
    expect(afterBBottomRight.y).toBeCloseTo(beforeBBottomRight.y, 1);
  });

  it('删除组合内全部子节点时自动级联清理空组合，一步撤销整体恢复', () => {
    const engine = new SkyNoteEngine();
    const store = engine.documentStore;
    store.addNode(makeNode('a', { x: 0, y: 0, width: 50, height: 50, zIndex: 'a0' }));
    store.addNode(makeNode('b', { x: 100, y: 0, width: 50, height: 50, zIndex: 'a1' }));
    const groupId = store.groupNodes(['a', 'b'])!;
    store.clearHistory();

    // 先删 a，组合仍保留并紧缩到 b
    store.removeEntities({ nodeIds: ['a'] });
    expect(store.getNode(groupId)).toMatchObject({ x: 100, y: 0, width: 50, height: 50 });

    // 再删 b，组合变空并在同一事务内自动移除
    store.removeEntities({ nodeIds: ['b'] });
    expect(store.getNode('b')).toBeUndefined();
    expect(store.getNode(groupId)).toBeUndefined();

    // 一步撤销同时恢复 b 与 groupId
    store.undo();
    expect(store.getNode('b')).toBeDefined();
    expect(store.getNode(groupId)).toMatchObject({ x: 100, y: 0, width: 50, height: 50 });
  });

  it('resizeNodes 对组合执行缩放时按比例传播到组合内子节点', () => {
    const engine = new SkyNoteEngine();
    const store = engine.documentStore;
    store.addNode(makeNode('a', { x: 100, y: 100, width: 50, height: 50, zIndex: 'a0' }));
    store.addNode(makeNode('b', { x: 150, y: 150, width: 50, height: 50, zIndex: 'a1' }));
    const groupId = store.groupNodes(['a', 'b'])!;
    expect(store.getNode(groupId)).toMatchObject({ x: 100, y: 100, width: 100, height: 100 });

    store.resizeNodes([groupId], { width: 200, height: 200 });
    expect(store.getNode(groupId)).toMatchObject({ x: 100, y: 100, width: 200, height: 200 });
    expect(store.getNode('a')).toMatchObject({ x: 0, y: 0, width: 100, height: 100 });
    expect(store.getNode('b')).toMatchObject({ x: 100, y: 100, width: 100, height: 100 });
  });

  it('canGroupNodes 与 canUngroupNodes 准确反映成组/解组能力', () => {
    const engine = new SkyNoteEngine();
    const store = engine.documentStore;
    store.addNode(makeNode('a', { x: 0, y: 0, width: 50, height: 50, zIndex: 'a0' }));
    store.addNode(makeNode('b', { x: 100, y: 0, width: 50, height: 50, zIndex: 'a1', locked: true }));

    // 单个或含锁定不可成组
    expect(store.canGroupNodes(['a'])).toBe(false);
    expect(store.canGroupNodes(['a', 'b'])).toBe(false);

    // 解锁后可成组
    store.updateNode('b', { locked: false });
    expect(store.canGroupNodes(['a', 'b'])).toBe(true);

    const groupId = store.groupNodes(['a', 'b'])!;
    expect(store.canUngroupNodes([groupId])).toBe(true);
    expect(store.canUngroupNodes(['a'])).toBe(false);
  });

  it('batch 支持传入自定义 groupId，将多次连续批次合并为单一步骤撤销', () => {
    const engine = new SkyNoteEngine();
    const store = engine.documentStore;
    store.addNode(makeNode('a', { x: 0, y: 0, width: 50, height: 50 }));
    store.clearHistory();

    const customGroupId = 'user-drag-session-1';
    store.batch(
      () => {
        store.updateNode('a', { x: 10 });
      },
      { groupId: customGroupId, label: '拖动中 1' }
    );

    store.batch(
      () => {
        store.updateNode('a', { x: 30 });
      },
      { groupId: customGroupId, label: '拖动中 2' }
    );

    store.batch(
      () => {
        store.updateNode('a', { x: 50 });
      },
      { groupId: customGroupId, label: '拖动完成' }
    );

    expect(store.getNode('a')?.x).toBe(50);
    // 一步撤销整体还原回 0
    expect(store.undo()).toBe(true);
    expect(store.getNode('a')?.x).toBe(0);
    expect(store.canUndo).toBe(false);
  });
});
