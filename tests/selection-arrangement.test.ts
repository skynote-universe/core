import { describe, expect, it } from 'vitest';
import { DocumentStore } from '../src/state/document-store';
import { computeNodeWorldBounds } from '../src/utils/geometry';
import {
  planNodeDistribution,
  planNodeAutoArrangement,
  resolveArrangementTargets,
  type NodeAlignment
} from '../src/layout/selection-arrangement';
import type { NodeEntity } from '../src/types/node';

function node(id: string, x = 0, y = 0, extra: Partial<NodeEntity> = {}): NodeEntity {
  return {
    id,
    type: 'node',
    nodeType: 'rect',
    x,
    y,
    width: 20,
    height: 10,
    rotation: 0,
    zIndex: 'a1',
    locked: false,
    ...extra
  };
}
function setup(nodes: NodeEntity[]) {
  const store = new DocumentStore();
  store.replaceContent({ nodes: Object.fromEntries(nodes.map((n) => [n.id, n])), connectors: {} });
  return store;
}
function bounds(store: DocumentStore, id: string) {
  return computeNodeWorldBounds(store.getNode(id)!, store.entityStore.getWorldTransform(id)!);
}

describe('节点对齐与等距分布', () => {
  it('自动网格按视觉行序排列，按列宽行高留间距，保持尺寸及父子关系，一步撤销且重复无操作', () => {
    const store = setup([
      node('a', 0, 0, { width: 40, height: 30 }),
      node('b', 100, 1, { width: 20, height: 10 }),
      node('c', 60, 100, { width: 60, height: 40 }),
      node('d', 130, 200, { width: 10, height: 20 })
    ]);
    const before = structuredClone(store.getView().content);
    expect(store.autoArrangeNodes(['d', 'b', 'c', 'a'])).not.toBeNull();
    expect(['a', 'b', 'c', 'd'].map((id) => ({ x: store.getNode(id)!.x, y: store.getNode(id)!.y }))).toEqual([
      { x: 0, y: 0 },
      { x: 80, y: 0 },
      { x: 0, y: 50 },
      { x: 80, y: 50 }
    ]);
    for (const id of ['a', 'b', 'c', 'd']) {
      const { x: _x, y: _y, ...rest } = store.getNode(id)!;
      const { x: _oldX, y: _oldY, ...oldRest } = before.nodes[id];
      expect(rest).toEqual(oldRest);
    }
    const after = structuredClone(store.getView().content);
    expect(store.autoArrangeNodes(['b', 'd', 'a', 'c'])).toBeNull();
    store.undo();
    expect(store.getView().content).toEqual(before);
    store.redo();
    expect(store.getView().content).toEqual(after);
  });

  it('自动排列按数量估算列数，空位保留，传入间距取整', () => {
    const store = setup(Array.from({ length: 5 }, (_, i) => node(String(i), i * 100, i * 30)));
    store.autoArrangeNodes(['4', '2', '0', '3', '1'], { gap: 10.6 });
    expect(['0', '1', '2', '3', '4'].map((id) => ({ x: store.getNode(id)!.x, y: store.getNode(id)!.y }))).toEqual([
      { x: 0, y: 0 },
      { x: 31, y: 0 },
      { x: 62, y: 0 },
      { x: 0, y: 21 },
      { x: 31, y: 21 }
    ]);
    expect(store.autoArrangeNodes(['0', '1'], { gap: NaN })).toBeNull();
    expect(store.autoArrangeNodes(['missing', '0'])).toBeNull();
  });

  it('自动排列复用父子过滤及旋转世界外框，容器内部拐点随动且不缩放内容', () => {
    const store = setup([
      node('p', 100, 100, { nodeType: 'frame', width: 100, height: 100, rotation: 30 }),
      node('child', 10, 10, { parentId: 'p' }),
      node('other', 300, 0),
      node('last', 400, 200)
    ]);
    const lineId = store.createConnector({ from: { nodeId: 'p' }, to: { nodeId: 'child' } })!;
    store.updateConnector(lineId, { controlPoints: [{ x: 150, y: 150 }] });
    const before = bounds(store, 'p');
    store.autoArrangeNodes(['last', 'child', 'p', 'other']);
    const after = bounds(store, 'p');
    expect(store.getNode('child')).toMatchObject({ x: 10, y: 10, parentId: 'p' });
    expect(store.getNode('p')).toMatchObject({ width: 100, height: 100, rotation: 30 });
    expect(store.getConnector(lineId)!.controlPoints).toEqual([
      { x: Math.round(150 + after.left - before.left), y: Math.round(150 + after.top - before.top) }
    ]);
  });

  it('自动排列尊重锁定、布局和维护锁', () => {
    const store = setup([
      node('p', 0, 0, { nodeType: 'frame', locked: true }),
      node('a', 20, 30, { parentId: 'p' }),
      node('b', 200, 200)
    ]);
    expect(store.autoArrangeNodes(['a', 'b'])).toBeNull();
    store.updateNodes(['p'], { locked: false, layout: { type: 'stack' } });
    store.updateNodes(['a'], { layoutItem: {} });
    expect(store.autoArrangeNodes(['a', 'b'])).toBeNull();
    const release = store.suspendWrites();
    expect(store.autoArrangeNodes(['p', 'b'])).toBeNull();
    release();
    expect(store.autoArrangeNodes(['p', 'b'])).not.toBeNull();
  });

  it('自动排列同坐标以ID排序，输入不被修改，不使用非传递的容差排序', () => {
    const items = ['c', 'a', 'b'].map((id) => ({ id, bounds: { left: 10, top: 10, right: 30, bottom: 20 } }));
    const before = structuredClone(items);
    expect(planNodeAutoArrangement(items)).toEqual([
      { id: 'a', delta: { x: 0, y: 0 } },
      { id: 'b', delta: { x: 40, y: 0 } },
      { id: 'c', delta: { x: 0, y: 30 } }
    ]);
    expect(items).toEqual(before);
  });
  it.each<[NodeAlignment, 'left' | 'right' | 'top' | 'bottom' | 'cx' | 'cy', number]>([
    ['left', 'left', 0],
    ['right', 'right', 110],
    ['center-x', 'cx', 55],
    ['top', 'top', 10],
    ['bottom', 'bottom', 70],
    ['center-y', 'cy', 40]
  ])('%s 以选区世界外框对齐并保持尺寸和旋转', (alignment, field, target) => {
    const store = setup([node('a', 0, 10), node('b', 80, 50, { width: 30, height: 20 })]);
    expect(store.alignNodes(['a', 'b'], alignment)).not.toBeNull();
    for (const id of ['a', 'b']) {
      const b = bounds(store, id);
      const actual = field === 'cx' ? (b.left + b.right) / 2 : field === 'cy' ? (b.top + b.bottom) / 2 : b[field];
      expect(actual).toBe(target);
    }
    expect(store.getNode('b')).toMatchObject({ width: 30, height: 20, rotation: 0 });
  });

  it.each(['horizontal', 'vertical'] as const)('%s 固定两端、均分不同尺寸节点的边缘间距，整步撤销重做', (axis) => {
    const vertical = axis === 'vertical';
    const store = setup([
      node('a', 0, 0, { width: 10, height: 10 }),
      node('b', 20, 20, { width: 30, height: 30 }),
      node('c', 100, 100, { width: 20, height: 20 })
    ]);
    const before = structuredClone(store.getView().content);
    expect(store.distributeNodes(['c', 'b', 'a'], axis)).not.toBeNull();
    expect(store.getNode('b')?.[vertical ? 'y' : 'x']).toBe(40);
    expect(store.getNode('b')?.[vertical ? 'x' : 'y']).toBe(20);
    expect(store.getNode('a')).toEqual(before.nodes.a);
    expect(store.getNode('c')).toEqual(before.nodes.c);
    const after = structuredClone(store.getView().content);
    store.undo();
    expect(store.getView().content).toEqual(before);
    store.redo();
    expect(store.getView().content).toEqual(after);
    expect(store.distributeNodes(['a', 'b', 'c'], axis)).toBeNull();
  });

  it('非整除跨度累计后取整，结果为整数且间距误差不超过1', () => {
    const store = setup([node('a'), node('b', 21), node('c', 80), node('d', 101)]);
    store.distributeNodes(['a', 'b', 'c', 'd'], 'horizontal');
    const xs = ['a', 'b', 'c', 'd'].map((id) => store.getNode(id)!.x);
    expect(xs.every(Number.isInteger)).toBe(true);
    const gaps = xs.slice(1).map((x, i) => x - xs[i] - 20);
    expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThanOrEqual(1);
    expect(xs[0]).toBe(0);
    expect(xs[3]).toBe(101);
  });

  it('旋转父容器内按世界轴对齐，只写入整数位置，不修改小数尺寸和朝向', () => {
    const store = setup([
      node('p', 30, 40, { nodeType: 'frame', width: 200, height: 100, rotation: 31 }),
      node('a', 5, 7, { parentId: 'p', width: 20.5, rotation: 17.5 }),
      node('b', 200, 80)
    ]);
    const target = Math.min(bounds(store, 'a').left, bounds(store, 'b').left);
    store.alignNodes(['a', 'b'], 'left');
    expect(Math.abs(bounds(store, 'a').left - target)).toBeLessThanOrEqual(1);
    expect(Math.abs(bounds(store, 'b').left - target)).toBeLessThanOrEqual(1);
    expect(store.getNode('a')).toMatchObject({ width: 20.5, rotation: 17.5 });
    expect(Number.isInteger(store.getNode('a')!.x)).toBe(true);
    expect(Number.isInteger(store.getNode('a')!.y)).toBe(true);
  });

  it('父子重复选择只移动容器一次，内部连线手动拐点随之移动', () => {
    const store = setup([
      node('p', 100, 100, { nodeType: 'frame', width: 200, height: 100 }),
      node('a', 5, 7, { parentId: 'p' }),
      node('b', 60, 7, { parentId: 'p' }),
      node('c')
    ]);
    const lineId = store.createConnector({ connectorType: 'straight', from: { nodeId: 'a' }, to: { nodeId: 'b' } })!;
    store.updateConnector(lineId, { controlPoints: [{ x: 150, y: 180 }] });
    expect(store.getNodeArrangementInfo(['p', 'a', 'b', 'c', 'p', 'missing'])).toEqual({ count: 2 });
    store.alignNodes(['p', 'a', 'b', 'c'], 'left');
    expect(store.getNode('p')!.x).toBe(0);
    expect(store.getNode('a')).toMatchObject({ x: 5, y: 7 });
    expect(store.getConnector(lineId)!.controlPoints).toEqual([{ x: 50, y: 180 }]);
    store.undo();
    expect(store.getNode('p')!.x).toBe(100);
    expect(store.getConnector(lineId)!.controlPoints).toEqual([{ x: 150, y: 180 }]);
  });

  it('锁定祖先或布局成员使整次操作禁用，数量不足和已对齐不提交', () => {
    const store = setup([
      node('p', 0, 0, { nodeType: 'frame', locked: true }),
      node('a', 100, 0, { parentId: 'p' }),
      node('b')
    ]);
    expect(store.getNodeArrangementInfo(['a', 'b'])).toEqual({ count: 2, blockedBy: 'locked' });
    expect(store.alignNodes(['a', 'b'], 'left')).toBeNull();
    expect(store.alignNodes(['b', 'missing'], 'left')).toBeNull();
    expect(store.distributeNodes(['a', 'b'], 'horizontal')).toBeNull();
    const layoutStore = setup([
      node('p', 0, 0, { nodeType: 'frame', layout: { type: 'stack' } }),
      node('a', 100, 0, { parentId: 'p', layoutItem: {} }),
      node('b')
    ]);
    expect(layoutStore.getNodeArrangementInfo(['a', 'b']).blockedBy).toBe('layout');
    expect(layoutStore.alignNodes(['a', 'b'], 'left')).toBeNull();
    expect(layoutStore.alignNodes(['p', 'b'], 'left')).toBeNull();
  });

  it('维护锁阻止提交', () => {
    const store = setup([node('a'), node('b', 100)]);
    const resume = store.suspendWrites();
    expect(store.alignNodes(['a', 'b'], 'left')).toBeNull();
    expect(store.getNode('b')!.x).toBe(100);
    resume();
    expect(store.alignNodes(['a', 'b'], 'left')).not.toBeNull();
  });

  it('12000层祖先与共享路径只迭代解析，不递归或重复遍历祖先', () => {
    const nodes = new Map<string, NodeEntity>();
    for (let i = 0; i < 12000; i++) nodes.set(String(i), node(String(i), 0, 0, i ? { parentId: String(i - 1) } : {}));
    let reads = 0;
    const result = resolveArrangementTargets([...nodes.keys()].reverse(), (id) => {
      reads++;
      return nodes.get(id);
    });
    expect(result.info).toEqual({ count: 1 });
    expect(result.nodes[0].id).toBe('0');
    expect(reads).toBeLessThan(60000);
  });

  it('负间距允许均匀重叠，排序不修改输入数组', () => {
    const items = [
      { id: 'c', bounds: { left: 10, right: 30, top: 0, bottom: 10 } },
      { id: 'b', bounds: { left: 1, right: 21, top: 0, bottom: 10 } },
      { id: 'a', bounds: { left: 0, right: 20, top: 0, bottom: 10 } }
    ];
    expect(planNodeDistribution(items, 'horizontal')).toEqual([
      { id: 'a', delta: { x: 0, y: 0 } },
      { id: 'b', delta: { x: 4, y: 0 } },
      { id: 'c', delta: { x: 0, y: 0 } }
    ]);
    expect(items.map((item) => item.id)).toEqual(['c', 'b', 'a']);
  });

  it('尺寸悬殊或显式compact时启用列高贪心平衡，消除超高图元下方的空白空洞', () => {
    // big 为超高图元 (高 200)，s1~s3 为小便签 (各高 20)
    const items = [
      { id: 'big', bounds: { left: 0, top: 0, right: 100, bottom: 200 } },
      { id: 's1', bounds: { left: 120, top: 0, right: 180, bottom: 20 } },
      { id: 's2', bounds: { left: 120, top: 30, right: 180, bottom: 50 } },
      { id: 's3', bounds: { left: 120, top: 60, right: 180, bottom: 80 } }
    ];
    // columns = ceil(sqrt(4)) = 2 列；gap 默认 20
    // 列 0 放 big (高 200)；列 1 依次堆叠 s1, s2, s3 (累加高度 20 + 20 + 20 + 20 + 20 = 100)
    const moves = planNodeAutoArrangement(items);
    // big 在列 0: x=0, y=0
    // s1 在列 1: x=120, y=0
    // s2 在列 1: x=120, y=40 (s1高20 + gap 20)
    // s3 在列 1: x=120, y=80 (s2底40 + 高20 + gap 20)
    expect(moves).toEqual([
      { id: 'big', delta: { x: 0, y: 0 } },
      { id: 's1', delta: { x: 0, y: 0 } },
      { id: 's2', delta: { x: 0, y: 10 } },
      { id: 's3', delta: { x: 0, y: 20 } }
    ]);
  });
});
