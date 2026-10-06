/**
 * @file connector-routing.test.ts
 * @description 连线端点 (固定 / 浮动 / 自由)、边框吸附、正交折线绕行与连线命令
 */

import { describe, it, expect } from 'vitest';
import { SkyNoteEngine } from '../src/engine';
import { outlineAnchors, projectOntoOutline } from '../src/routing/outline';
import { parseNodeClipboard } from '../src/serialization/document-schema';
import type { NodeEntity } from '../src/types/node';
import type { Point, RectBounds } from '../src/types/geometry';

function makeNode(id: string, x: number, y: number, width = 100, height = 100): NodeEntity {
  return { id, type: 'node', nodeType: 'rect', x, y, width, height, rotation: 0, zIndex: `a${id}`, locked: false };
}

function setup() {
  const engine = new SkyNoteEngine();
  const store = engine.documentStore;
  store.addNode(makeNode('a', 0, 0));
  store.addNode(makeNode('b', 300, 0));
  return { engine, store };
}

/** 折线每段都水平或竖直 */
function isOrthogonal(points: readonly Point[]): boolean {
  return points.every((p, i) => i === 0 || p.x === points[i - 1].x || p.y === points[i - 1].y);
}

/** 折线是否穿过矩形内部 (贴边不算) */
function crossesInterior(points: readonly Point[], r: RectBounds): boolean {
  return points.some((p, i) => {
    if (i === 0) return false;
    const q = points[i - 1];
    const midX = (p.x + q.x) / 2;
    const midY = (p.y + q.y) / 2;
    const inside = (x: number, y: number) => x > r.left && x < r.right && y > r.top && y < r.bottom;
    return inside(midX, midY) || inside(p.x, p.y);
  });
}

describe('节点轮廓', () => {
  it('投影到最近的边并给出外法线；菱形顶点处取两边法线的平均 (朝外)', () => {
    const rect = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 50 },
      { x: 0, y: 50 }
    ];
    const hit = projectOntoOutline(rect, { x: 30, y: -10 });
    expect(hit.point).toEqual({ x: 30, y: 0 });
    expect(hit.normal).toEqual({ x: 0, y: -1 });

    const diamond = [
      { x: 50, y: 0 },
      { x: 100, y: 50 },
      { x: 50, y: 100 },
      { x: 0, y: 50 }
    ];
    const [top, right] = outlineAnchors(diamond);
    expect(top.point).toEqual({ x: 50, y: 0 });
    expect(top.normal.x).toBeCloseTo(0);
    expect(top.normal.y).toBeCloseTo(-1);
    expect(right.normal.x).toBeCloseTo(1);
  });
});

describe('连线端点吸附', () => {
  it('靠近吸附点 → 吸附点；靠近边框 → 边框上任一点 (按比例记录)；节点内部 → 浮动；空白 → 自由端', () => {
    const { engine } = setup();
    const anchor = engine.snapConnectorEndpoint({ x: 103, y: 52 });
    expect(anchor.kind).toBe('anchor');
    expect(anchor.endpoint).toEqual({ nodeId: 'a', anchor: { x: 1, y: 0.5 } });

    const outline = engine.snapConnectorEndpoint({ x: 97, y: 20 });
    expect(outline.kind).toBe('outline');
    expect(outline.endpoint).toEqual({ nodeId: 'a', anchor: { x: 1, y: 0.2 } });
    expect(outline.point).toEqual({ x: 100, y: 20 });

    expect(engine.snapConnectorEndpoint({ x: 40, y: 40 })).toMatchObject({ kind: 'node', endpoint: { nodeId: 'a' } });
    expect(engine.snapConnectorEndpoint({ x: 200, y: 200 })).toMatchObject({
      kind: 'free',
      endpoint: { position: { x: 200, y: 200 } }
    });
    // 吸附距离按屏幕像素计：放大后同样的世界距离不再吸附
    engine.session.setViewport({ zoom: 4 });
    expect(engine.snapConnectorEndpoint({ x: 97, y: 20 }).kind).toBe('node');
  });

  it('固定点按比例记录：节点改尺寸后仍落在边框上', () => {
    const { engine, store } = setup();
    const id = store.createConnector({
      connectorType: 'straight',
      from: { nodeId: 'a', anchor: { x: 1, y: 0.2 } },
      to: { position: { x: 500, y: 300 } }
    })!;
    expect(engine.getConnectorRoute(id)!.points[0]).toEqual({ x: 100, y: 20 });
    store.updateNode('a', { width: 200, height: 300 });
    expect(engine.getConnectorRoute(id)!.points[0]).toEqual({ x: 200, y: 60 });
  });
});

