/**
 * @file entity-store.ts
 * @description 纯内存实体索引仓储与运行时信封管理器
 *
 * 设计考量 (Why):
 * 1. O(1) 瞬时索引：避免在大规模节点画布中通过遍历查找实体，维护纯内存 Map 映射。
 * 2. 双版本号守卫 (AGENTS.md 性能军规)：拖拽移动只改变 geomVersion，样式/文本变动自增 dataVersion，
 *    渲染器借此实现微秒级 Diff，跳过昂贵的图元重新计算。
 * 3. 内存与持久化彻底解耦：仅持久化 NodeEntity/ConnectorEntity，运行时元数据 (computedRoute、包围盒)
 *    收敛于此纯内存信封，GC 友好。
 * 4. 节点-连线邻接索引：节点移动/删除时 O(度数) 定位依附连线，避免每帧全量扫描连线。
 * 6. 容器父子索引：级联移动与级联删除按子树规模定位后代，不扫描全部节点。
 * 5. 读写分离：写入方法只供 DocumentStore 在事务提交后调用；引擎、渲染器与插件只拿到 EntityReader，
 *    类型层面既无法调用 sync/notify 让索引与文档失配，也无法就地改写实体字段绕过事务。
 */

import type { NodeEntity } from '../types/node';
import type { ConnectorEntity } from '../types/connector';
import type { RuntimeNode, RuntimeConnector, RuntimeNodeView, RuntimeConnectorView } from '../types/runtime';

/** 实体运行时索引的只读视图 (对内核之外暴露的唯一形态) */
export interface EntityReader {
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
}

/** 单个实体与持久化文档对齐后的结果 */
export type EntitySyncResult = 'added' | 'replaced' | 'removed' | 'unchanged';

const EMPTY_ID_SET: ReadonlySet<string> = new Set();

export class EntityStore implements EntityReader {
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

  /** parentId 被字段级补丁就地修改后，刷新父子索引 */
  reindexNodeParent(id: string): void {
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
      this.nodes.delete(id);
      this.indexNodeParent(id, undefined);
      return 'removed';
    }

    if (!existing) {
      this.nodes.set(id, {
        entity,
        runtime: { geomVersion: ++this.versionClock, dataVersion: ++this.versionClock }
      });
      this.indexNodeParent(id, entity);
      return 'added';
    }

    if (existing.entity === entity) return 'unchanged';
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
   * 几何变更通知：递增几何版本号 (geomVersion)
   * 触发时机：移动、缩放尺寸、旋转
   */
  notifyNodeGeometryChanged(id: string): void {
    const node = this.nodes.get(id);
    if (node) {
      node.runtime.geomVersion = ++this.versionClock;
    }
  }

  /**
   * 数据内容变更通知：递增数据版本号 (dataVersion)
   * 触发时机：修改填充色、边框、阴影、富文本内容、业务附加数据
   */
  notifyNodeDataChanged(id: string): void {
    const node = this.nodes.get(id);
    if (node) {
      node.runtime.dataVersion = ++this.versionClock;
    }
  }

  /**
   * 连线几何与路由变更通知 (含两端节点移动导致的路由失效)
   * 端点可能被就地改绑到其他节点，顺带刷新邻接索引
   */
  notifyConnectorGeometryChanged(id: string): void {
    const connector = this.connectors.get(id);
    if (connector) {
      connector.runtime.geomVersion = ++this.versionClock;
      this.indexConnectorEndpoints(id, connector.entity);
    }
  }

  /**
   * 连线样式与数据变更通知
   */
  notifyConnectorDataChanged(id: string): void {
    const connector = this.connectors.get(id);
    if (connector) {
      connector.runtime.dataVersion = ++this.versionClock;
    }
  }

  /**
   * 清空全部实体与运行时缓存
   */
  clear(): void {
    this.nodes.clear();
    this.connectors.clear();
    this.nodeConnectors.clear();
    this.connectorEndpoints.clear();
    this.nodeChildren.clear();
    this.rootNodeIds.clear();
    this.nodeParents.clear();
  }

  private indexNodeParent(id: string, entity: NodeEntity | undefined): void {
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
