/**
 * @file spatial-grid-index.ts
 * @description 空间网格哈希索引实现 (SpatialGridIndex)
 * 
 * 实现统一 SpatialIndex 接口，专用于密集常规图元高频动态拖拽。
 */

import type { Point } from '../types/canvas';
import {
  type RectBounds,
  doBoundsIntersect,
  isPointInBounds
} from '../utils/geometry';
import type { SpatialIndex } from './spatial-index';

export interface SpatialGridIndexOptions {
  /** 网格单元格标称边长 (像素，默认 512) */
  cellSize?: number;
}

export class SpatialGridIndex implements SpatialIndex {
  private readonly cellSize: number;
  private readonly grid = new Map<string, Set<string>>();
  private readonly boundsMap = new Map<string, RectBounds>();

  constructor(options?: SpatialGridIndexOptions) {
    this.cellSize = options?.cellSize ?? 512;
  }

  get size(): number {
    return this.boundsMap.size;
  }

  update(nodeId: string, bounds: RectBounds): void {
    const oldBounds = this.boundsMap.get(nodeId);
    if (
      oldBounds &&
      oldBounds.left === bounds.left &&
      oldBounds.top === bounds.top &&
      oldBounds.width === bounds.width &&
      oldBounds.height === bounds.height
    ) {
      return;
    }

    if (oldBounds) {
      this.removeFromGrid(nodeId, oldBounds);
    }

    this.boundsMap.set(nodeId, bounds);
    this.insertIntoGrid(nodeId, bounds);
  }

  remove(nodeId: string): boolean {
    const bounds = this.boundsMap.get(nodeId);
    if (!bounds) {
      return false;
    }

    this.removeFromGrid(nodeId, bounds);
    this.boundsMap.delete(nodeId);
    return true;
  }

  getBounds(nodeId: string): RectBounds | undefined {
    return this.boundsMap.get(nodeId);
  }

  search(queryBounds: RectBounds): readonly string[] {
    const minCol = Math.floor(queryBounds.left / this.cellSize);
    const maxCol = Math.floor(queryBounds.right / this.cellSize);
    const minRow = Math.floor(queryBounds.top / this.cellSize);
    const maxRow = Math.floor(queryBounds.bottom / this.cellSize);

    const candidates = new Set<string>();

    for (let r = minRow; r <= maxRow; r++) {
      for (let c = minCol; c <= maxCol; c++) {
        const key = `${c}:${r}`;
        const cell = this.grid.get(key);
        if (cell) {
          for (const id of cell) {
            candidates.add(id);
          }
        }
      }
    }

    const matched: string[] = [];
    for (const id of candidates) {
      const b = this.boundsMap.get(id);
      if (b && doBoundsIntersect(queryBounds, b)) {
        matched.push(id);
      }
    }

    return matched;
  }

  hitTest(point: Point): readonly string[] {
    const col = Math.floor(point.x / this.cellSize);
    const row = Math.floor(point.y / this.cellSize);
    const key = `${col}:${row}`;

    const cell = this.grid.get(key);
    if (!cell || cell.size === 0) {
      return [];
    }

    const matched: string[] = [];
    for (const id of cell) {
      const b = this.boundsMap.get(id);
      if (b && isPointInBounds(point, b)) {
        matched.push(id);
      }
    }

    return matched;
  }

  clear(): void {
    this.grid.clear();
    this.boundsMap.clear();
  }

  private insertIntoGrid(nodeId: string, bounds: RectBounds): void {
    const minCol = Math.floor(bounds.left / this.cellSize);
    const maxCol = Math.floor(bounds.right / this.cellSize);
    const minRow = Math.floor(bounds.top / this.cellSize);
    const maxRow = Math.floor(bounds.bottom / this.cellSize);

    for (let r = minRow; r <= maxRow; r++) {
      for (let c = minCol; c <= maxCol; c++) {
        const key = `${c}:${r}`;
        let cell = this.grid.get(key);
        if (!cell) {
          cell = new Set<string>();
          this.grid.set(key, cell);
        }
        cell.add(nodeId);
      }
    }
  }

  private removeFromGrid(nodeId: string, bounds: RectBounds): void {
    const minCol = Math.floor(bounds.left / this.cellSize);
    const maxCol = Math.floor(bounds.right / this.cellSize);
    const minRow = Math.floor(bounds.top / this.cellSize);
    const maxRow = Math.floor(bounds.bottom / this.cellSize);

    for (let r = minRow; r <= maxRow; r++) {
      for (let c = minCol; c <= maxCol; c++) {
        const key = `${c}:${r}`;
        const cell = this.grid.get(key);
        if (cell) {
          cell.delete(nodeId);
          if (cell.size === 0) {
            this.grid.delete(key);
          }
        }
      }
    }
  }
}
