/**
 * @file orthogonal-route.ts
 * @description 正交折线寻路 (纯函数)：垂直离开边框，绕开两端节点，拐点尽量少
 *
 * 设计考量 (Why):
 * 1. 稀疏网格 + 最短路：候选线只取两端出线点、两端节点的外扩边界、两节点之间的中线，网格极小，拖动时逐帧重算无压力。
 *    只绕开两端节点，不避让途经的其他节点：避障与连线间的交叉优化留给智能路由插件。
 * 2. 代价 = 长度 + 拐弯惩罚：同样长度时少拐弯；中线略便宜，Z 形折线的竖段落在两节点正中而不是贴边。
 * 3. 两端外扩区域重叠 (节点挨得太近) 时不再避让两端，保证总有结果。
 */

import type { Point, RectBounds } from '../types/geometry';
import type { ConnectorRouteEnd } from '../protocols/connector-router.protocol';

/** 每拐一次弯折算的长度 (世界坐标) */
const BEND_COST = 80;
/** 小于该长度 (世界坐标) 的中间台阶会被抹平 */
const MIN_JOG = 4;
/** 不在中线上的线段代价略高，用于在等长路径中挑出居中的一条 */
const OFF_CENTER_FACTOR = 1.001;

type Axis = 'x' | 'y';

interface AxisDirection {
  readonly axis: Axis;
  readonly sign: 1 | -1;
}

/** 出线方向吸附到主轴；自由端按另一端的方位推断 (离开时朝向对方) */
function axisOf(direction: Point | undefined, from: Point, toward: Point): AxisDirection {
  const v = direction ?? { x: toward.x - from.x, y: toward.y - from.y };
  return Math.abs(v.x) >= Math.abs(v.y) ? { axis: 'x', sign: v.x < 0 ? -1 : 1 } : { axis: 'y', sign: v.y < 0 ? -1 : 1 };
}

function step(point: Point, dir: AxisDirection, distance: number): Point {
  return dir.axis === 'x'
    ? { x: point.x + dir.sign * distance, y: point.y }
    : { x: point.x, y: point.y + dir.sign * distance };
}

/** 轴向线段是否穿过矩形内部 (贴边不算) */
function crosses(a: Point, b: Point, r: RectBounds): boolean {
  if (a.y === b.y) {
    return a.y > r.top && a.y < r.bottom && Math.max(a.x, b.x) > r.left && Math.min(a.x, b.x) < r.right;
  }
  return a.x > r.left && a.x < r.right && Math.max(a.y, b.y) > r.top && Math.min(a.y, b.y) < r.bottom;
}

/** 两节点之间的中线；在该轴上重叠时取两出线点的中点 */
function midline(lo: number, hi: number, a?: RectBounds, b?: RectBounds, axis: Axis = 'x'): number {
  if (a && b) {
    const [aMin, aMax, bMin, bMax] =
      axis === 'x' ? [a.left, a.right, b.left, b.right] : [a.top, a.bottom, b.top, b.bottom];
    if (aMax < bMin) return (aMax + bMin) / 2;
    if (bMax < aMin) return (bMax + aMin) / 2;
  }
  return (lo + hi) / 2;
}

function uniqueSorted(values: number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

/** 按代价出队的最小堆 (状态编号 + 入堆时的代价，过期条目出队时跳过) */
class MinHeap {
  private readonly items: number[] = [];
  private readonly keys: number[] = [];

  get size(): number {
    return this.items.length;
  }

  push(item: number, key: number): void {
    const { items, keys } = this;
    let i = items.length;
    items.push(item);
    keys.push(key);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (keys[parent] <= key) break;
      items[i] = items[parent];
      keys[i] = keys[parent];
      i = parent;
    }
    items[i] = item;
    keys[i] = key;
  }

  /** 弹出代价最小的条目 */
  pop(): [item: number, key: number] {
    const { items, keys } = this;
    const top: [number, number] = [items[0], keys[0]];
    const lastItem = items.pop()!;
    const lastKey = keys.pop()!;
    if (items.length > 0) {
      let i = 0;
      for (;;) {
        const left = i * 2 + 1;
        if (left >= items.length) break;
        const right = left + 1;
        const child = right < items.length && keys[right] < keys[left] ? right : left;
        if (keys[child] >= lastKey) break;
        items[i] = items[child];
        keys[i] = keys[child];
        i = child;
      }
      items[i] = lastItem;
      keys[i] = lastKey;
    }
    return top;
  }
}

