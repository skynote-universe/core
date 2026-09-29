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

/** 参与旋转几何计算的节点字段 (rotation 单位为度，绕节点中心旋转；x / y / width / height 描述未旋转的框) */
export interface RotatableBox {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number;
}

/**
 * 把节点局部坐标 (相对未旋转框左上角) 变换为世界坐标：绕节点中心旋转 rotation 度
 */
export function nodeLocalToWorld(node: RotatableBox, localX: number, localY: number): Point {
  const angle = node.rotation ?? 0;
  if (angle === 0) return { x: node.x + localX, y: node.y + localY };

  const rad = (angle * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const dx = localX - node.width / 2;
  const dy = localY - node.height / 2;
  return {
    x: node.x + node.width / 2 + dx * cos - dy * sin,
    y: node.y + node.height / 2 + dx * sin + dy * cos
  };
}

/**
 * 求解节点在世界坐标系中的轴对齐包围盒：旋转节点取四角旋转后的外接矩形
 */
export function computeNodeBounds(node: RotatableBox): RectBounds {
  if (!node.rotation) {
    return {
      left: node.x,
      top: node.y,
      right: node.x + node.width,
      bottom: node.y + node.height,
      width: node.width,
      height: node.height
    };
  }

  const corners = [
    nodeLocalToWorld(node, 0, 0),
    nodeLocalToWorld(node, node.width, 0),
    nodeLocalToWorld(node, node.width, node.height),
    nodeLocalToWorld(node, 0, node.height)
  ];
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (let i = 0; i < corners.length; i++) {
    left = Math.min(left, corners[i].x);
    top = Math.min(top, corners[i].y);
    right = Math.max(right, corners[i].x);
    bottom = Math.max(bottom, corners[i].y);
  }
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

/**
 * 点是否落在节点 (含旋转) 的矩形框内：把点反向旋转回节点局部坐标后判断
 * 空间索引只按外接矩形粗筛，旋转节点外接矩形的四个空角需要此函数精判
 */
export function isPointInNode(point: Point, node: RotatableBox): boolean {
  let x = point.x;
  let y = point.y;
  if (node.rotation) {
    const rad = (-node.rotation * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const cx = node.x + node.width / 2;
    const cy = node.y + node.height / 2;
    const dx = point.x - cx;
    const dy = point.y - cy;
    x = cx + dx * cos - dy * sin;
    y = cy + dx * sin + dy * cos;
  }
  return x >= node.x && x <= node.x + node.width && y >= node.y && y <= node.y + node.height;
}
