/**
 * @file r-tree.ts
 * @description 专为无限画布定制的高性能 R-Tree (层次包围盒) 空间拓扑索引
 * 
 * 设计考量 (Why):
 * 1. 完美适应极端图元尺寸：自适应分层包络，无论是 10px 的小图标还是 10000px 的超大画框 Frame，
 *    内存占用严格为 O(1)，无网格哈希的格子膨胀与退化问题。
 * 2. 0 依赖纯数学实现：100% 遵守 AGENTS.md 极简依赖红线，跨平台零壁垒。
 * 3. 内存与删除加速：内部维护叶子节点直达映射，将传统 R-Tree 最慢的删除遍历加速至 O(树高)。
 */

import type { Point } from '../types/canvas';
import {
  type RectBounds,
  doBoundsIntersect,
  isPointInBounds
} from '../utils/geometry';
import type { SpatialIndex } from './spatial-index';

interface RTreeEntry {
  readonly id: string;
  readonly bounds: RectBounds;
}

interface RTreeNode {
  isLeaf: boolean;
  bounds: RectBounds;
  children: (RTreeNode | RTreeEntry)[];
  parent?: RTreeNode;
}

/** 计算两个矩形包围盒的最小联合外包矩形 (MBR) */
function unionBounds(a: RectBounds, b: RectBounds): RectBounds {
  const left = Math.min(a.left, b.left);
  const top = Math.min(a.top, b.top);
  const right = Math.max(a.right, b.right);
  const bottom = Math.max(a.bottom, b.bottom);
  return {
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top
  };
}

/** 计算包围盒面积 */
function calcArea(b: RectBounds): number {
  return Math.max(0, b.width) * Math.max(0, b.height);
}

/** 计算若合并两个包围盒所需的面积增量 (Enlargement) */
function calcEnlargement(target: RectBounds, added: RectBounds): number {
  const merged = unionBounds(target, added);
  return calcArea(merged) - calcArea(target);
}

export interface RTreeOptions {
  /** 节点最大子项容量 (推荐 9 ~ 16，默认 9) */
  maxEntries?: number;
  /** 节点最小容量阈值 (默认 Math.floor(maxEntries * 0.4)) */
  minEntries?: number;
}

export class RTreeSpatialIndex implements SpatialIndex {
  private readonly maxEntries: number;
  private readonly minEntries: number;

  private root: RTreeNode;
  /** 节点 ID 到所属条目及所在叶子节点的直接索引 (实现删除 O(树高) 极速定位) */
  private readonly itemMap = new Map<string, { entry: RTreeEntry; leaf: RTreeNode }>();

  constructor(options?: RTreeOptions) {
    this.maxEntries = Math.max(4, options?.maxEntries ?? 9);
    this.minEntries = Math.max(2, options?.minEntries ?? Math.floor(this.maxEntries * 0.4));
    this.root = this.createNode(true);
  }

  get size(): number {
    return this.itemMap.size;
  }

  /**
   * 插入或更新节点空间包围盒
   */
  update(nodeId: string, bounds: RectBounds): void {
    const existing = this.itemMap.get(nodeId);
    if (existing) {
      const ob = existing.entry.bounds;
      if (
        ob.left === bounds.left &&
        ob.top === bounds.top &&
        ob.width === bounds.width &&
        ob.height === bounds.height
      ) {
        return; // 包围盒无变化，直接跳过
      }
      this.remove(nodeId);
    }

    const entry: RTreeEntry = { id: nodeId, bounds };
    this.insert(entry);
  }

  /**
   * 移除指定节点
   */
  remove(nodeId: string): boolean {
    const record = this.itemMap.get(nodeId);
    if (!record) {
      return false;
    }

    const { entry, leaf } = record;
    const idx = leaf.children.indexOf(entry);
    if (idx !== -1) {
      leaf.children.splice(idx, 1);
    }
    this.itemMap.delete(nodeId);

    // 向上更新包围盒
    this.recalculateBoundsUpwards(leaf);
    return true;
  }

  /**
   * 获取指定节点的包围盒
   */
  getBounds(nodeId: string): RectBounds | undefined {
    return this.itemMap.get(nodeId)?.entry.bounds;
  }

  /**
   * 视锥相交检索
   */
  search(queryBounds: RectBounds): readonly string[] {
    const result: string[] = [];
    this.searchNode(this.root, queryBounds, result);
    return result;
  }

  /**
   * 点选碰撞拾取
   */
  hitTest(point: Point): readonly string[] {
    const result: string[] = [];
    this.hitTestNode(this.root, point, result);
    return result;
  }

  /**
   * 清空索引
   */
  clear(): void {
    this.root = this.createNode(true);
    this.itemMap.clear();
  }

  // ================= 内部 R-Tree 树核心算法 =================

  private createNode(isLeaf: boolean): RTreeNode {
    return {
      isLeaf,
      bounds: { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 },
      children: []
    };
  }

  private insert(entry: RTreeEntry): void {
    const leaf = this.chooseSubtree(this.root, entry.bounds);
    leaf.children.push(entry);
    this.itemMap.set(entry.id, { entry, leaf });

    if (leaf.children.length === 1) {
      leaf.bounds = { ...entry.bounds };
    } else {
      leaf.bounds = unionBounds(leaf.bounds, entry.bounds);
    }

    if (leaf.children.length > this.maxEntries) {
      this.split(leaf);
    } else {
      this.recalculateBoundsUpwards(leaf);
    }
  }

