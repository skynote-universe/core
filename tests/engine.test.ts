/**
 * @file engine.test.ts
 * @description SkyNoteEngine 顶层闭环测试：空间网格视锥剔除、焦点栈 IME 守卫与插件沙盒
 */

import { describe, it, expect } from 'vitest';
import { SkyNoteEngine } from '../src/engine';
import { RTreeSpatialIndex } from '../src/spatial/r-tree';
import { InputScopeManager } from '../src/input/input-scope-manager';
import type { CanvasKeyboardEvent } from '../src/protocols/input-scope.protocol';
import { SyntheticPointerEvent, SyntheticWheelEvent } from '../src/input/synthetic-events';
import { StraightRouter, OrthogonalRouter } from '../src/registry/connector-router-registry';
import type { SkyNotePlugin, CanvasPluginContext } from '../src/protocols/plugin.protocol';
import type { NodeEntity } from '../src/types/node';

describe('RTreeSpatialIndex (默认底层层次包围盒索引)', () => {
  it('自适应超大画框 Frame 与微小图元共存', () => {
    const rtree = new RTreeSpatialIndex();

    // 跨越 10000 像素的巨型画框
    rtree.update('huge_frame', { left: 0, top: 0, right: 10000, bottom: 8000 });
    // 位于 [100, 100] 的普通便签
    rtree.update('note_1', { left: 100, top: 100, right: 250, bottom: 200 });
    // 画外极远节点
    rtree.update('far_away', { left: 50000, top: 50000, right: 50100, bottom: 50100 });

    // 检索屏幕视口 [0, 0] ~ [800, 600]
    const visible = rtree.search({ left: 0, top: 0, right: 800, bottom: 600 });
    expect(visible).toContain('huge_frame');
    expect(visible).toContain('note_1');
    expect(visible).not.toContain('far_away');

    // 点选拾取
    expect(rtree.hitTest({ x: 150, y: 150 })).toContain('note_1');
    expect(rtree.hitTest({ x: 150, y: 150 })).toContain('huge_frame');
    expect(rtree.hitTest({ x: 5000, y: 5000 })).toEqual(['huge_frame']);
  });

  it('移动与删除更新', () => {
    const rtree = new RTreeSpatialIndex();
    rtree.update('node_1', { left: 10, top: 10, right: 50, bottom: 50 });
    expect(rtree.hitTest({ x: 30, y: 30 })).toEqual(['node_1']);

    // 移动
    rtree.update('node_1', { left: 500, top: 500, right: 540, bottom: 540 });
    expect(rtree.hitTest({ x: 30, y: 30 })).toEqual([]);
    expect(rtree.hitTest({ x: 520, y: 520 })).toEqual(['node_1']);

    // 删除
    rtree.remove('node_1');
    expect(rtree.size).toBe(0);
    expect(rtree.hitTest({ x: 520, y: 520 })).toEqual([]);
  });
});

describe('InputScopeManager 焦点栈与 IME Guard 守卫', () => {
  it('按优先级自顶向下消费按键', () => {
    const manager = new InputScopeManager();
    const calls: string[] = [];

    // 低优先级画布全局
    manager.pushScope({
      id: 'canvas:global',
      priority: 0,
      onKeyDown: () => {
        calls.push('global');
      }
    });

    // 高优先级文本编辑态
    manager.pushScope({
      id: 'text:editing',
      priority: 100,
      onKeyDown: (e) => {
        calls.push('editing');
        e.stopPropagation(); // 阻止向下冒泡
      }
    });

    const mockEvent: CanvasKeyboardEvent = {
      key: 'Enter',
      code: 'Enter',
      shiftKey: false,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      isComposing: false,
      preventDefault: () => {},
      stopPropagation: () => {}
    };

    const handled = manager.dispatchKeyDown(mockEvent);
    expect(handled).toBe(true);
    expect(calls).toEqual(['editing']); // 被高优先级截断，global 不被调用
  });

  it('IME Guard 守卫：中文输入法拼音期间 (isComposing: true) 绝对放行，严禁打断输入', () => {
    const manager = new InputScopeManager();
    let shortcutTriggered = false;

    manager.pushScope({
      id: 'global',
      priority: 0,
      onKeyDown: (e) => {
        if (e.key === 'Backspace' || e.key === 'a') {
          shortcutTriggered = true;
          return true;
        }
      }
    });

    const imeEvent: CanvasKeyboardEvent = {
      key: 'a',
      code: 'KeyA',
      shiftKey: false,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      isComposing: true, // 正在打拼音
      preventDefault: () => {},
      stopPropagation: () => {}
    };

    const handled = manager.dispatchKeyDown(imeEvent);
    expect(handled).toBe(false);
    expect(shortcutTriggered).toBe(false); // 绝不触发快捷键！

    // Windows 平台 keyCode: 229 拼音组合键码守卫
    const winImeEvent: CanvasKeyboardEvent = {
      key: 'Process',
      code: 'KeyB',
      keyCode: 229,
      shiftKey: false,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      isComposing: false, // 某些 Windows 浏览器跳变时 isComposing 为 false
      preventDefault: () => {},
      stopPropagation: () => {}
    };
    expect(manager.dispatchKeyDown(winImeEvent)).toBe(false);
  });
});

