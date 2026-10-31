/**
 * @file entity-store.ts
 * @description 纯内存实体索引仓储与运行时信封管理器
 *
 * 设计考量 (Why):
 * 1. 双版本号：移动只递增 geomVersion，样式与文本递增 dataVersion，渲染器据此跳过不必要的图元重建。
 * 2. 邻接与父子索引：节点移动或删除时按度数定位依附连线，级联操作按子树规模定位后代，都不扫描全部实体。
 * 3. 世界矩阵缓存 (ADR-114)：几何写入推进校验代次，读取迭代复合并复用本代已验证的共享祖先；
 *    「自身 geomVersion + 父矩阵引用 + parentId」未变时保持矩阵引用，不在写入时遍历后代。
 * 4. 读写分离：写入方法只供 DocumentStore 在事务提交后调用；其他模块只拿到 EntityReader，
 *    类型上既不能让索引与文档失配，也不能就地改写实体绕过事务。
 */

import type { Matrix2D } from '../types/geometry';
import type { NodeEntity } from '../types/node';
import type { ConnectorEntity } from '../types/connector';
import type { RuntimeNode, RuntimeConnector, RuntimeNodeView, RuntimeConnectorView } from '../types/runtime';
import { computeNodeLocalMatrix, multiplyMatrix } from '../utils/geometry';

/** 实体运行时索引的只读视图 (对内核之外暴露的唯一形态) */
export interface EntityReader {
  readonly geometryRevision: number;
  getLayoutRootIds(): ReadonlySet<string>;
  readonly nodeCount: number;
  readonly connectorCount: number;
  /** O(N) 分配，仅用于低频全量场景 */
  getAllNodes(): readonly RuntimeNodeView[];
  /** O(N) 分配，仅用于低频全量场景 */
  getAllConnectors(): readonly RuntimeConnectorView[];
  getNode(id: string): RuntimeNodeView | undefined;
  getConnector(id: string): RuntimeConnectorView | undefined;
  hasNode(id: string): boolean;
  hasConnector(id: string): boolean;
  /** 端点绑定在指定节点上的全部连线 id */
  getConnectorIdsOfNode(nodeId: string): ReadonlySet<string>;
  /** 直接子节点 id；parentId 为 undefined 时返回根层级 (不在任何容器内) 的节点 */
  getChildIds(parentId: string | undefined): ReadonlySet<string>;
  /** 全部后代节点 id (广度优先，自带防环) */
  collectDescendantIds(nodeId: string): string[];
  /** 祖先节点 id，由近及远；父节点缺失 (如远端删除容器) 时到此为止 */
  getAncestorIds(nodeId: string): string[];
  /** 节点世界矩阵 (节点局部坐标 → 世界坐标)；父节点缺失 (如远端删除容器) 时按根层级处理 */
  getWorldTransform(nodeId: string): Matrix2D | undefined;
}

interface WorldTransformCache {
  validatedAt: number;
  readonly matrix: Matrix2D;
  readonly geomVersion: number;
  readonly parentId: string | undefined;
  /** 计算时所用的父级世界矩阵 (引用)；父级重算后引用变化，本缓存随之失效 */
  readonly parentMatrix: Matrix2D | null;
}

/** 单个实体与持久化文档对齐后的结果 */
export type EntitySyncResult = 'added' | 'replaced' | 'removed' | 'unchanged';

const EMPTY_ID_SET: ReadonlySet<string> = new Set();

