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
  return (
    point.x >= bounds.left &&
    point.x <= bounds.right &&
    point.y >= bounds.top &&
    point.y <= bounds.bottom
  );
}

/** 两个矩形包围盒是否相交 (用于框选相交判定) */
export function doBoundsIntersect(a: RectBounds, b: RectBounds): boolean {
  return !(
    a.right < b.left ||
    a.left > b.right ||
    a.bottom < b.top ||
    a.top > b.bottom
  );
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
export function computeViewportToFitBounds(
  bounds: RectBounds,
  options: FitViewportOptions
): ViewportState | null {
  const {
    viewportWidth,
    viewportHeight,
    padding = 120,
    minZoom = 0.1,
    maxZoom = 2.0
  } = options;

  if (viewportWidth <= 0 || viewportHeight <= 0 || bounds.width <= 0 || bounds.height <= 0) {
    return null;
  }

  const availableWidth = Math.max(1, viewportWidth - padding * 2);
  const availableHeight = Math.max(1, viewportHeight - padding * 2);

  const zoom = clamp(
    Math.min(availableWidth / bounds.width, availableHeight / bounds.height),
    minZoom,
    maxZoom
  );

  const centerX = bounds.left + bounds.width / 2;
  const centerY = bounds.top + bounds.height / 2;

  return {
    x: viewportWidth / 2 - centerX * zoom,
    y: viewportHeight / 2 - centerY * zoom,
    zoom
  };
}
