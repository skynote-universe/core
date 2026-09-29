/**
 * @file scene-spatial-index.ts
 * @description 分层节点空间索引 (ADR-114)：每个容器以自身局部坐标索引直接子节点的子树包围盒
 *
 * 设计考量 (Why):
 * 1. 移动容器 O(1)：后代局部坐标不变，只需更新容器在父容器索引中的一个条目；
 *    扁平世界索引要逐个更新全部后代 (2000 个子节点约 3.5ms/帧)，且需先求出每个后代的世界矩阵。
 * 2. 条目为子树包围盒 (自身框 ∪ 全部后代)：检索时只有与查询区相交的容器才会下钻，
 *    子节点伸出未裁剪的容器外时同样能被检出。
 * 3. 检索语义：不漏掉任何真实框 (含旋转) 与查询区相交的节点，结果都满足世界外接矩形相交。
 *    下钻时在各容器局部坐标中比较，比扁平世界外接矩形更紧 (旋转节点外接矩形的空角不会误检)。
 * 4. 热路径零矩阵：根层级的局部坐标即世界坐标，根层级节点直接用登记时的自身外接矩形判定；
 *    只有嵌套节点才按需求世界矩阵。未旋转的叶子节点登记时也不构造矩阵。
 * 5. 子树包围盒自底向上增量维护：子条目变化只有触及原并集边界时才重算该容器的并集，否则 O(1) 扩张或不变；
 *    根层级没有上级，不维护并集。
 * 6. 批量写入：一次变更中的条目按容器缓冲后以 load 一次写入，大批量新增 (导入、粘贴) 时 R-Tree 走 STR 整体装载，
 *    逐条插入会让树的装箱质量变差，之后每次更新与检索都更慢。
 * 7. 每个容器的索引由工厂创建 (默认 R-Tree)，算法仍可热插拔。
 */

import type { Point } from '../types/canvas';
import type { NodeChanges } from '../types/change-set';
import type { NodeEntity } from '../types/node';
import type { EntityReader } from '../state/entity-store';
import type { SpatialIndex, SpatialIndexEntry } from './spatial-index';
import {
  computeNodeLocalMatrix,
  computeNodeWorldBounds,
  doBoundsIntersect,
  invertMatrix,
  nodeLocalBox,
  transformBounds,
  unionBounds,
  type RectBounds
} from '../utils/geometry';

/** 容器键：节点 id，undefined 为根层级 (含父节点缺失而回落根层级的孤儿) */
type ContainerKey = string | undefined;

interface ContainerState {
  readonly index: SpatialIndex;
  readonly members: Set<string>;
  /** 直接子条目的并集 (容器局部坐标)；stale 时下次读取按成员重算 */
  union: RectBounds | null;
  stale: boolean;
}

/** 节点的登记信息 (就地更新，拖拽热路径不重复分配) */
interface Placement {
  container: ContainerKey;
  /** 子树包围盒在所属容器局部坐标中的外接矩形 (即索引中的条目) */
  entry: RectBounds;
  /** 自身框在所属容器局部坐标中的外接矩形 */
  own: RectBounds;
  /** 是否有已登记的子节点 (有则 entry 为子树包围盒，检索时需下钻) */
  hasChildren: boolean;
}

/** 节点空间检索的只读接口 (对引擎之外暴露)；索引由引擎按变更集维护 */
export interface NodeSpatialQuery {
  readonly size: number;
  /** 可能与查询区相交的节点：包含全部真实框相交者，且都满足世界外接矩形相交 */
  search(queryBounds: RectBounds): readonly string[];
  /** 世界外接矩形包含该点的候选节点 (精判由调用方按实际框完成) */
  hitTest(point: Point): readonly string[];
  /** 节点自身的世界外接矩形 */
  getBounds(nodeId: string): RectBounds | undefined;
  /** 全部节点 (含伸出容器的后代) 的世界外接矩形，空画布为 null；用于适配视口，O(根层级节点数) */
  getContentBounds(): RectBounds | null;
}

function boundsEqual(a: RectBounds, b: RectBounds): boolean {
  return a.left === b.left && a.top === b.top && a.right === b.right && a.bottom === b.bottom;
}

/** 条目触及并集边界：移除或缩小它可能使并集收缩，需要重算 */
function touchesEdge(entry: RectBounds, union: RectBounds): boolean {
  return (
    entry.left <= union.left || entry.top <= union.top || entry.right >= union.right || entry.bottom >= union.bottom
  );
}