export class EntityStore implements EntityReader {
  private readonly layoutRootIds = new Set<string>();
  get geometryRevision(): number {
    return this.transformRevision;
  }
  getLayoutRootIds(): ReadonlySet<string> {
    return this.layoutRootIds;
  }
  private readonly nodes = new Map<string, RuntimeNode>();
  private readonly connectors = new Map<string, RuntimeConnector>();
  /** nodeId -> 依附其上的连线 id 集合 */
  private readonly nodeConnectors = new Map<string, Set<string>>();
  /** parentId -> 直接子节点 id 集合 */
  private readonly nodeChildren = new Map<string, Set<string>>();
  /** 根层级节点 (层级操作按「同一容器的兄弟」分组，根层级同样是一组兄弟) */
  private readonly rootNodeIds = new Set<string>();
  /** nodeId -> 已登记进父子索引的 parentId (undefined 表示根层级；就地修改 parentId 后据此解除旧关联) */
  private readonly nodeParents = new Map<string, string | undefined>();
  /** connectorId -> 已登记进邻接索引的两端节点 id (就地修改端点后据此解除旧关联) */
  private readonly connectorEndpoints = new Map<string, readonly (string | undefined)[]>();
  private readonly worldTransforms = new Map<string, WorldTransformCache>();
  /** 几何写入仅推进代次；一次读取批次内，共享祖先只校验一次，不在写入时遍历后代。 */
  private transformRevision = 0;
  /**
   * 全局单调版本时钟：所有版本号均从此取值，
   * 实体被删除后以同 id 恢复（撤销删除）时不会复用旧版本号，下游按 `!==` 比较的缓存必然失效
   */
  private versionClock = 0;

  get nodeCount(): number {
    return this.nodes.size;
  }

  get connectorCount(): number {
    return this.connectors.size;
  }

  /** 获取所有节点信封列表 (O(N) 分配，仅用于低频全量场景) */
  getAllNodes(): readonly RuntimeNode[] {
    return Array.from(this.nodes.values());
  }

  /** 获取所有连线信封列表 (O(N) 分配，仅用于低频全量场景) */
  getAllConnectors(): readonly RuntimeConnector[] {
    return Array.from(this.connectors.values());
  }

  /** O(1) 检索单个节点 */
  getNode(id: string): RuntimeNode | undefined {
    return this.nodes.get(id);
  }

  /** O(1) 检索单个连线 */
  getConnector(id: string): RuntimeConnector | undefined {
    return this.connectors.get(id);
  }

  /** 判断节点是否存在 */
  hasNode(id: string): boolean {
    return this.nodes.has(id);
  }

  /** 判断连线是否存在 */
  hasConnector(id: string): boolean {
    return this.connectors.has(id);
  }

  /** 端点绑定在指定节点上的全部连线 id */
  getConnectorIdsOfNode(nodeId: string): ReadonlySet<string> {
    return this.nodeConnectors.get(nodeId) ?? EMPTY_ID_SET;
  }

  getChildIds(parentId: string | undefined): ReadonlySet<string> {
    if (parentId === undefined) return this.rootNodeIds;
    return this.nodeChildren.get(parentId) ?? EMPTY_ID_SET;
  }

  collectDescendantIds(nodeId: string): string[] {
    const result: string[] = [];
    const visited = new Set<string>([nodeId]);
    const queue = [nodeId];
    for (let i = 0; i < queue.length; i++) {
      for (const childId of this.getChildIds(queue[i])) {
        if (visited.has(childId)) continue;
        visited.add(childId);
        result.push(childId);
        queue.push(childId);
      }
    }
    return result;
  }

  getAncestorIds(nodeId: string): string[] {
    const ancestors: string[] = [];
    // 提交守卫保证容器无环
    for (let parentId = this.nodes.get(nodeId)?.entity.parentId; parentId !== undefined;) {
      const parent = this.nodes.get(parentId);
      if (!parent) break;
      ancestors.push(parentId);
      parentId = parent.entity.parentId;
    }
    return ancestors;
  }