describe('路由', () => {
  it('直线浮动端落在中心连线与边框的交点', () => {
    const { engine, store } = setup();
    const id = store.createConnector({ connectorType: 'straight', from: { nodeId: 'a' }, to: { nodeId: 'b' } })!;
    expect(engine.getConnectorRoute(id)!.points).toEqual([
      { x: 100, y: 50 },
      { x: 300, y: 50 }
    ]);
  });

  it('折线浮动端取面向对方的边；默认圆角 8，未设置样式时仍生效', () => {
    const { engine, store } = setup();
    store.updateNode('b', { y: 400 });
    const id = store.createConnector({ from: { nodeId: 'a' }, to: { nodeId: 'b' } })!;
    const route = engine.getConnectorRoute(id)!;
    // b 在右下方且竖直距离更大：a 从底边出，b 从顶边进
    expect(route.points[0]).toEqual({ x: 50, y: 100 });
    expect(route.points[route.points.length - 1]).toEqual({ x: 350, y: 400 });
    expect(isOrthogonal(route.points)).toBe(true);
    expect(route.pathData).toContain('Q');
  });

  it('出线方向背对目标时绕开自身节点，不穿过两端节点', () => {
    const { engine, store } = setup();
    // 从 a 的左边出发连到右侧 b 的左边
    const id = store.createConnector({
      from: { nodeId: 'a', anchor: { x: 0, y: 0.5 } },
      to: { nodeId: 'b', anchor: { x: 0, y: 0.5 } }
    })!;
    const points = engine.getConnectorRoute(id)!.points;
    expect(points[0]).toEqual({ x: 0, y: 50 });
    // 先向左垂直离开边框
    expect(points[1].x).toBeLessThan(0);
    expect(points[1].y).toBe(50);
    expect(isOrthogonal(points)).toBe(true);
    expect(crossesInterior(points, engine.getNodeWorldBounds('a')!)).toBe(false);
    expect(crossesInterior(points, engine.getNodeWorldBounds('b')!)).toBe(false);
  });

  it('切换线型属于几何变更：立即按新路由器重算', () => {
    const { engine, store } = setup();
    store.updateNode('b', { y: 60 });
    const id = store.createConnector({ connectorType: 'straight', from: { nodeId: 'a' }, to: { nodeId: 'b' } })!;
    expect(engine.getConnectorRoute(id)!.points).toHaveLength(2);
    store.updateConnector(id, { connectorType: 'orthogonal' });
    expect(engine.getConnectorRoute(id)!.points.length).toBeGreaterThan(2);
  });

  it('经过手动点的折线抹掉中间的小台阶', () => {
    const { engine, store } = setup();
    const id = store.createConnector({
      from: { nodeId: 'a', anchor: { x: 1, y: 0.5 } },
      to: { position: { x: 400, y: 300 } }
    })!;
    // 手动点之间有 2 的小台阶 (y 150 → 152)
    store.updateConnector(id, {
      controlPoints: [
        { x: 140, y: 50 },
        { x: 140, y: 150 },
        { x: 200, y: 150 },
        { x: 200, y: 152 },
        { x: 260, y: 152 },
        { x: 260, y: 300 }
      ]
    });
    const points = engine.getConnectorRoute(id)!.points;
    for (let i = 1; i < points.length; i++) {
      const length = Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
      expect(length).toBeGreaterThanOrEqual(4);
    }
  });

  it('Z 形折线的竖段落在两节点正中', () => {
    const { engine, store } = setup();
    store.updateNode('b', { y: 60 });
    const id = store.createConnector({
      from: { nodeId: 'a', anchor: { x: 1, y: 0.5 } },
      to: { nodeId: 'b', anchor: { x: 0, y: 0.5 } }
    })!;
    expect(engine.getConnectorRoute(id)!.points).toEqual([
      { x: 100, y: 50 },
      { x: 200, y: 50 },
      { x: 200, y: 110 },
      { x: 300, y: 110 }
    ]);
  });
});