describe('SkyNoteEngine 顶层闭环联动', () => {
  it('引擎装配、节点空间索引自动联动与插件生命周期', () => {
    const engine = new SkyNoteEngine();
    let pluginInstalled = false;
    let pluginUnmounted = false;

    // 自定义测试插件
    const testPlugin: SkyNotePlugin = {
      id: 'test-plugin',
      name: '测试插件',
      version: '1.0.0',
      install: (ctx: CanvasPluginContext) => {
        pluginInstalled = true;
        // 插件通过上下文提交新节点
        const node: NodeEntity = {
          id: 'plugin_node_1',
          type: 'node',
          nodeType: 'card',
          x: 200,
          y: 200,
          width: 120,
          height: 80,
          rotation: 0,
          zIndex: 'a1',
          locked: false
        };
        ctx.document.commit({
          label: '插件添加节点',
          patches: [
            {
              op: 'set',
              path: ['content', 'nodes', node.id],
              value: node
            }
          ]
        });
      },
      unmount: () => {
        pluginUnmounted = true;
      }
    };

    engine.use(testPlugin);
    expect(pluginInstalled).toBe(true);

    // 验证文档中节点已增加
    const view = engine.documentStore.getView();
    expect(Object.keys(view.content.nodes)).toEqual(['plugin_node_1']);

    // 验证空间索引自动联动生效！
    const hits = engine.spatialIndex.hitTest({ x: 250, y: 240 });
    expect(hits).toContain('plugin_node_1');

    // 移动节点
    engine.documentStore.moveEntities({ nodeIds: ['plugin_node_1'] }, { x: 300, y: 300 });
    // 原位置不再命中
    expect(engine.spatialIndex.hitTest({ x: 250, y: 240 })).not.toContain('plugin_node_1');
    // 新位置 [500, 500] 命中
    expect(engine.spatialIndex.hitTest({ x: 550, y: 540 })).toContain('plugin_node_1');

    // 销毁引擎
    engine.destroy();
    expect(pluginUnmounted).toBe(true);
    expect(engine.spatialIndex.size).toBe(0);
  });

  it('PointerDispatcher 指针优先级调度与插件卸载自动解绑', () => {
    const engine = new SkyNoteEngine();
    const eventSequence: string[] = [];

    // 高优先级手柄交互插件
    const handlePlugin: SkyNotePlugin = {
      id: 'handle-plugin',
      name: '手柄插件',
      version: '1.0.0',
      install: (ctx) => {
        // 使用 ctx.registerPointerHooks 注册高优先级监听
        ctx.registerPointerHooks(
          {
            onPointerDown: () => {
              eventSequence.push('handle');
            }
          },
          100
        );
      }
    };

    // 普通画布拖拽插件 (默认优先级 0)
    let dragMoveCount = 0;
    const dragPlugin: SkyNotePlugin = {
      id: 'drag-plugin',
      name: '拖拽插件',
      version: '1.0.0',
      install: (ctx) => {
        ctx.registerPointerHooks({
          onPointerDown: () => {
            eventSequence.push('drag');
          },
          onPointerMove: () => {
            dragMoveCount++;
          }
        });
      }
    };

    engine.use(handlePlugin);
    engine.use(dragPlugin);

    const mockPointerEvent = new SyntheticPointerEvent({
      point: { x: 100, y: 100 }
    });

    // 分发 PointerDown：按优先级从高到低先调用 handle，再调用 drag
    engine.pointer.dispatchPointerDown(mockPointerEvent);
    expect(eventSequence).toEqual(['handle', 'drag']);

    // 卸载 dragPlugin，验证指针监听被沙盒自动注销释放
    engine.plugins.remove('drag-plugin');
    engine.pointer.dispatchPointerMove(mockPointerEvent);
    expect(dragMoveCount).toBe(0); // 插件卸载后绝不响应后续事件！
  });

  it('PointerDispatcher 响应 stopPropagation 阻断后续低优先级派发', () => {
    const engine = new SkyNoteEngine();
    const calls: string[] = [];

    // 高优先级手柄：调用 stopPropagation 拦截传播
    engine.plugins.use({
      id: 'interceptor-plugin',
      name: '拦截插件',
      version: '1.0.0',
      install: (ctx) => {
        ctx.registerPointerHooks(
          {
            onPointerDown: (e) => {
              calls.push('interceptor');
              e.stopPropagation();
            }
          },
          100
        );
      }
    });

    // 低优先级画布插件
    engine.plugins.use({
      id: 'canvas-background-plugin',
      name: '画布背景插件',
      version: '1.0.0',
      install: (ctx) => {
        ctx.registerPointerHooks(
          {
            onPointerDown: () => {
              calls.push('canvas');
            }
          },
          0
        );
      }
    });

    const event = new SyntheticPointerEvent({ point: { x: 50, y: 50 } });
    engine.pointer.dispatchPointerDown(event);

    // 验证：高优先级拦截成功，低优先级未被调用
    expect(calls).toEqual(['interceptor']);
  });

  it('PluginManager 沙盒对通过 ctx.register* 注册的扩展进行全自动注销兜底', () => {
    const engine = new SkyNoteEngine();

    // 自定义插件：仅在 install 时通过 ctx 注册，且不编写任何 unmount 代码
    engine.plugins.use({
      id: 'dynamic-card-plugin',
      name: '动态卡片插件',
      version: '1.0.0',
      install: (ctx) => {
        ctx.registerNodeType({
          type: 'custom:dynamic-card',
          label: '动态卡片',
          defaultData: {}
        });
        ctx.registerArrowMarker({
          id: 'custom:special-arrow',
          label: '特殊箭头',
          width: 10,
          height: 10,
          lineOffset: 5,
          d: 'M 0 0 L -10 -5 L -10 5 Z'
        });
      }
    });

    // 确认已注册成功
    expect(engine.nodeTypes.has('custom:dynamic-card')).toBe(true);
    expect(engine.arrowMarkers.has('custom:special-arrow')).toBe(true);

    // 卸载插件
    engine.plugins.remove('dynamic-card-plugin');

    // 验证：沙盒全自动清退并注销了所有关联图元与箭头标记！彻底防止内存与状态残留！
    expect(engine.nodeTypes.has('custom:dynamic-card')).toBe(false);
    expect(engine.arrowMarkers.has('custom:special-arrow')).toBe(false);
  });

  it('ConnectorRouterRegistry 内置路由算法与插件自定义路由扩展', () => {
    const engine = new SkyNoteEngine();

    // 1. 测试内置直线路由
    const straightResult = engine.routers.get('straight').route({
      start: { point: { x: 0, y: 0 } },
      end: { point: { x: 100, y: 100 } },
      style: {}
    });
    expect(straightResult.points).toEqual([
      { x: 0, y: 0 },
      { x: 100, y: 100 }
    ]);

    // 2. 测试内置贝塞尔曲线路由
    const curvedResult = engine.routers.get('curved').route({
      start: { point: { x: 0, y: 0 }, direction: { x: 1, y: 0 } },
      end: { point: { x: 200, y: 100 }, direction: { x: -1, y: 0 } },
      style: {}
    });
    // 输出曲线采样点：首尾即两端点
    expect(curvedResult.points[0]).toEqual({ x: 0, y: 0 });
    expect(curvedResult.points[curvedResult.points.length - 1]).toEqual({ x: 200, y: 100 });
    expect(curvedResult.pathData).toBeDefined();
    expect(curvedResult.pathData?.startsWith('M 0 0 C')).toBe(true);

    // 3. 测试内置正交折线路由 (含圆角 cornerRadius 自动切角计算)
    const orthoResult = engine.routers.get('orthogonal').route({
      start: { point: { x: 0, y: 0 }, direction: { x: 1, y: 0 } },
      end: { point: { x: 100, y: 100 }, direction: { x: -1, y: 0 } },
      style: { cornerRadius: 8 }
    });
    expect(orthoResult.points.length).toBe(4);
    expect(orthoResult.pathData).toBeDefined();
    // 验证 pathData 中成功生成了平滑过渡的二阶贝塞尔切角 'Q' 指令
    expect(orthoResult.pathData?.includes('Q')).toBe(true);

    // 4. 插件注册自定义路由算法 (如思维导图专属 S 曲线)
    const customMindmapPlugin: SkyNotePlugin = {
      id: 'mindmap-router-plugin',
      name: '思维导图路由插件',
      version: '1.0.0',
      install: (ctx) => {
        ctx.registerConnectorRouter({
          id: 'mindmap:branch',
          label: '思维导图分支',
          route: (input) => ({
            points: [
              input.start.point,
              { x: (input.start.point.x + input.end.point.x) / 2, y: input.start.point.y },
              input.end.point
            ],
            pathData: `M ${input.start.point.x} ${input.start.point.y} Q ...`
          })
        });
      }
    };

    engine.use(customMindmapPlugin);
    expect(engine.routers.has('mindmap:branch')).toBe(true);

    const mindmapResult = engine.routers.get('mindmap:branch').route({
      start: { point: { x: 10, y: 10 } },
      end: { point: { x: 90, y: 50 } },
      style: {}
    });
    expect(mindmapResult.points[1]).toEqual({ x: 50, y: 10 });

    // 5. 验证路由类基于面向对象类实例构建
    expect(engine.routers.get('straight')).toBeInstanceOf(StraightRouter);
    expect(engine.routers.get('orthogonal')).toBeInstanceOf(OrthogonalRouter);

    // 6. 验证 ArrowMarkerRegistry 内置经典标记与别名映射
    expect(engine.arrowMarkers.get('arrow')).toBeDefined();
    expect(engine.arrowMarkers.get('arrow')?.id).toBe('standard:arrow');
    expect(engine.arrowMarkers.get('standard:diamond')?.width).toBe(12);
  });

  it('PointerDispatcher 滚轮事件 dispatchWheel 支持 stopPropagation 阻止滚轮穿透', () => {
    const engine = new SkyNoteEngine();
    const calls: string[] = [];

    // 高优先级局部滚动卡片插件
    engine.plugins.use({
      id: 'scrollable-card-plugin',
      name: '局部滚动卡片',
      version: '1.0.0',
      install: (ctx) => {
        ctx.registerPointerHooks(
          {
            onWheel: (e) => {
              calls.push('card-scroll');
              e.stopPropagation?.(); // 阻止滚动穿透至画布全屏
            }
          },
          100
        );
      }
    });

    // 底层全屏画布平移缩放插件
    engine.plugins.use({
      id: 'canvas-pan-zoom-plugin',
      name: '画布缩放平移',
      version: '1.0.0',
      install: (ctx) => {
        ctx.registerPointerHooks(
          {
            onWheel: () => {
              calls.push('canvas-zoom');
            }
          },
          0
        );
      }
    });

    const wheelEvent = new SyntheticWheelEvent({
      centerPoint: { x: 100, y: 100 },
      deltaZoom: 0.1
    });

    engine.pointer.dispatchWheel(wheelEvent);
    // 验证高优先级截断成功，底层画布没有被连带触发
    expect(calls).toEqual(['card-scroll']);
  });

  it('DocumentStore 与插件上下文支持 O(1) 瞬时只读实体检索 (getNode / getConnector)', () => {
    const engine = new SkyNoteEngine();

    engine.documentStore.addNode({
      id: 'node_alpha',
      type: 'node',
      nodeType: 'card',
      x: 50,
      y: 50,
      width: 100,
      height: 80,
      rotation: 0,
      zIndex: 'a1',
      locked: false
    });

    // 直接 O(1) 检索
    const node = engine.documentStore.getNode('node_alpha');
    expect(node).toBeDefined();
    expect(node?.width).toBe(100);

    // 插件上下文内同样支持 O(1) 检索
    let foundInPlugin = false;
    engine.plugins.use({
      id: 'query-test-plugin',
      name: '查询插件',
      version: '1.0.0',
      install: (ctx) => {
        const target = ctx.document.getNode('node_alpha');
        if (target && target.x === 50) {
          foundInPlugin = true;
        }
      }
    });

    expect(foundInPlugin).toBe(true);
  });
});