  getWorldTransform(nodeId: string): Matrix2D | undefined {
    const runtimeNode = this.nodes.get(nodeId);
    if (!runtimeNode) return undefined;
    const hit = this.worldTransforms.get(nodeId);
    if (hit?.validatedAt === this.transformRevision) return hit.matrix;
    const path: RuntimeNode[] = [];
    let current: RuntimeNode | undefined = runtimeNode;
    let parentMatrix: Matrix2D | null = null;
    // 提交守卫保证无环；命中本代已验证的祖先即可停止，深链也不占用调用栈。
    while (current) {
      const cached = this.worldTransforms.get(current.entity.id);
      if (cached?.validatedAt === this.transformRevision) {
        parentMatrix = cached.matrix;
        break;
      }
      path.push(current);
      const parentId: string | undefined = current.entity.parentId;
      current = parentId === undefined ? undefined : this.nodes.get(parentId);
    }
    for (let i = path.length - 1; i >= 0; i--) {
      const { entity: node, runtime } = path[i];
      const cached = this.worldTransforms.get(node.id);
      if (
        cached &&
        cached.geomVersion === runtime.geomVersion &&
        cached.parentMatrix === parentMatrix &&
        cached.parentId === node.parentId
      ) {
        cached.validatedAt = this.transformRevision;
        parentMatrix = cached.matrix;
        continue;
      }
      const local = computeNodeLocalMatrix(node);
      const matrix: Matrix2D = parentMatrix ? multiplyMatrix(parentMatrix, local) : local;
      this.worldTransforms.set(node.id, {
        validatedAt: this.transformRevision,
        matrix,
        geomVersion: runtime.geomVersion,
        parentId: node.parentId,
        parentMatrix
      });
      parentMatrix = matrix;
    }
    return parentMatrix!;
  }

  /**
   * 父子索引中登记的父节点：实体被字段级补丁就地修改后、索引刷新前，这里仍是事务前的父节点
   * (事务内派生据此找到被删除或改挂的节点原来所在的布局树)
   */
  getIndexedParentId(id: string): string | undefined {
    return this.nodeParents.get(id);
  }

  /** parentId 被字段级补丁就地修改后，刷新父子索引 */
  reindexNodeParent(id: string): void {
    if (this.nodeParents.get(id) !== this.nodes.get(id)?.entity.parentId) this.transformRevision++;
    this.indexNodeParent(id, this.nodes.get(id)?.entity);
  }

  /**
   * 将节点运行时信封与文档中的实体对齐
   * 字段级补丁就地修改实体，引用不变即 unchanged；引用变化说明实体被整体替换，几何与数据一并失效
   */
  syncNode(id: string, entity: NodeEntity | undefined): EntitySyncResult {
    const existing = this.nodes.get(id);

    if (!entity) {
      if (!existing) return 'unchanged';
      this.transformRevision++;
      this.nodes.delete(id);
      this.worldTransforms.delete(id);
      this.indexNodeParent(id, undefined);
      return 'removed';
    }

    if (!existing) {
      this.transformRevision++;
      this.nodes.set(id, {
        entity,
        runtime: { geomVersion: ++this.versionClock, dataVersion: ++this.versionClock }
      });
      this.indexNodeParent(id, entity);
      return 'added';
    }

    if (existing.entity === entity) return 'unchanged';
    this.transformRevision++;
    this.indexNodeParent(id, entity);
    (existing as { entity: NodeEntity }).entity = entity;
    existing.runtime.geomVersion = ++this.versionClock;
    existing.runtime.dataVersion = ++this.versionClock;
    return 'replaced';
  }

  /**
   * 将连线运行时信封与文档中的实体对齐，并同步维护邻接索引
   */
  syncConnector(id: string, entity: ConnectorEntity | undefined): EntitySyncResult {
    const existing = this.connectors.get(id);

    if (!entity) {
      if (!existing) return 'unchanged';
      this.connectors.delete(id);
      this.indexConnectorEndpoints(id, undefined);
      return 'removed';
    }

    if (!existing) {
      this.connectors.set(id, {
        entity,
        runtime: { geomVersion: ++this.versionClock, dataVersion: ++this.versionClock }
      });
      this.indexConnectorEndpoints(id, entity);
      return 'added';
    }

    if (existing.entity === entity) return 'unchanged';
    (existing as { entity: ConnectorEntity }).entity = entity;
    existing.runtime.geomVersion = ++this.versionClock;
    existing.runtime.dataVersion = ++this.versionClock;
    this.indexConnectorEndpoints(id, entity);
    return 'replaced';
  }

