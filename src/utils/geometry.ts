/**
 * @file geometry.ts
 * @description 纯函数 2D 几何计算、包围盒求解与视口自适应算法
 *
 * 设计考量 (Why):
 * 1. 纯函数铁律：所有几何函数严禁就地修改入参对象，必须计算并返回全新对象，确保撤销重做与并发计算无副作用。
 * 2. 跨平台纯数学：仅依赖基础数学运算符，零 DOM/Canvas 依赖，支持在 Node.js 和 Web Worker 中独立并行运行。
 */

import type { Point, ViewportState } from '../types';

/** 基础轴对齐包围盒 (AABB) */
export interface RectBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface FitViewportOptions {
  viewportWidth: number;
  viewportHeight: number;
  padding?: number;
  minZoom?: number;
  maxZoom?: number;
}

/** 数值区间钳位纯函数 */
export function clamp(val: number, min: number, max: number): number {
  return Math.min(Math.max(val, min), max);
}

/** 点是否在矩形包围盒内 */
export function isPointInBounds(point: Point, bounds: RectBounds): boolean {
  return point.x >= bounds.left && point.x <= bounds.right && point.y >= bounds.top && point.y <= bounds.bottom;
}

/** 两个矩形包围盒是否相交 (用于框选相交判定) */
export function doBoundsIntersect(a: RectBounds, b: RectBounds): boolean {
  return !(a.right < b.left || a.left > b.right || a.bottom < b.top || a.top > b.bottom);
}

/**
 * 求解多个节点的联合最小外包围盒 (AABB)
 * @param nodes 节点坐标与尺寸集合
 */
export function computeBoundingBox(
  nodes: Iterable<{ x: number; y: number; width: number; height: number }>
): RectBounds | null {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  let hasItems = false;

  for (const node of nodes) {
    hasItems = true;
    left = Math.min(left, node.x);
    top = Math.min(top, node.y);
    right = Math.max(right, node.x + node.width);
    bottom = Math.max(bottom, node.y + node.height);
  }

  if (!hasItems) {
    return null;
  }

  return {
    left,
    top,
    right,
    bottom,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top)
  };
}

/**
 * 计算将指定包围盒完全容纳在当前视口中央的 ViewportState (缩放与平移)
 */
export function computeViewportToFitBounds(bounds: RectBounds, options: FitViewportOptions): ViewportState | null {
  const { viewportWidth, viewportHeight, padding = 120, minZoom = 0.1, maxZoom = 2.0 } = options;

  if (viewportWidth <= 0 || viewportHeight <= 0 || bounds.width <= 0 || bounds.height <= 0) {
    return null;
  }

  const availableWidth = Math.max(1, viewportWidth - padding * 2);
  const availableHeight = Math.max(1, viewportHeight - padding * 2);

  const zoom = clamp(Math.min(availableWidth / bounds.width, availableHeight / bounds.height), minZoom, maxZoom);

  const centerX = bounds.left + bounds.width / 2;
  const centerY = bounds.top + bounds.height / 2;

  return {
    x: viewportWidth / 2 - centerX * zoom,
    y: viewportHeight / 2 - centerY * zoom,
    zoom
  };
}

/**
 * 构造带有转弯圆角平滑过渡的折线 SVG 路径指令 (M ... L ... Q ...)
 *
 * 设计考量 (Why):
 * 1. 纯函数铁律：严格纯数学计算，零修改入参，支持正交路由、多段折线或用户手动拐点。
 * 2. 动态自适应截断：圆角半径 r = min(cornerRadius, d1/2, d2/2)，防止超短线段发生圆角反向穿透畸变。
 * 3. 刀锋锐利切线：通过二阶贝塞尔曲线以原拐点为控制手柄，完美契合切线连续性 (C1 连续)。
 *
 * @param points 折线有序顶点集合 (至少 2 个点)
 * @param cornerRadius 拐点最大圆角半径 (若 <= 0 则生成直角直线路径)
 */
export function buildRoundedPolylinePath(points: readonly Point[], cornerRadius = 0): string {
  if (points.length === 0) return '';
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;
  if (points.length === 2 || cornerRadius <= 0) {
    let path = `M ${points[0].x} ${points[0].y}`;
    for (let i = 1; i < points.length; i++) {
      path += ` L ${points[i].x} ${points[i].y}`;
    }
    return path;
  }

  let path = `M ${points[0].x} ${points[0].y}`;

  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1];
    const curr = points[i];
    const next = points[i + 1];

    const v1x = prev.x - curr.x;
    const v1y = prev.y - curr.y;
    const v2x = next.x - curr.x;
    const v2y = next.y - curr.y;

    const d1 = Math.sqrt(v1x * v1x + v1y * v1y);
    const d2 = Math.sqrt(v2x * v2x + v2y * v2y);

    // 若相邻点重合，退化为普通直线连接
    if (d1 < 1e-4 || d2 < 1e-4) {
      path += ` L ${curr.x} ${curr.y}`;
      continue;
    }

    // 向量叉积：判定是否三点共线
    const cross = v1x * v2y - v1y * v2x;
    if (Math.abs(cross) < 1e-4) {
      path += ` L ${curr.x} ${curr.y}`;
      continue;
    }

    // 钳位最大圆角，防止相邻线段长度不足时发生互相侵入重叠
    const r = Math.min(cornerRadius, d1 / 2, d2 / 2);

    // 切入点与切出点
    const c1x = curr.x + (v1x / d1) * r;
    const c1y = curr.y + (v1y / d1) * r;
    const c2x = curr.x + (v2x / d2) * r;
    const c2y = curr.y + (v2y / d2) * r;

    path += ` L ${c1x} ${c1y} Q ${curr.x} ${curr.y}, ${c2x} ${c2y}`;
  }

  const last = points[points.length - 1];
  path += ` L ${last.x} ${last.y}`;

  return path;
}