  /**
   * 贪心选择面积扩张最小的子树向下深入
   */
  private chooseSubtree(node: RTreeNode, bounds: RectBounds): RTreeNode {
    let curr = node;
    while (!curr.isLeaf) {
      let minEnlargement = Infinity;
      let bestChild: RTreeNode | null = null;
      let minArea = Infinity;

      for (let i = 0; i < curr.children.length; i++) {
        const child = curr.children[i] as RTreeNode;
        const enlargement = calcEnlargement(child.bounds, bounds);
        const area = calcArea(child.bounds);

        if (enlargement < minEnlargement) {
          minEnlargement = enlargement;
          minArea = area;
          bestChild = child;
        } else if (enlargement === minEnlargement && area < minArea) {
          minArea = area;
          bestChild = child;
        }
      }

      curr = bestChild!;
    }
    return curr;
  }

  /**
   * 节点分裂：将超出 maxEntries 的节点平分为两个节点
   */
  private split(node: RTreeNode): void {
    const children = node.children;
    const total = children.length;

    // 线性挑出最两端的种子项
    let seed1Idx = 0;
    let seed2Idx = 1;
    let maxDist = -Infinity;

    for (let i = 0; i < total - 1; i++) {
      const b1 = (children[i] as { bounds: RectBounds }).bounds;
      for (let j = i + 1; j < total; j++) {
        const b2 = (children[j] as { bounds: RectBounds }).bounds;
        const merged = unionBounds(b1, b2);
        const dist = calcArea(merged) - calcArea(b1) - calcArea(b2);
        if (dist > maxDist) {
          maxDist = dist;
          seed1Idx = i;
          seed2Idx = j;
        }
      }
    }

    const newNode = this.createNode(node.isLeaf);
    newNode.parent = node.parent;

    const child1 = children[seed1Idx];
    const child2 = children[seed2Idx];

    const group1 = [child1];
    const group2 = [child2];

    let b1 = { ...(child1 as { bounds: RectBounds }).bounds };
    let b2 = { ...(child2 as { bounds: RectBounds }).bounds };

    // 将剩余条目分配给面积扩张更小的一方
    for (let i = 0; i < total; i++) {
      if (i === seed1Idx || i === seed2Idx) continue;
      const item = children[i];
      const ib = (item as { bounds: RectBounds }).bounds;

      const e1 = calcEnlargement(b1, ib);
      const e2 = calcEnlargement(b2, ib);

      if (group1.length + (total - i) <= this.minEntries) {
        group1.push(item);
        b1 = unionBounds(b1, ib);
      } else if (group2.length + (total - i) <= this.minEntries) {
        group2.push(item);
        b2 = unionBounds(b2, ib);
      } else if (e1 < e2) {
        group1.push(item);
        b1 = unionBounds(b1, ib);
      } else {
        group2.push(item);
        b2 = unionBounds(b2, ib);
      }
    }

    node.children = group1;
    node.bounds = b1;

    newNode.children = group2;
    newNode.bounds = b2;

    // 更新叶子映射与父指针
    this.updateChildrenPointers(node);
    this.updateChildrenPointers(newNode);

    if (node === this.root) {
      // 根节点分裂，创建新根，树深度 +1
      const newRoot = this.createNode(false);
      newRoot.children = [node, newNode];
      newRoot.bounds = unionBounds(b1, b2);
      node.parent = newRoot;
      newNode.parent = newRoot;
      this.root = newRoot;
    } else {
      const parent = node.parent!;
      parent.children.push(newNode);
      newNode.parent = parent;
      parent.bounds = unionBounds(parent.bounds, newNode.bounds);

      if (parent.children.length > this.maxEntries) {
        this.split(parent);
      } else {
        this.recalculateBoundsUpwards(parent);
      }
    }
  }

  private updateChildrenPointers(node: RTreeNode): void {
    for (let i = 0; i < node.children.length; i++) {
      const child = node.children[i];
      if (node.isLeaf) {
        const entry = child as RTreeEntry;
        const mapped = this.itemMap.get(entry.id);
        if (mapped) {
          mapped.leaf = node;
        }
      } else {
        (child as RTreeNode).parent = node;
      }
    }
  }

  private recalculateBoundsUpwards(node: RTreeNode): void {
    let curr: RTreeNode | undefined = node;
    while (curr) {
      if (curr.children.length === 0) {
        curr.bounds = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
      } else {
        let b = { ...(curr.children[0] as { bounds: RectBounds }).bounds };
        for (let i = 1; i < curr.children.length; i++) {
          b = unionBounds(b, (curr.children[i] as { bounds: RectBounds }).bounds);
        }
        curr.bounds = b;
      }
      curr = curr.parent;
    }
  }

  private searchNode(node: RTreeNode, query: RectBounds, result: string[]): void {
    if (!doBoundsIntersect(node.bounds, query)) {
      return;
    }

    if (node.isLeaf) {
      for (let i = 0; i < node.children.length; i++) {
        const entry = node.children[i] as RTreeEntry;
        if (doBoundsIntersect(entry.bounds, query)) {
          result.push(entry.id);
        }
      }
    } else {
      for (let i = 0; i < node.children.length; i++) {
        this.searchNode(node.children[i] as RTreeNode, query, result);
      }
    }
  }

  private hitTestNode(node: RTreeNode, point: Point, result: string[]): void {
    if (!isPointInBounds(point, node.bounds)) {
      return;
    }

    if (node.isLeaf) {
      for (let i = 0; i < node.children.length; i++) {
        const entry = node.children[i] as RTreeEntry;
        if (isPointInBounds(point, entry.bounds)) {
          result.push(entry.id);
        }
      }
    } else {
      for (let i = 0; i < node.children.length; i++) {
        this.hitTestNode(node.children[i] as RTreeNode, point, result);
      }
    }
  }
}