describe('连线命令', () => {
  it('删除只选中的连线；删除节点时依附连线一并删除', () => {
    const { store } = setup();
    const keep = store.createConnector({ from: { nodeId: 'a' }, to: { nodeId: 'b' } })!;
    const drop = store.createConnector({ from: { nodeId: 'a' }, to: { position: { x: 0, y: 500 } } })!;
    store.removeEntities({ connectorIds: [drop] });
    expect(store.getConnector(drop)).toBeUndefined();
    expect(store.getConnector(keep)).toBeDefined();
    store.removeEntities({ nodeIds: ['b'] });
    expect(store.getConnector(keep)).toBeUndefined();
  });

  it('单独复制连线：没有一起复制的一端改为停在原位的自由端；粘贴后整体偏移', () => {
    const { engine, store } = setup();
    const id = store.createConnector({ connectorType: 'straight', from: { nodeId: 'a' }, to: { nodeId: 'b' } })!;
    const payload = store.copyEntities({ connectorIds: [id] })!;
    expect(payload.nodes).toHaveLength(0);
    expect(payload.connectors[0].from).toEqual({ position: { x: 100, y: 50 } });

    const parsed = parseNodeClipboard(JSON.stringify(payload));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const pasted = store.pasteEntities(parsed.value, { x: 0, y: 200 });
    expect(pasted.nodeIds).toHaveLength(0);
    expect(engine.getConnectorRoute(pasted.connectorIds[0])!.points).toEqual([
      { x: 100, y: 250 },
      { x: 300, y: 250 }
    ]);
  });

  it('复制节点时带上一端是自由端的连线；创建副本返回节点与连线', () => {
    const { store } = setup();
    store.createConnector({ from: { nodeId: 'a' }, to: { position: { x: -200, y: 0 } } });
    store.createConnector({ from: { nodeId: 'a' }, to: { nodeId: 'b' } });
    const copies = store.duplicateEntities({ nodeIds: ['a'] }, { x: 0, y: 300 });
    expect(copies.nodeIds).toHaveLength(1);
    // 连到 b 的那条不属于 a 自身，不复制
    expect(copies.connectorIds).toHaveLength(1);
    expect(store.getConnector(copies.connectorIds[0])!.to).toEqual({ position: { x: -200, y: 300 } });
  });

  it('外部数据中的端点只保留一种状态', () => {
    const parsed = parseNodeClipboard(
      JSON.stringify({
        kind: 'skynote/nodes',
        version: 1,
        nodes: [],
        connectors: [
          {
            id: 'c',
            type: 'connector',
            connectorType: 'straight',
            from: { nodeId: 'x', anchor: { x: 1, y: 0 }, position: { x: 1, y: 1 } },
            to: { position: { x: 5, y: 5 }, anchor: { x: 0, y: 0 } },
            zIndex: 'a0',
            locked: false
          }
        ]
      })
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.connectors[0].from).toEqual({ nodeId: 'x', anchor: { x: 1, y: 0 } });
    expect(parsed.value.connectors[0].to).toEqual({ position: { x: 5, y: 5 } });
  });
});

describe('按层叠拾取', () => {
  it('盖住连线的无关节点优先；连线所连的节点与所在的画框在连线下方', () => {
    const { engine, store } = setup();
    const id = store.createConnector({ connectorType: 'straight', from: { nodeId: 'a' }, to: { nodeId: 'b' } })!;
    // 线 (100,50)→(300,50)；中间放一个低层节点与一个高层节点
    store.addNode({ ...makeNode('low', 150, 0, 20, 100), zIndex: 'Z0' });
    store.addNode({ ...makeNode('high', 220, 0, 20, 100), zIndex: 'aw' });
    // a、b 的层级为 'aa' / 'ab'，连线紧贴 b 上方：'Z0' 在其下，'aw' 在其上
    expect(engine.hitTest({ x: 160, y: 50 })).toMatchObject({ kind: 'connector', connector: { id } });
    expect(engine.hitTest({ x: 230, y: 50 })).toMatchObject({ kind: 'node', node: { id: 'high' } });
    // 端点节点本身不会盖住连线
    expect(engine.hitTest({ x: 99, y: 50 })).toMatchObject({ kind: 'connector' });
  });
});

