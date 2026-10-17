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

  it('当 outline 仅包含本体形状时，框外标签带依然通过 extent 参与精确拾取', () => {
    const engine = new SkyNoteEngine();
    engine.nodeTypes.register({
      type: 'frame-like',
      label: '画框类',
      defaultData: {},
      extent: (node) => ({ left: 0, top: -20, right: node.width, bottom: node.height }),
      // outline 仅为主体形状矩形
      outline: (node) => [
        { x: 0, y: 0 },
        { x: node.width, y: 0 },
        { x: node.width, y: node.height },
        { x: 0, y: node.height }
      ]
    });
    engine.documentStore.addNode(makeNode('f', { nodeType: 'frame-like', x: 100, y: 100 }));
    // 点在主体矩形内
    expect(engine.hitTestNode({ x: 150, y: 150 })?.id).toBe('f');
    // 点在头顶框外标签带内 (y=90 在 80~100 之间)
    expect(engine.hitTestNode({ x: 150, y: 90 })?.id).toBe('f');
    // 点在标签带更上方 (y=70 < 80)
    expect(engine.hitTestNode({ x: 150, y: 70 })).toBeUndefined();
  });

  it('textBlocks 变更时动态 extent 节点在空间索引中同步刷新范围，新扩展区域立即可拾取', () => {
    const engine = new SkyNoteEngine();
    engine.nodeTypes.register({
      type: 'dynamic-extent',
      label: '动态扩展',
      defaultData: {},
      extent: (node) => {
        const text = node.textBlocks?.[0]?.runs?.[0]?.text ?? '';
        const lines = text.split('\n').length;
        // 单行扩展 20，两行扩展 40
        return { left: 0, top: -(lines * 20), right: node.width, bottom: node.height };
      }
    });

    engine.documentStore.addNode(
      makeNode('dyn', {
        nodeType: 'dynamic-extent',
        x: 100,
        y: 100,
        textBlocks: [{ id: 'title', slot: 'title', runs: [{ text: 'line1' }] }]
      })
    );
    // 单行时 top 为 80 (100 - 20)
    expect(engine.hitTestNode({ x: 150, y: 85 })?.id).toBe('dyn');
    expect(engine.hitTestNode({ x: 150, y: 65 })).toBeUndefined();

    // 更新为两行
    engine.documentStore.updateNode('dyn', {
      textBlocks: [{ id: 'title', slot: 'title', runs: [{ text: 'line1\nline2' }] }]
    });

    // 两行时 top 向上延伸至 60 (100 - 40)，y=65 必须能被空间索引检出并命中
    expect(engine.hitTestNode({ x: 150, y: 65 })?.id).toBe('dyn');
    expect(engine.hitTestNode({ x: 150, y: 55 })).toBeUndefined();
  });

  it('自定义 hitTest 与 intersectsBounds：细长斜线与零高直线按几何距离拾取且不回退到空白外框角', () => {
    const engine = new SkyNoteEngine();
    engine.nodeTypes.register({
      type: 'diagonal-stroke',
      label: '斜向笔迹',
      defaultData: {},
      extent: (node) => ({ left: -4, top: -4, right: node.width + 4, bottom: node.height + 4 }),
      // 对角线 (0,0) -> (100,100)
      hitTest: (node, local, tolerance) => {
        const dist = Math.abs(local.x - local.y) / Math.SQRT2;
        return (
          local.x >= -tolerance &&
          local.x <= node.width + tolerance &&
          local.y >= -tolerance &&
          local.y <= node.height + tolerance &&
          dist <= tolerance + 2
        );
      },
      intersectsBounds: (_node, bounds) => {
        // 对角线 y = x 与局部矩形 [left, right] x [top, bottom] 相交当且仅当区间 [left, right] 与 [top, bottom] 重叠
        return Math.max(bounds.left, bounds.top) <= Math.min(bounds.right, bounds.bottom);
      }
    });

    // 1. 斜线节点 (100, 100) 尺寸 100x100
    engine.documentStore.addNode(makeNode('diag', { nodeType: 'diagonal-stroke', x: 100, y: 100 }));
    // 点在对角线上 (150, 150) 命中
    expect(engine.hitTestNode({ x: 150, y: 150 })?.id).toBe('diag');
    // 点在外框与 extent 内部但远离对角线的空白右上角 (190, 110) 绝不命中 (不回退到 extent)
    expect(engine.hitTestNode({ x: 190, y: 110 })).toBeUndefined();
    // 选框只擦过空白右上角 [180, 100, 195, 115] 时 intersectsNodeBounds 为 false
    expect(engine.intersectsNodeBounds('diag', { left: 180, top: 100, right: 195, bottom: 115 })).toBe(false);
    // 选框穿过对角线中段 [140, 140, 160, 160] 时 intersectsNodeBounds 为 true
    expect(engine.intersectsNodeBounds('diag', { left: 140, top: 140, right: 160, bottom: 160 })).toBe(true);

    // 2. 零高水平直线 (width=100, height=0)：靠屏幕拾取容差扩展粗筛后依然能命中
    engine.nodeTypes.register({
      type: 'zero-height-line',
      label: '水平线',
      defaultData: {},
      extent: (node) => ({ left: -2, top: -2, right: node.width + 2, bottom: 2 }),
      hitTest: (node, local, tolerance) =>
        local.x >= -tolerance && local.x <= node.width + tolerance && Math.abs(local.y) <= tolerance
    });
    engine.documentStore.addNode(
      makeNode('hline', { nodeType: 'zero-height-line', x: 300, y: 200, width: 100, height: 0 })
    );
    // 距离 y=200 偏离 4px (在默认 6px 容差内) 可拾取
    expect(engine.hitTestNode({ x: 350, y: 204 })?.id).toBe('hline');
    expect(engine.hitTestNode({ x: 350, y: 215 })).toBeUndefined();
    engine.destroy();
  });

  it('validate 专有结构校验与按版本缓存：损坏节点回退为基础外框拾取，且不每帧重复执行校验', () => {
    const engine = new SkyNoteEngine();
    let validateCalls = 0;
    engine.nodeTypes.register({
      type: 'strict-path',
      label: '严格路径',
      defaultData: { valid: true },
      validate: (node) => {
        validateCalls++;
        return (node.data as { valid?: boolean })?.valid === false ? '路径锚点数据损坏' : null;
      },
      extent: () => {
        throw new Error('损坏节点不应调用 extent');
      },
      hitTest: () => {
        throw new Error('损坏节点不应调用 hitTest');
      }
    });

    engine.documentStore.addNode(
      makeNode('bad', { nodeType: 'strict-path', x: 50, y: 50, width: 80, height: 60, data: { valid: false } })
    );
    const afterAddCalls = validateCalls;
    expect(afterAddCalls).toBe(1);

    // 连续多次拾取与校验查询复用 (nodeId, dataVersion, definition) 缓存，validateCalls 不再增加
    expect(engine.hitTestNode({ x: 70, y: 70 })?.id).toBe('bad');
    expect(engine.hitTestNode({ x: 10, y: 10 })).toBeUndefined();
    expect(
      engine.nodeTypes.validateNode(
        engine.documentStore.getNode('bad')!,
        engine.entityStore.getNode('bad')!.runtime.dataVersion
      )
    ).toBe('路径锚点数据损坏');
    expect(validateCalls).toBe(afterAddCalls);

    // 修复节点数据后 dataVersion 递增，缓存自动失效重算
    engine.nodeTypes.register({
      type: 'strict-path',
      label: '严格路径',
      defaultData: { valid: true },
      validate: (node) => {
        validateCalls++;
        return (node.data as { valid?: boolean })?.valid === false ? '路径锚点数据损坏' : null;
      },
      extent: (node) => ({ left: 0, top: -30, right: node.width, bottom: node.height })
    });
    engine.documentStore.updateNode('bad', { data: { valid: true } });
    // 修复后头顶 -30 扩展区立即可拾取
    expect(engine.hitTestNode({ x: 70, y: 30 })?.id).toBe('bad');
    engine.destroy();
  });

  it('节点类型晚于文档加载注册与卸载时自动刷新空间索引；beginMaintenance 同步通知会话冻结状态', () => {
    const engine = new SkyNoteEngine();
    engine.documentStore.addNode(makeNode('late', { nodeType: 'late-type', x: 100, y: 100, width: 100, height: 100 }));
    // 未注册类型时上方 y=85 不命中
    expect(engine.hitTestNode({ x: 150, y: 85 })).toBeUndefined();

    // 晚于文档注册类型：自动刷新空间索引，y=85 立即命中
    engine.nodeTypes.register({
      type: 'late-type',
      label: '延迟类型',
      defaultData: {},
      extent: (node) => ({ left: 0, top: -20, right: node.width, bottom: node.height })
    });
    expect(engine.hitTestNode({ x: 150, y: 85 })?.id).toBe('late');

    // 注销类型后恢复默认外框
    engine.nodeTypes.unregister('late-type');
    expect(engine.hitTestNode({ x: 150, y: 85 })).toBeUndefined();

    // 验证维护冻结会话通知 (含嵌套重入与幂等 resume)
    const maintenanceStates: boolean[] = [];
    engine.session.subscribe((change) => {
      if (change.maintenanceChanged) maintenanceStates.push(engine.session.inMaintenance);
    });
    expect(engine.session.inMaintenance).toBe(false);
    const m1 = engine.beginMaintenance();
    const m2 = engine.beginMaintenance();
    expect(engine.session.inMaintenance).toBe(true);
    expect(maintenanceStates).toEqual([true]);
    m1.resume();
    expect(engine.session.inMaintenance).toBe(true);
    m2.resume();
    m2.resume();
    expect(engine.session.inMaintenance).toBe(false);
    expect(maintenanceStates).toEqual([true, false]);
    engine.destroy();
  });
});
