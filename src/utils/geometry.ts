/**
 * @file geometry.ts
 * @description 2D 几何纯函数：包围盒、仿射矩阵、视口换算与距离
 *
 * 所有函数不修改入参、返回新对象；类型定义见 types/geometry。
 */

import type { Matrix2D, Point, RectBounds, RotatableBox } from '../types/geometry';
import type { ViewportState } from '../types/canvas';
import type { CornerRadius } from '../types/style';

// ================= 数值与包围盒 =================

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function isPointInBounds(point: Point, bounds: RectBounds): boolean {
  return point.x >= bounds.left && point.x <= bounds.right && point.y >= bounds.top && point.y <= bounds.bottom;
}

export function doBoundsIntersect(a: RectBounds, b: RectBounds): boolean {
  return !(a.right < b.left || a.left > b.right || a.bottom < b.top || a.top > b.bottom);
}

/** 两点张成的包围盒 (框选区域) */
export function boundsFromPoints(a: Point, b: Point): RectBounds {
  return {
    left: Math.min(a.x, b.x),
    top: Math.min(a.y, b.y),
    right: Math.max(a.x, b.x),
    bottom: Math.max(a.y, b.y)
  };
}

/** 四周外扩 margin (视锥缓冲、拾取容差) */
export function expandBounds(bounds: RectBounds, margin: number): RectBounds {
  return {
    left: bounds.left - margin,
    top: bounds.top - margin,
    right: bounds.right + margin,
    bottom: bounds.bottom + margin
  };
}

export function unionBounds(a: RectBounds, b: RectBounds): RectBounds {
  return {
    left: Math.min(a.left, b.left),
    top: Math.min(a.top, b.top),
    right: Math.max(a.right, b.right),
    bottom: Math.max(a.bottom, b.bottom)
  };
}

/** 包围盒经矩阵变换后的轴对齐外接矩形 (四角变换后取极值；无旋转时只做平移) */
export function transformBounds(bounds: RectBounds, m: Matrix2D): RectBounds {
  if (m.b === 0 && m.c === 0 && m.a === 1 && m.d === 1) {
    return { left: bounds.left + m.e, top: bounds.top + m.f, right: bounds.right + m.e, bottom: bounds.bottom + m.f };
  }
  const { left: l, top: t, right: r, bottom: b } = bounds;
  const x1 = m.a * l + m.c * t;
  const x2 = m.a * r + m.c * t;
  const x3 = m.a * l + m.c * b;
  const x4 = m.a * r + m.c * b;
  const y1 = m.b * l + m.d * t;
  const y2 = m.b * r + m.d * t;
  const y3 = m.b * l + m.d * b;
  const y4 = m.b * r + m.d * b;
  return {
    left: Math.min(x1, x2, x3, x4) + m.e,
    top: Math.min(y1, y2, y3, y4) + m.f,
    right: Math.max(x1, x2, x3, x4) + m.e,
    bottom: Math.max(y1, y2, y3, y4) + m.f
  };
}

// ================= 仿射矩阵 =================

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

/** 矩阵的旋转角 (度) */
export function matrixRotation(m: Matrix2D): number {
  return (Math.atan2(m.b, m.a) * 180) / Math.PI;
}

// ================= 节点几何 =================

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
 * 写入文档的几何值去除矩阵运算的浮点噪声 (如 7e-15、89.99999999999999)，
 * 避免产生无意义的补丁与难读的数据；1e-9 远小于任何可见精度
 */
export function roundPersisted(value: number): number {
  const rounded = Math.round(value * 1e9) / 1e9;
  // 顺带把 -0 规整为 0
  return rounded === 0 ? 0 : rounded;
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
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const cx = width / 2;
  const cy = height / 2;
  return {
    x: roundPersisted(m.e - cx + cos * cx - sin * cy),
    y: roundPersisted(m.f - cy + sin * cx + cos * cy),
    rotation: roundPersisted((rad * 180) / Math.PI)
  };
}