describe('容器变换带动内部连线', () => {
  it('旋转画框：两端都在框内的连线，手动拐点随框旋转；连到框外与一端自由的连线不动', () => {
    const { engine, store } = setup();
    store.addNode(makeNode('frame', 0, 300, 200, 200));
    store.addNode({ ...makeNode('c', 10, 10, 20, 20), parentId: 'frame' });
    store.addNode({ ...makeNode('d', 160, 160, 20, 20), parentId: 'frame' });
    const inner = store.createConnector({ from: { nodeId: 'c' }, to: { nodeId: 'd' } })!;
    store.updateConnector(inner, { controlPoints: [{ x: 100, y: 320 }] });
    const outer = store.createConnector({ from: { nodeId: 'c' }, to: { nodeId: 'a' } })!;
    store.updateConnector(outer, { controlPoints: [{ x: 50, y: 200 }] });
    const dangling = store.createConnector({ from: { nodeId: 'c' }, to: { position: { x: 150, y: 450 } } })!;

    store.transformNodes([{ id: 'frame', frame: { cx: 100, cy: 400, width: 200, height: 200, rotation: 180 } }]);
    // 绕框中心 (100, 400) 转 180°
    const moved = store.getConnector(inner)!.controlPoints![0];
    expect(moved.x).toBeCloseTo(100);
    expect(moved.y).toBeCloseTo(480);
    expect(store.getConnector(outer)!.controlPoints).toEqual([{ x: 50, y: 200 }]);
    expect(store.getConnector(dangling)!.to).toEqual({ position: { x: 150, y: 450 } });
    expect(engine.getConnectorRoute(inner)).toBeDefined();
  });

  it('移动节点：一端自由的连线没选中时自由端不动，选中时整体平移', () => {
    const { store } = setup();
    const id = store.createConnector({ from: { nodeId: 'a' }, to: { position: { x: 500, y: 500 } } })!;
    store.moveEntities({ nodeIds: ['a'] }, { x: 30 });
    expect(store.getConnector(id)!.to).toEqual({ position: { x: 500, y: 500 } });
    store.moveEntities({ nodeIds: ['a'], connectorIds: [id] }, { x: 30 });
    expect(store.getConnector(id)!.to).toEqual({ position: { x: 530, y: 500 } });
  });
});

describe('线端与描边、粗线拾取', () => {
  it('线端外移半个描边宽度，箭头尖端停在描边外沿；描边变粗时重算，只改填充色时路由对象不变', () => {
    const { engine, store } = setup();
    store.updateNode('a', { style: { strokeWidth: 6 } });
    const id = store.createConnector({
      connectorType: 'straight',
      from: { nodeId: 'a', anchor: { x: 1, y: 0.5 } },
      to: { position: { x: 300, y: 50 } }
    })!;
    expect(engine.getConnectorRoute(id)!.points[0]).toEqual({ x: 103, y: 50 });

    store.updateNode('a', { style: { strokeWidth: 10 } });
    expect(engine.getConnectorRoute(id)!.points[0]).toEqual({ x: 105, y: 50 });

    const route = engine.getConnectorRoute(id);
    store.updateNode('a', { style: { fill: '$red' } });
    expect(engine.getConnectorRoute(id)).toBe(route);
  });

  it('粗线按画出来的宽度命中', () => {
    const { engine, store } = setup();
    const id = store.createConnector({
      connectorType: 'straight',
      from: { position: { x: 0, y: 300 } },
      to: { position: { x: 400, y: 300 } }
    })!;
    // 默认 2 宽：离线 10 不命中 (容差 6 + 半个线宽 1)
    expect(engine.hitTestConnector({ x: 200, y: 310 })).toBeUndefined();
    store.updateConnector(id, { style: { strokeWidth: 12 } });
    expect(engine.hitTestConnector({ x: 200, y: 310 })?.id).toBe(id);
  });
});

describe('拖动时折线不来回跳动', () => {
  it('一端自由的折线在障碍旁来回拖动：形状不翻转 (自由端不预设进入方向，避免两种走法代价打平)', () => {
    const { engine, store } = setup();
    // 截图布局：开始、是否通过、发布竖排，下方节点从右侧连出，自由端在上方
    store.addNode(makeNode('start', 90, 240, 115, 70));
    store.addNode(makeNode('check', 90, 355, 115, 70));
    store.addNode(makeNode('stop', 90, 470, 115, 70));
    store.addNode(makeNode('p', 65, 560, 140, 140));
    const id = store.createConnector({
      from: { nodeId: 'p', anchor: { x: 1, y: 0.5 } },
      to: { position: { x: 145, y: 85 } }
    })!;
    const shapeOf = () => {
      const points = engine.getConnectorRoute(id)!.points;
      const [a, b] = points.slice(-2);
      return `${points.length}${a.x === b.x ? 'v' : 'h'}`;
    };
    let flips = 0;
    let last = shapeOf();
    for (let i = 0; i < 300; i++) {
      store.moveEntities({ nodeIds: ['p'] }, { x: Math.sin(i / 7) * 3, y: Math.cos(i / 9) * 2 }, { groupId: 'drag' });
      const shape = shapeOf();
      if (shape !== last) flips++;
      last = shape;
    }
    expect(flips).toBe(0);
  });
});