/**
 * 在候选网格上求最短路 (Dijkstra，状态含到达方向以计算拐弯)
 * @returns 从 from 到 to 的网格点序列；不连通时为 null
 */
function searchGrid(
  from: Point,
  fromAxis: Axis | null,
  to: Point,
  toAxis: Axis | null,
  xs: number[],
  ys: number[],
  obstacles: readonly RectBounds[],
  center: Point
): Point[] | null {
  const width = xs.length;
  const pointOf = (i: number): Point => ({ x: xs[i % width], y: ys[Math.floor(i / width)] });
  const blocked = (p: Point) => obstacles.some((r) => p.x > r.left && p.x < r.right && p.y > r.top && p.y < r.bottom);

  // 状态 = 网格点 × 到达轴 (0: x, 1: y)
  const count = xs.length * ys.length * 2;
  const cost = new Float64Array(count).fill(Infinity);
  const previous = new Int32Array(count).fill(-1);
  // 出发轴不限 (自由端) 时两个方向都作为起点，第一段走哪个方向都不算拐弯
  const queue = new MinHeap();
  const startPoint = (ys.indexOf(from.y) * width + xs.indexOf(from.x)) * 2;
  for (const axis of fromAxis === null ? [0, 1] : [fromAxis === 'x' ? 0 : 1]) {
    cost[startPoint + axis] = 0;
    queue.push(startPoint + axis, 0);
  }

  while (queue.size > 0) {
    const [current, queued] = queue.pop();
    if (queued > cost[current]) continue;
    const pointIndex = current >> 1;
    const arrivedAxis: Axis = current & 1 ? 'y' : 'x';
    const p = pointOf(pointIndex);
    // 进入终点方向与出线方向不一致的拐弯已计入代价，最先出队的状态即最优
    if (p.x === to.x && p.y === to.y) {
      const path: Point[] = [];
      for (let s = current; s >= 0; s = previous[s]) path.push(pointOf(s >> 1));
      return path.reverse();
    }
    const xi = pointIndex % width;
    const yi = Math.floor(pointIndex / width);
    const neighbors: [number, number, Axis][] = [
      [xi - 1, yi, 'x'],
      [xi + 1, yi, 'x'],
      [xi, yi - 1, 'y'],
      [xi, yi + 1, 'y']
    ];
    for (const [nx, ny, axis] of neighbors) {
      if (nx < 0 || ny < 0 || nx >= width || ny >= ys.length) continue;
      const q = { x: xs[nx], y: ys[ny] };
      if (blocked(q) || obstacles.some((r) => crosses(p, q, r))) continue;
      const length = Math.abs(q.x - p.x) + Math.abs(q.y - p.y);
      // 竖段在中竖线上、横段在中横线上视为居中
      const centered = axis === 'y' ? p.x === center.x : p.y === center.y;
      let next = cost[current] + length * (centered ? 1 : OFF_CENTER_FACTOR);
      if (axis !== arrivedAxis) next += BEND_COST;
      const isTarget = q.x === to.x && q.y === to.y;
      if (isTarget && toAxis !== null && axis !== toAxis) next += BEND_COST;
      const state = (ny * width + nx) * 2 + (axis === 'x' ? 0 : 1);
      if (next < cost[state]) {
        cost[state] = next;
        previous[state] = current;
        queue.push(state, next);
      }
    }
  }
  return null;
}

/** 去掉重合点与共线的中间点 */
function simplify(points: readonly Point[]): Point[] {
  const result: Point[] = [];
  for (const p of points) {
    const last = result[result.length - 1];
    if (last && last.x === p.x && last.y === p.y) continue;
    const before = result[result.length - 2];
    if (before && last && ((before.x === last.x && last.x === p.x) || (before.y === last.y && last.y === p.y))) {
      result[result.length - 1] = p;
      continue;
    }
    result.push(p);
  }
  return result;
}

/**
 * 正交折线路由
 * @param margin 离开节点边框的距离 (同时是绕行时与节点保持的间距)
 */
