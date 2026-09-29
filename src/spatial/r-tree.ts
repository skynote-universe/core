/**
 * @file r-tree.ts
 * @description 专为无限画布定制的高性能 R-Tree (层次包围盒) 空间拓扑索引
 *
 * 设计考量 (Why):
 * 1. 完美适应极端图元尺寸：自适应分层包络，无论是 10px 的小图标还是 10000px 的超大画框 Frame，
 *    内存占用严格为 O(1)，无网格哈希的格子膨胀与退化问题。
 * 2. 0 依赖纯数学实现：100% 遵守 AGENTS.md 极简依赖红线，跨平台零壁垒。
 * 3. 内存与删除加速：内部维护叶子节点直达映射，将传统 R-Tree 最慢的删除遍历加速至 O(树高)。
 * 4. 长时编辑不退化：删除时执行 CondenseTree（解散欠载节点并重插其条目、收缩单子根），
 *    空节点包围盒取「反向无穷」不参与并集；拖拽小步移动在原叶子范围内就地更新，免去删插。
 *    否则反复拖拽会堆积大量空叶子，并把根包围盒拉向原点，检索开销随编辑时长持续膨胀。
 * 5. STR 批量装载：初次加载或大批量变更时整体排序打包，建树速度与树形质量均优于逐条插入。
 */

import type { Point } from '../types/canvas';
import {
  type RectBounds,
  doBoundsIntersect,
  isPointInBounds
} from '../utils/geometry';
import type { SpatialIndex, SpatialIndexEntry } from './spatial-index';

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