describe('SkyNoteEngine.createNode (新建节点统一入口)', () => {
  function setup() {
    const engine = new SkyNoteEngine();
    engine.nodeTypes.register({
      type: 'badge',
      label: '徽章',
      defaultData: { text: '' },
      createContent: (options: { text?: string }) => ({
        width: 80,
        height: 40,
        data: { text: options.text ?? '' }
      })
    });
    engine.nodeTypes.register({ type: 'static', label: '不可新建', defaultData: {} });
    return engine;
  }

  it('节点类型只给内容，公共字段由引擎补齐；新节点置于目标容器最上层，一步撤销', () => {
    const engine = setup();
    const store = engine.documentStore;
    const first = engine.documentStore.createNode({ nodeType: 'badge', x: 10, y: 20, options: { text: 'A' } })!;
    const second = engine.documentStore.createNode({ nodeType: 'badge', id: 'b', x: 0, y: 0, label: '添加徽章' });

    expect(second).toBe('b');
    expect(store.getNode(first)).toMatchObject({
      type: 'node',
      nodeType: 'badge',
      x: 10,
      y: 20,
      width: 80,
      height: 40,
      rotation: 0,
      locked: false,
      data: { text: 'A' }
    });
    expect(store.getNode('b')!.zIndex > store.getNode(first)!.zIndex).toBe(true);

    store.undo();
    expect(store.getNode('b')).toBeUndefined();
    expect(store.getNode(first)).toBeDefined();
    engine.destroy();
  });

  it('按中心放置并覆盖默认尺寸；挂到容器下时层级只在容器内比较', () => {
    const engine = setup();
    engine.documentStore.createNode({ nodeType: 'badge', id: 'frame', x: 0, y: 0, width: 400, height: 300 });
    engine.documentStore.createNode({
      nodeType: 'badge',
      id: 'c',
      parentId: 'frame',
      x: 100,
      y: 100,
      origin: 'center',
      width: 20
    });

    expect(engine.documentStore.getNode('frame')).toMatchObject({ width: 400, height: 300 });
    expect(engine.documentStore.getNode('c')).toMatchObject({ parentId: 'frame', x: 90, y: 80, width: 20, height: 40 });
    engine.destroy();
  });

  it('未注册或不支持新建的类型直接报错 (调用方编程错误)，id 冲突时拒绝提交', () => {
    const engine = setup();
    expect(() => engine.documentStore.createNode({ nodeType: 'missing', x: 0, y: 0 })).toThrow();
    expect(() => engine.documentStore.createNode({ nodeType: 'static', x: 0, y: 0 })).toThrow();
    engine.documentStore.createNode({ nodeType: 'badge', id: 'dup', x: 0, y: 0 });
    expect(engine.documentStore.createNode({ nodeType: 'badge', id: 'dup', x: 5, y: 5 })).toBeNull();
    engine.destroy();
  });

  it('getNodeOccupiedBounds 获取包含 extent 的实际占据包围盒', () => {
    const engine = setup();
    engine.nodeTypes.register({
      type: 'with-extent',
      label: '扩展节点',
      defaultData: {},
      createContent: () => ({ width: 200, height: 150 }),
      extent: (node) => ({ left: 0, top: -20, right: node.width, bottom: node.height })
    });
    engine.documentStore.createNode({ nodeType: 'with-extent', id: 'we', x: 100, y: 100, width: 200, height: 150 });
    // 普通外框不含 extent
    expect(engine.getNodeWorldBounds('we')).toEqual({ left: 100, top: 100, right: 300, bottom: 250 });
    // 实际占据范围包含 extent (top 延伸至 80)
    expect(engine.getNodeOccupiedBounds('we')).toEqual({ left: 100, top: 80, right: 300, bottom: 250 });
    engine.destroy();
  });
});