/** 节点在世界坐标系中的轴对齐包围盒：自身框四角经世界矩阵变换后的外接矩形 */
export function computeNodeWorldBounds(size: { width: number; height: number }, worldMatrix: Matrix2D): RectBounds {
  return transformBounds({ left: 0, top: 0, right: size.width, bottom: size.height }, worldMatrix);
}

/** 点是否在闭合多边形内 (射线法，边界上的点视为在内的判定不作保证) */
export function isPointInPolygon(point: Point, polygon: readonly Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    if (a.y > point.y !== b.y > point.y && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

/** 世界坐标中的节点外框：中心、尺寸与绕中心的旋转角 (度) */
export interface WorldFrame {
  cx: number;
  cy: number;
  width: number;
  height: number;
  rotation: number;
}

/** 节点在世界坐标中的外框 (含自身与祖先旋转) */
export function computeWorldFrame(size: { width: number; height: number }, worldMatrix: Matrix2D): WorldFrame {
  const center = applyMatrix(worldMatrix, size.width / 2, size.height / 2);
  return { cx: center.x, cy: center.y, width: size.width, height: size.height, rotation: matrixRotation(worldMatrix) };
}

/** 世界外框对应的矩阵 (框局部坐标 → 世界坐标)，与 computeNodeLocalMatrix 同一约定 */
export function computeFrameMatrix(frame: WorldFrame): Matrix2D {
  return computeNodeLocalMatrix({
    x: frame.cx - frame.width / 2,
    y: frame.cy - frame.height / 2,
    width: frame.width,
    height: frame.height,
    rotation: frame.rotation
  });
}

// ================= 视口 =================

/** 视口像素坐标 → 世界坐标 */
export function screenToWorld(screen: Point, viewport: ViewportState): Point {
  return { x: (screen.x - viewport.x) / viewport.zoom, y: (screen.y - viewport.y) / viewport.zoom };
}

/** 世界坐标 → 视口像素坐标 */
export function worldToScreen(world: Point, viewport: ViewportState): Point {
  return { x: world.x * viewport.zoom + viewport.x, y: world.y * viewport.zoom + viewport.y };
}

/** 视口在世界坐标系中覆盖的区域 */
export function computeViewportWorldBounds(
  viewport: ViewportState,
  size: { width: number; height: number }
): RectBounds {
  return {
    left: -viewport.x / viewport.zoom,
    top: -viewport.y / viewport.zoom,
    right: (size.width - viewport.x) / viewport.zoom,
    bottom: (size.height - viewport.y) / viewport.zoom
  };
}

/**
 * 适配视口：缩放并平移使 bounds 居中且四周留白 padding (屏幕像素)；空画布 (null) 回到原点
 * 内容退化为一条线或一个点、或视口尚无尺寸时无法按面积适配，保持当前缩放 (不超过 maxZoom) 只居中
 */
export function computeFitViewport(
  bounds: RectBounds | null,
  size: { width: number; height: number },
  current: ViewportState,
  options: { padding: number; minZoom: number; maxZoom: number }
): ViewportState {
  if (!bounds) return { x: 0, y: 0, zoom: 1 };
  const width = bounds.right - bounds.left;
  const height = bounds.bottom - bounds.top;
  const zoom =
    width > 0 && height > 0 && size.width > 0 && size.height > 0
      ? clamp(
          Math.min(
            Math.max(1, size.width - options.padding * 2) / width,
            Math.max(1, size.height - options.padding * 2) / height
          ),
          options.minZoom,
          options.maxZoom
        )
      : Math.min(current.zoom, options.maxZoom);
  return {
    x: size.width / 2 - (bounds.left + width / 2) * zoom,
    y: size.height / 2 - (bounds.top + height / 2) * zoom,
    zoom
  };
}

// ================= 折线 =================

/** 点到线段的距离 */
export function distanceToSegment(point: Point, start: Point, end: Point): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq === 0 ? 0 : clamp(((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSq, 0, 1);
  return Math.hypot(point.x - (start.x + t * dx), point.y - (start.y + t * dy));
}

/** 点到折线的最小距离 (连线拾取) */
export function distanceToPolyline(point: Point, points: readonly Point[]): number {
  if (points.length === 1) return Math.hypot(point.x - points[0].x, point.y - points[0].y);
  let min = Infinity;
  for (let i = 0; i < points.length - 1; i++) {
    min = Math.min(min, distanceToSegment(point, points[i], points[i + 1]));
  }
  return min;
}

/**
 * 带圆角过渡的折线路径指令 (M ... L ... Q ...)
 * 圆角半径取 min(cornerRadius, 相邻两段各自一半)，短线段不会因圆角互相侵入
 */
export function buildRoundedPolylinePath(points: readonly Point[], cornerRadius = 0): string {
  if (points.length === 0) return '';
  let path = `M ${points[0].x} ${points[0].y}`;
  if (points.length === 1) return path;

  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1];
    const curr = points[i];
    const next = points[i + 1];
    const v1x = prev.x - curr.x;
    const v1y = prev.y - curr.y;
    const v2x = next.x - curr.x;
    const v2y = next.y - curr.y;
    const d1 = Math.hypot(v1x, v1y);
    const d2 = Math.hypot(v2x, v2y);
    // 无圆角、相邻点重合或三点共线时直接连到拐点
    if (cornerRadius <= 0 || d1 < 1e-4 || d2 < 1e-4 || Math.abs(v1x * v2y - v1y * v2x) < 1e-4) {
      path += ` L ${curr.x} ${curr.y}`;
      continue;
    }
    const r = Math.min(cornerRadius, d1 / 2, d2 / 2);
    path += ` L ${curr.x + (v1x / d1) * r} ${curr.y + (v1y / d1) * r}`;
    path += ` Q ${curr.x} ${curr.y}, ${curr.x + (v2x / d2) * r} ${curr.y + (v2y / d2) * r}`;
  }

  const last = points[points.length - 1];
  return `${path} L ${last.x} ${last.y}`;
}

/** 可按矩阵逐点换算的路径指令 (绝对坐标，参数都是坐标点) */
const POINT_COMMANDS = new Set(['M', 'L', 'Q', 'C', 'S', 'T']);

/**
 * 把路径指令按矩阵换算 (贝塞尔曲线在仿射变换下保持形状，逐个控制点换算即可)
 * @returns 含无法逐点换算的指令 (相对坐标、H / V、圆弧) 时为 undefined，调用方改用路由点
 */
export function transformPathData(pathData: string, m: Matrix2D): string | undefined {
  const tokens = pathData.match(/[A-Za-z]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g) ?? [];
  const out: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    const command = tokens[i++];
    if (command === 'Z' || command === 'z') {
      out.push('Z');
      continue;
    }
    if (!POINT_COMMANDS.has(command)) return undefined;
    out.push(command);
    const coords: string[] = [];
    while (i < tokens.length && !/[A-Za-z]/.test(tokens[i])) {
      const x = Number(tokens[i++]);
      const y = Number(tokens[i++]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;
      const p = applyMatrix(m, x, y);
      coords.push(`${p.x} ${p.y}`);
    }
    out.push(coords.join(', '));
  }
  return out.join(' ');
}

// ================= 圆角 =================

/** 圆角的四个角，与 CornerRadius 数组顺序一致：左上、右上、右下、左下 */
export type RadiusCorner = 0 | 1 | 2 | 3;

/** 圆角展开为四角 (单值即四角相同) */
export function expandCornerRadius(radius: CornerRadius | undefined): [number, number, number, number] {
  const r = radius ?? 0;
  return typeof r === 'number' ? [r, r, r, r] : [...r];
}

/** 四角圆角收拢：四角相同时存为单值，保持文档数据最简 */
export function compactCornerRadius(corners: readonly [number, number, number, number]): CornerRadius {
  return corners.every((r) => r === corners[0]) ? corners[0] : [...corners];
}