/** 自身框在父容器局部坐标中的外接矩形；未旋转时直接由 x / y / 尺寸得出 */
function computeOwnBounds(node: Readonly<NodeEntity>): RectBounds {
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
  return computeNodeWorldBounds(node, computeNodeLocalMatrix(node));
}

export class SceneSpatialIndex implements NodeSpatialQuery {
  private readonly containers = new Map<ContainerKey, ContainerState>();
  private readonly placements = new Map<string, Placement>();
  /** applyChanges 期间按容器缓冲的索引写入 */
  private readonly pendingWrites = new Map<ContainerKey, SpatialIndexEntry[]>();

  constructor(
    private readonly entities: EntityReader,
    private readonly createIndex: () => SpatialIndex
  ) {}

  get size(): number {
    return this.placements.size;
  }

  /** 按当前实体全量重建：自深向浅计算子树包围盒，每个容器以批量装载建索引 */
  rebuild(): void {
    this.clear();
    const depthCache = new Map<string, number>();
    const depthOf = (node: Readonly<NodeEntity>): number => {
      let depth = depthCache.get(node.id);
      if (depth === undefined) {
        const parent = node.parentId === undefined ? undefined : this.entities.getNode(node.parentId)?.entity;
        depth = parent ? depthOf(parent) + 1 : 0;
        depthCache.set(node.id, depth);
      }
      return depth;
    };
    const nodes = this.entities.getAllNodes().map((runtimeNode) => runtimeNode.entity);
    nodes.sort((a, b) => depthOf(b) - depthOf(a));

    const pending = new Map<ContainerKey, SpatialIndexEntry[]>();
    for (const node of nodes) {
      const container = this.resolveContainer(node);
      const placement = this.computePlacement(node, container);
      const state = this.ensureContainer(container);
      state.members.add(node.id);
      if (container !== undefined) {
        state.union = state.union ? unionBounds(state.union, placement.entry) : placement.entry;
      }
      this.placements.set(node.id, placement);
      let entries = pending.get(container);
      if (!entries) {
        entries = [];
        pending.set(container, entries);
      }
      entries.push([node.id, placement.entry]);
    }
    for (const [container, entries] of pending) this.containers.get(container)!.index.load(entries);
  }

  /**
   * 按节点变更集增量维护：自身几何变化、新增、改挂的节点重新登记，然后沿容器链向上刷新子树包围盒
   * 容器移动只改动它在父容器中的一个条目，后代零开销
   */
  applyChanges(changes: NodeChanges): void {
    const dirty = new Set<string>();
    const relocate = new Set<string>();

    for (const id of changes.removed) {
      const placement = this.placements.get(id);
      if (placement) this.removePlacement(id, placement, dirty);
      // 远端只删了容器而未删子节点：子节点回落根层级
      const own = this.containers.get(id);
      if (own) {
        for (const childId of own.members) relocate.add(childId);
        this.containers.delete(id);
      }
    }
    for (const ids of [changes.added, changes.geometry, changes.reparented, relocate]) {
      for (const id of ids) {
        const node = this.entities.getNode(id)?.entity;
        if (node) this.place(node, dirty);
      }
    }

    // 子树包围盒自底向上传播：容器条目变化时其父容器继续变脏，直到不再变化或到达根层级
    while (dirty.size > 0) {
      const containers = [...dirty];
      dirty.clear();
      for (const key of containers) {
        const node = this.entities.getNode(key)?.entity;
        if (node) this.place(node, dirty);
      }
    }

    // 同一节点可能被写入多次 (自身变化 + 子树传播)，load 按顺序后写覆盖先写
    for (const [key, entries] of this.pendingWrites) this.containers.get(key)?.index.load(entries);
    this.pendingWrites.clear();
  }

  search(queryBounds: RectBounds): readonly string[] {
    const result: string[] = [];
    this.collect(undefined, queryBounds, queryBounds, result);
    return result;
  }

  hitTest(point: Point): readonly string[] {
    return this.search({ left: point.x, top: point.y, right: point.x, bottom: point.y, width: 0, height: 0 });
  }

  getBounds(nodeId: string): RectBounds | undefined {
    const placement = this.placements.get(nodeId);
    if (!placement) return undefined;
    if (placement.container === undefined) return placement.own;
    return computeNodeWorldBounds(this.entities.getNode(nodeId)!.entity, this.entities.getWorldTransform(nodeId)!);
  }

  getContentBounds(): RectBounds | null {
    const root = this.containers.get(undefined);
    if (!root) return null;
    let bounds: RectBounds | null = null;
    for (const id of root.members) {
      const entry = this.placements.get(id)!.entry;
      bounds = bounds ? unionBounds(bounds, entry) : entry;
    }
    return bounds;
  }