/** 空节点包围盒：与任何矩形求并集都不产生影响，也不与任何查询相交 */
function createEmptyBounds(): RectBounds {
  return { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity, width: 0, height: 0 };
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

function computeChildrenBounds(children: readonly (RTreeNode | RTreeEntry)[]): RectBounds {
  let bounds = createEmptyBounds();
  for (let i = 0; i < children.length; i++) {
    bounds = unionBounds(bounds, children[i].bounds);
  }
  return bounds;
}

function containsBounds(outer: RectBounds, inner: RectBounds): boolean {
  return (
    inner.left >= outer.left &&
    inner.top >= outer.top &&
    inner.right <= outer.right &&
    inner.bottom <= outer.bottom
  );
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

function centerX(item: { bounds: RectBounds }): number {
  return item.bounds.left + item.bounds.right;
}

function centerY(item: { bounds: RectBounds }): number {
  return item.bounds.top + item.bounds.bottom;
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
        ob.right === bounds.right &&
        ob.bottom === bounds.bottom
      ) {
        return; // 包围盒无变化，直接跳过
      }

      // 拖拽小步移动的主路径：仍落在原叶子范围内时就地替换，只向上收紧包围盒
      const { leaf } = existing;
      if (containsBounds(leaf.bounds, bounds)) {
        const entry: RTreeEntry = { id: nodeId, bounds };
        leaf.children[leaf.children.indexOf(existing.entry)] = entry;
        existing.entry = entry;
        this.recalculateBoundsUpwards(leaf);
        return;
      }

      this.remove(nodeId);
    }

    this.insert({ id: nodeId, bounds });
  }

  /**
   * 批量插入或更新
   * 批量规模超过现有条目数时整体 STR 重建，否则逐条增量插入
   */
  load(entries: Iterable<SpatialIndexEntry>): void {
    const incoming: RTreeEntry[] = [];
    for (const [id, bounds] of entries) {
      incoming.push({ id, bounds });
    }

    if (incoming.length <= this.itemMap.size) {
      for (let i = 0; i < incoming.length; i++) {
        this.update(incoming[i].id, incoming[i].bounds);
      }
      return;
    }

    const merged = new Map<string, RTreeEntry>();
    for (const { entry } of this.itemMap.values()) {
      merged.set(entry.id, entry);
    }
    for (let i = 0; i < incoming.length; i++) {
      merged.set(incoming[i].id, incoming[i]);
    }
    this.rebuild(Array.from(merged.values()));
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
    leaf.children.splice(leaf.children.indexOf(entry), 1);
    this.itemMap.delete(nodeId);
    this.condense(leaf);
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
      bounds: createEmptyBounds(),
      children: []
    };
  }

  private insert(entry: RTreeEntry): void {
    const leaf = this.chooseSubtree(this.root, entry.bounds);
    leaf.children.push(entry);
    this.itemMap.set(entry.id, { entry, leaf });
    leaf.bounds = unionBounds(leaf.bounds, entry.bounds);

    if (leaf.children.length > this.maxEntries) {
      this.split(leaf);
    } else {
      this.recalculateBoundsUpwards(leaf);
    }
  }

  /**
   * CondenseTree：自删除位置向上，解散欠载的非根节点并收集其全部条目，最后统一重插
   */
  private condense(node: RTreeNode): void {
    const orphans: RTreeEntry[] = [];
    let curr = node;

    while (curr !== this.root) {
      const parent = curr.parent!;
      if (curr.children.length < this.minEntries) {
        parent.children.splice(parent.children.indexOf(curr), 1);
        this.collectEntries(curr, orphans);
      } else {
        curr.bounds = computeChildrenBounds(curr.children);
      }
      curr = parent;
    }
    this.root.bounds = computeChildrenBounds(this.root.children);

    // 收缩只剩单个子节点的根，降低树高
    while (!this.root.isLeaf && this.root.children.length === 1) {
      this.root = this.root.children[0] as RTreeNode;
      this.root.parent = undefined;
    }
    if (!this.root.isLeaf && this.root.children.length === 0) {
      this.root = this.createNode(true);
    }

    for (let i = 0; i < orphans.length; i++) {
      this.insert(orphans[i]);
    }
  }

  private collectEntries(node: RTreeNode, result: RTreeEntry[]): void {
    if (node.isLeaf) {
      for (let i = 0; i < node.children.length; i++) {
        result.push(node.children[i] as RTreeEntry);
      }
      return;
    }
    for (let i = 0; i < node.children.length; i++) {
      this.collectEntries(node.children[i] as RTreeNode, result);
    }
  }

  /**
   * STR (Sort-Tile-Recursive) 整体重建：按中心 x 切成竖条，条内按中心 y 排序后按容量打包，逐层向上
   */
  private rebuild(entries: RTreeEntry[]): void {
    this.itemMap.clear();
    if (entries.length === 0) {
      this.root = this.createNode(true);
      return;
    }

    let level = this.packLevel(entries, true);
    while (level.length > 1) {
      level = this.packLevel(level, false);
    }
    this.root = level[0];
    this.root.parent = undefined;
  }

  private packLevel(items: (RTreeNode | RTreeEntry)[], isLeaf: boolean): RTreeNode[] {
    const capacity = this.maxEntries;
    const nodeCount = Math.ceil(items.length / capacity);
    const sliceSize = Math.ceil(Math.sqrt(nodeCount)) * capacity;
    const result: RTreeNode[] = [];

    items.sort((a, b) => centerX(a) - centerX(b));
    for (let sliceStart = 0; sliceStart < items.length; sliceStart += sliceSize) {
      const slice = items.slice(sliceStart, sliceStart + sliceSize);
      slice.sort((a, b) => centerY(a) - centerY(b));

      for (let start = 0; start < slice.length; start += capacity) {
        const node = this.createNode(isLeaf);
        node.children = slice.slice(start, start + capacity);
        node.bounds = computeChildrenBounds(node.children);
        this.updateChildrenPointers(node);
        result.push(node);
      }
    }
    return result;
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

    // 二次方法挑出合并后浪费面积最大的一对种子项
    let seed1Idx = 0;
    let seed2Idx = 1;
    let maxDist = -Infinity;

    for (let i = 0; i < total - 1; i++) {
      const b1 = children[i].bounds;
      for (let j = i + 1; j < total; j++) {
        const b2 = children[j].bounds;
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

    let b1 = child1.bounds;
    let b2 = child2.bounds;

    // 将剩余条目分配给面积扩张更小的一方
    for (let i = 0; i < total; i++) {
      if (i === seed1Idx || i === seed2Idx) continue;
      const item = children[i];
      const ib = item.bounds;

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
        } else {
          this.itemMap.set(entry.id, { entry, leaf: node });
        }
      } else {
        (child as RTreeNode).parent = node;
      }
    }
  }

  /**
   * 自下而上刷新包围盒：原地求极值，仅在包围盒确实变化时才分配新对象；
   * 祖先包围盒未变即停止上溯 (小步拖拽绝大多数停在叶子层)。
   * 起始节点可能已被调用方预先写入新包围盒，因此无论其是否变化都至少上溯到父节点。
   */
  private recalculateBoundsUpwards(node: RTreeNode): void {
    this.refreshBounds(node);
    let curr = node.parent;
    while (curr && this.refreshBounds(curr)) {
      curr = curr.parent;
    }
  }

  /** 按子项重算节点包围盒，返回是否发生变化 */
  private refreshBounds(node: RTreeNode): boolean {
    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    const children = node.children;
    for (let i = 0; i < children.length; i++) {
      const b = children[i].bounds;
      if (b.left < left) left = b.left;
      if (b.top < top) top = b.top;
      if (b.right > right) right = b.right;
      if (b.bottom > bottom) bottom = b.bottom;
    }
    const current = node.bounds;
    if (current.left === left && current.top === top && current.right === right && current.bottom === bottom) {
      return false;
    }
    node.bounds = { left, top, right, bottom, width: right - left, height: bottom - top };
    return true;
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