export function routeOrthogonal(start: ConnectorRouteEnd, end: ConnectorRouteEnd, margin: number): Point[] {
  const startDir = axisOf(start.direction, start.point, end.point);
  const endDir = axisOf(end.direction, end.point, start.point);
  // 自由端不需要离开边框
  const startStub = start.bounds ? step(start.point, startDir, margin) : start.point;
  const endStub = end.bounds ? step(end.point, endDir, margin) : end.point;
  // 自由端没有出线方向，不预先规定从哪个方向进出：按两端横纵距离推断的方向在两者接近时会来回翻转，
  // 拖动节点时整条折线随之跳动；交给寻路按拐弯最少选择，代价连续变化，最多在交界处切换一次
  const startAxis = start.direction ? startDir.axis : null;
  const endAxis = end.direction ? endDir.axis : null;

  const boxes = [start.bounds, end.bounds].filter((b): b is RectBounds => b !== undefined);
  const center = {
    x: midline(startStub.x, endStub.x, start.bounds, end.bounds, 'x'),
    y: midline(startStub.y, endStub.y, start.bounds, end.bounds, 'y')
  };
  // 外扩 margin 后的矩形；略小一点：沿外扩边界走线不算穿过
  const inflate = (b: RectBounds): RectBounds => ({
    left: b.left - margin + 1,
    top: b.top - margin + 1,
    right: b.right + margin - 1,
    bottom: b.bottom + margin - 1
  });
  const xs = [startStub.x, endStub.x, center.x];
  const ys = [startStub.y, endStub.y, center.y];
  for (const b of boxes) {
    xs.push(b.left - margin, b.right + margin);
    ys.push(b.top - margin, b.bottom + margin);
  }
  const path =
    searchGrid(
      startStub,
      startAxis,
      endStub,
      endAxis,
      uniqueSorted(xs),
      uniqueSorted(ys),
      boxes.map(inflate),
      center
    ) ??
    searchGrid(
      startStub,
      startAxis,
      endStub,
      endAxis,
      uniqueSorted([startStub.x, endStub.x, center.x]),
      uniqueSorted([startStub.y, endStub.y, center.y]),
      [],
      center
    )!;
  return simplify([start.point, ...path, end.point]);
}

/**
 * 经过手动拐点的正交折线：用户拖过的中间段保持不动，两端节点移动时只调整首尾两段
 * 第一个与最后一个手动点分别对齐到起点、终点的出线轴上，其余相邻点不在同一水平或竖直线上时补一个拐点
 */
export function routeOrthogonalThrough(
  start: ConnectorRouteEnd,
  end: ConnectorRouteEnd,
  controlPoints: readonly Point[]
): Point[] {
  const points = controlPoints.map((p) => ({ x: p.x, y: p.y }));
  const first = points[0];
  const last = points[points.length - 1];
  if (axisOf(start.direction, start.point, first).axis === 'x') first.y = start.point.y;
  else first.x = start.point.x;
  if (axisOf(end.direction, end.point, last).axis === 'x') last.y = end.point.y;
  else last.x = end.point.x;

  const full = [start.point, ...points, end.point];
  const result: Point[] = [full[0]];
  for (let i = 1; i < full.length; i++) {
    const a = result[result.length - 1];
    const b = full[i];
    if (a.x !== b.x && a.y !== b.y) {
      // 沿上一段的方向转弯：上一段竖直时先走水平，反之先走竖直
      const before = result[result.length - 2];
      const lastVertical = before ? before.x === a.x : axisOf(start.direction, a, b).axis === 'y';
      result.push(lastVertical ? { x: b.x, y: a.y } : { x: a.x, y: b.y });
    }
    result.push(b);
  }
  return removeJogs(simplify(result));
}

/**
 * 抹掉中间不足 MIN_JOG 的小台阶 (节点微移后手动点对齐出线轴、或反复拖段时留下)：
 * 把台阶一侧的那段平移到台阶另一侧的高度上，优先移动不连着端点的一侧；两侧都连着端点时保留
 */
function removeJogs(points: Point[]): Point[] {
  let path = points;
  for (let guard = 0; guard < path.length; guard++) {
    const last = path.length - 1;
    const k = path.findIndex(
      (p, i) => i >= 1 && i + 1 <= last - 1 && Math.hypot(path[i + 1].x - p.x, path[i + 1].y - p.y) < MIN_JOG
    );
    if (k < 0) break;
    const a = path[k];
    const b = path[k + 1];
    // 台阶竖直时它两侧是水平段，抹平即把一侧水平段的 y 对齐到另一侧
    const axis: Axis = a.x === b.x ? 'y' : 'x';
    const next = path.map((p) => ({ ...p }));
    if (k + 2 < last) {
      next[k + 1][axis] = a[axis];
      next[k + 2][axis] = a[axis];
    } else if (k - 1 > 0) {
      next[k][axis] = b[axis];
      next[k - 1][axis] = b[axis];
    } else {
      break;
    }
    path = simplify(next);
  }
  return path;
}