  clear(): void {
    this.containers.clear();
    this.placements.clear();
  }

  private collect(key: ContainerKey, localQuery: RectBounds, worldQuery: RectBounds, result: string[]): void {
    const state = this.containers.get(key);
    if (!state) return;
    const ids = state.index.search(localQuery);
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      const placement = this.placements.get(id)!;
      // 根层级局部坐标即世界坐标；嵌套节点先在容器局部坐标中快速排除，再按世界外接矩形精判
      if (key === undefined) {
        if (!placement.hasChildren || doBoundsIntersect(placement.own, worldQuery)) result.push(id);
      } else if (doBoundsIntersect(placement.own, localQuery)) {
        const worldBounds = computeNodeWorldBounds(
          this.entities.getNode(id)!.entity,
          this.entities.getWorldTransform(id)!
        );
        if (doBoundsIntersect(worldBounds, worldQuery)) result.push(id);
      }
      if (placement.hasChildren) {
        const node = this.entities.getNode(id)!.entity;
        this.collect(id, transformBounds(localQuery, invertMatrix(computeNodeLocalMatrix(node))), worldQuery, result);
      }
    }
  }

  /** 父节点缺失 (如远端删除了容器) 时按根层级登记，与世界矩阵的回落规则一致 */
  private resolveContainer(node: Readonly<NodeEntity>): ContainerKey {
    return node.parentId !== undefined && this.entities.hasNode(node.parentId) ? node.parentId : undefined;
  }

  private ensureContainer(key: ContainerKey): ContainerState {
    let state = this.containers.get(key);
    if (!state) {
      state = { index: this.createIndex(), members: new Set(), union: null, stale: false };
      this.containers.set(key, state);
    }
    return state;
  }

  /** 求节点条目：子树包围盒 (自身框 ∪ 直接子条目并集) 变换到父容器局部坐标 */
  private computePlacement(node: Readonly<NodeEntity>, container: ContainerKey): Placement {
    const own = computeOwnBounds(node);
    const state = this.containers.get(node.id);
    if (!state || state.members.size === 0) return { container, entry: own, own, hasChildren: false };

    if (state.stale) {
      let union: RectBounds | null = null;
      for (const memberId of state.members) {
        const entry = this.placements.get(memberId)!.entry;
        union = union ? unionBounds(union, entry) : entry;
      }
      state.union = union;
      state.stale = false;
    }
    const subtree = unionBounds(nodeLocalBox(node), state.union!);
    return { container, entry: transformBounds(subtree, computeNodeLocalMatrix(node)), own, hasChildren: true };
  }

  /** 重新计算并登记节点在所属容器中的条目；条目变化时所属容器变脏 */
  private place(node: Readonly<NodeEntity>, dirty: Set<string>): void {
    const container = this.resolveContainer(node);
    const previous = this.placements.get(node.id);
    const moved = previous !== undefined && previous.container !== container;
    if (moved) this.removePlacement(node.id, previous, dirty);

    const next = this.computePlacement(node, container);
    if (previous && !moved && boundsEqual(previous.entry, next.entry)) {
      previous.own = next.own;
      previous.hasChildren = next.hasChildren;
      return;
    }

    const state = this.ensureContainer(container);
    let writes = this.pendingWrites.get(container);
    if (!writes) {
      writes = [];
      this.pendingWrites.set(container, writes);
    }
    writes.push([node.id, next.entry]);
    if (container !== undefined) {
      if (state.union && previous && !moved && touchesEdge(previous.entry, state.union)) {
        state.stale = true;
      } else if (!state.stale) {
        state.union = state.union ? unionBounds(state.union, next.entry) : next.entry;
      }
      dirty.add(container);
    }
    if (previous && !moved) {
      previous.entry = next.entry;
      previous.own = next.own;
      previous.hasChildren = next.hasChildren;
    } else {
      state.members.add(node.id);
      this.placements.set(node.id, next);
    }
  }

  private removePlacement(id: string, placement: Placement, dirty: Set<string>): void {
    this.placements.delete(id);
    // 同一事务中所属容器先被删除时，容器状态已整体丢弃
    const state = this.containers.get(placement.container);
    if (!state) return;
    state.index.remove(id);
    state.members.delete(id);
    if (placement.container === undefined) return;
    if (state.members.size === 0) {
      state.union = null;
      state.stale = false;
    } else if (state.union && touchesEdge(placement.entry, state.union)) {
      state.stale = true;
    }
    dirty.add(placement.container);
  }
}
