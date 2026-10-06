/**
 * @file outline.ts
 * @description 节点轮廓上的几何求解 (局部坐标，纯函数)：最近点投影、射线出口、默认吸附点
 *
 * 设计考量 (Why):
 * 1. 连线端点落在轮廓上而不是外框上：椭圆、菱形的出线点贴着图形本身，与悬停高亮、拾取共用同一份轮廓。
 * 2. 外法线即出线方向：正交折线据此垂直离开边框，曲线据此决定切线方向。
 */

import type { Point } from '../types/geometry';
import type { NodeEntity } from '../types/node';
import type { NodeTypeDefinition } from '../protocols/node-type.protocol';

/** 轮廓上的一点及该处的单位外法线 */
export interface OutlinePoint {
  readonly point: Point;
  readonly normal: Point;
}

/** 视为落在同一顶点的距离差：顶点处取相邻两边外法线的平均方向 */
const VERTEX_EPSILON = 1e-6;

/** 节点轮廓 (局部坐标)：节点类型声明的轮廓，缺省为外框矩形 */
export function resolveNodeOutline(
  node: Readonly<NodeEntity>,
  definition: NodeTypeDefinition | undefined
): readonly Point[] {
  return (
    definition?.outline?.(node as NodeEntity) ?? [
      { x: 0, y: 0 },
      { x: node.width, y: 0 },
      { x: node.width, y: node.height },
      { x: 0, y: node.height }
    ]
  );
}

/**
 * 每条边的单位外法线：按多边形绕向决定朝外的一侧 (y 轴向下时面积为正即顺时针)
 * 退化边 (长度为 0) 的法线为零向量，不参与方向求和
 */
function edgeNormals(outline: readonly Point[]): Point[] {
  let area = 0;
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i];
    const b = outline[(i + 1) % outline.length];
    area += a.x * b.y - b.x * a.y;
  }
  const sign = area >= 0 ? 1 : -1;
  return outline.map((a, i) => {
    const b = outline[(i + 1) % outline.length];
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length === 0) return { x: 0, y: 0 };
    return { x: (sign * (b.y - a.y)) / length, y: (-sign * (b.x - a.x)) / length };
  });
}

function normalize(v: Point): Point {
  const length = Math.hypot(v.x, v.y);
  return length === 0 ? { x: 0, y: 0 } : { x: v.x / length, y: v.y / length };
}

/** 轮廓上离 p 最近的点；恰好落在顶点时法线取相邻两边的平均方向 (菱形尖角朝外) */
export function projectOntoOutline(outline: readonly Point[], p: Point): OutlinePoint & { distance: number } {
  const normals = edgeNormals(outline);
  let best = Infinity;
  let point: Point = outline[0];
  let normal: Point = { x: 0, y: 0 };
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i];
    const b = outline[(i + 1) % outline.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSq = dx * dx + dy * dy;
    const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq));
    const q = { x: a.x + dx * t, y: a.y + dy * t };
    const distance = Math.hypot(p.x - q.x, p.y - q.y);
    if (distance < best - VERTEX_EPSILON) {
      best = distance;
      point = q;
      normal = normals[i];
    } else if (distance <= best + VERTEX_EPSILON) {
      normal = { x: normal.x + normals[i].x, y: normal.y + normals[i].y };
    }
  }
  return { point, normal: normalize(normal), distance: best };
}

/**
 * 从 from 射向 toward 的射线第一次穿出轮廓的位置 (from 通常为节点中心)
 * @returns 两点重合或射线与轮廓不相交时为 null
 */
export function outlineExit(outline: readonly Point[], from: Point, toward: Point): OutlinePoint | null {
  const rx = toward.x - from.x;
  const ry = toward.y - from.y;
  if (rx === 0 && ry === 0) return null;
  const normals = edgeNormals(outline);
  let bestT = Infinity;
  let hit: OutlinePoint | null = null;
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i];
    const b = outline[(i + 1) % outline.length];
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const denom = rx * ey - ry * ex;
    if (denom === 0) continue;
    // 射线参数 t (沿 from→toward) 与边参数 u (沿 a→b)
    const t = ((a.x - from.x) * ey - (a.y - from.y) * ex) / denom;
    const u = ((a.x - from.x) * ry - (a.y - from.y) * rx) / denom;
    if (t > 0 && u >= 0 && u <= 1 && t < bestT) {
      bestT = t;
      hit = { point: { x: from.x + rx * t, y: from.y + ry * t }, normal: normals[i] };
    }
  }
  return hit;
}

/**
 * 默认吸附点：轮廓包围盒四边中点在轮廓上的投影 (上、右、下、左)
 * 矩形即四边中点，菱形、椭圆即四个端点；浮动端在折线与曲线中也从这四点里选出线位置
 */
export function outlineAnchors(outline: readonly Point[]): OutlinePoint[] {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const p of outline) {
    left = Math.min(left, p.x);
    top = Math.min(top, p.y);
    right = Math.max(right, p.x);
    bottom = Math.max(bottom, p.y);
  }
  const cx = (left + right) / 2;
  const cy = (top + bottom) / 2;
  return [
    { x: cx, y: top },
    { x: right, y: cy },
    { x: cx, y: bottom },
    { x: left, y: cy }
  ].map((p) => {
    const { point, normal } = projectOntoOutline(outline, p);
    return { point, normal };
  });
}