/** 参与几何计算的节点字段：x / y / rotation 相对父容器 (ADR-114)，rotation 单位为度、绕节点中心旋转 */
export interface RotatableBox {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number;
}

/**
 * 二维仿射矩阵：x' = a·x + c·y + e，y' = b·x + d·y + f
 * 节点只有平移与旋转 (尺寸由 width / height 表达，不含缩放)，世界矩阵始终是刚体变换
 */
export interface Matrix2D {
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;
  readonly e: number;
  readonly f: number;
}

export const IDENTITY_MATRIX: Matrix2D = Object.freeze({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });

/** 矩阵复合：先应用 inner 再应用 outer */
export function multiplyMatrix(outer: Matrix2D, inner: Matrix2D): Matrix2D {
  return {
    a: outer.a * inner.a + outer.c * inner.b,
    b: outer.b * inner.a + outer.d * inner.b,
    c: outer.a * inner.c + outer.c * inner.d,
    d: outer.b * inner.c + outer.d * inner.d,
    e: outer.a * inner.e + outer.c * inner.f + outer.e,
    f: outer.b * inner.e + outer.d * inner.f + outer.f
  };
}

export function invertMatrix(m: Matrix2D): Matrix2D {
  const det = m.a * m.d - m.b * m.c;
  return {
    a: m.d / det,
    b: -m.b / det,
    c: -m.c / det,
    d: m.a / det,
    e: (m.c * m.f - m.d * m.e) / det,
    f: (m.b * m.e - m.a * m.f) / det
  };
}

export function applyMatrix(m: Matrix2D, x: number, y: number): Point {
  return { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f };
}

/** 只应用线性部分 (旋转)，用于把世界位移换算为父容器局部位移 */
export function applyMatrixToVector(m: Matrix2D, x: number, y: number): Point {
  return { x: m.a * x + m.c * y, y: m.b * x + m.d * y };
}

/**
 * 节点相对父容器的局部矩阵：平移到 (x, y) 后绕自身中心旋转
 * 等价于 Leafer 的 x / y + rotation + origin: 'center'
 */
export function computeNodeLocalMatrix(node: RotatableBox): Matrix2D {
  const angle = node.rotation ?? 0;
  if (angle === 0) return { a: 1, b: 0, c: 0, d: 1, e: node.x, f: node.y };
  const rad = (angle * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const cx = node.width / 2;
  const cy = node.height / 2;
  return {
    a: cos,
    b: sin,
    c: -sin,
    d: cos,
    e: node.x + cx - cos * cx + sin * cy,
    f: node.y + cy - sin * cx - cos * cy
  };
}

/**
 * computeNodeLocalMatrix 的逆运算：已知目标局部矩阵 (刚体) 与节点尺寸，求 x / y / rotation
 * 用于改挂容器时保持节点在世界中的位置与朝向不变
 */
export function decomposeNodeMatrix(
  m: Matrix2D,
  width: number,
  height: number
): { x: number; y: number; rotation: number } {
  const rad = Math.atan2(m.b, m.a);
  let rotation = (rad * 180) / Math.PI;
  // 消除 atan2 带来的 -0 与浮点噪声，保证未旋转的节点得到整洁的 0
  if (Math.abs(rotation) < 1e-9) rotation = 0;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const cx = width / 2;
  const cy = height / 2;
  return { x: m.e - cx + cos * cx - sin * cy, y: m.f - cy + sin * cx + cos * cy, rotation };
}

/** 节点局部坐标 (相对自身未旋转框左上角) 在给定世界矩阵下的世界坐标 */
export function nodeLocalToWorld(worldMatrix: Matrix2D, localX: number, localY: number): Point {
  return applyMatrix(worldMatrix, localX, localY);
}

/** 节点在世界坐标系中的轴对齐包围盒：四角经世界矩阵变换后的外接矩形 */
export function computeNodeWorldBounds(size: { width: number; height: number }, worldMatrix: Matrix2D): RectBounds {
  const m = worldMatrix;
  if (m.b === 0 && m.c === 0) {
    return {
      left: m.e,
      top: m.f,
      right: m.e + size.width,
      bottom: m.f + size.height,
      width: size.width,
      height: size.height
    };
  }
  const xs = [m.e, m.a * size.width + m.e, m.c * size.height + m.e, m.a * size.width + m.c * size.height + m.e];
  const ys = [m.f, m.b * size.width + m.f, m.d * size.height + m.f, m.b * size.width + m.d * size.height + m.f];
  const left = Math.min(xs[0], xs[1], xs[2], xs[3]);
  const top = Math.min(ys[0], ys[1], ys[2], ys[3]);
  const right = Math.max(xs[0], xs[1], xs[2], xs[3]);
  const bottom = Math.max(ys[0], ys[1], ys[2], ys[3]);
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

/**
 * 点是否落在节点 (含自身与祖先旋转) 的矩形框内：把世界点反变换回节点局部坐标后判断
 * 空间索引只按外接矩形粗筛，旋转节点外接矩形的四个空角需要此函数精判
 */
export function isPointInNode(point: Point, size: { width: number; height: number }, worldMatrix: Matrix2D): boolean {
  const local = applyMatrix(invertMatrix(worldMatrix), point.x, point.y);
  return local.x >= 0 && local.x <= size.width && local.y >= 0 && local.y <= size.height;
}