  /**
   * 字段级补丁就地修改实体后递增版本号 (geom：位置、尺寸、旋转；data：样式、文本、业务数据)
   * @returns 节点是否存在 (已被删除的实体不再计入变更)
   */
  bumpNodeVersion(id: string, kind: 'geom' | 'data'): boolean {
    const node = this.nodes.get(id);
    if (!node) return false;
    if (node.entity.layout) this.layoutRootIds.add(id);
    else this.layoutRootIds.delete(id);
    if (kind === 'geom') {
      node.runtime.geomVersion = ++this.versionClock;
      this.transformRevision++;
    } else node.runtime.dataVersion = ++this.versionClock;
    return true;
  }

  /**
   * 连线版本号递增 (geom 含两端节点移动导致的路由失效)；端点可能被就地改绑到其他节点，几何变更时顺带刷新邻接索引
   * @returns 连线是否存在
   */
  bumpConnectorVersion(id: string, kind: 'geom' | 'data'): boolean {
    const connector = this.connectors.get(id);
    if (!connector) return false;
    if (kind === 'geom') {
      connector.runtime.geomVersion = ++this.versionClock;
      this.indexConnectorEndpoints(id, connector.entity);
    } else {
      connector.runtime.dataVersion = ++this.versionClock;
    }
    return true;
  }

  /**
   * 清空全部实体与运行时缓存
   */
  clear(): void {
    this.layoutRootIds.clear();
    this.transformRevision++;
    this.nodes.clear();
    this.connectors.clear();
    this.nodeConnectors.clear();
    this.connectorEndpoints.clear();
    this.nodeChildren.clear();
    this.rootNodeIds.clear();
    this.nodeParents.clear();
    this.worldTransforms.clear();
  }

  private indexNodeParent(id: string, entity: NodeEntity | undefined): void {
    if (entity?.layout) this.layoutRootIds.add(id);
    else this.layoutRootIds.delete(id);
    const registered = this.nodeParents.has(id);
    const previous = this.nodeParents.get(id);
    const next = entity?.parentId;
    if (entity && registered && previous === next) return;

    if (registered) {
      if (previous === undefined) {
        this.rootNodeIds.delete(id);
      } else {
        const siblings = this.nodeChildren.get(previous);
        siblings?.delete(id);
        if (siblings?.size === 0) this.nodeChildren.delete(previous);
      }
      this.nodeParents.delete(id);
    }
    if (!entity) return;

    this.nodeParents.set(id, next);
    if (next === undefined) {
      this.rootNodeIds.add(id);
      return;
    }
    let children = this.nodeChildren.get(next);
    if (!children) {
      children = new Set();
      this.nodeChildren.set(next, children);
    }
    children.add(id);
  }

  private indexConnectorEndpoints(connectorId: string, entity: ConnectorEntity | undefined): void {
    const previous = this.connectorEndpoints.get(connectorId);
    const fromId = entity?.from.nodeId;
    const toId = entity?.to.nodeId;
    if (previous && previous[0] === fromId && previous[1] === toId) return;

    if (previous) {
      for (let i = 0; i < previous.length; i++) {
        const nodeId = previous[i];
        if (nodeId === undefined) continue;
        const set = this.nodeConnectors.get(nodeId);
        if (!set) continue;
        set.delete(connectorId);
        if (set.size === 0) this.nodeConnectors.delete(nodeId);
      }
    }

    if (!entity) {
      this.connectorEndpoints.delete(connectorId);
      return;
    }

    this.connectorEndpoints.set(connectorId, [fromId, toId]);
    for (const nodeId of [fromId, toId]) {
      if (nodeId === undefined) continue;
      let set = this.nodeConnectors.get(nodeId);
      if (!set) {
        set = new Set();
        this.nodeConnectors.set(nodeId, set);
      }
      set.add(connectorId);
    }
  }
}
