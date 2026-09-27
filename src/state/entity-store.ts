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
 */

import type { NodeEntity } from '../types/node';
import type { ConnectorEntity } from '../types/connector';
import type {
  RuntimeNode,
  RuntimeConnector,
  NodeRuntimeState,
  ConnectorRuntimeState,
  ComputedRoute
} from '../types/runtime';

export class EntityStore {
  private readonly nodes = new Map<string, RuntimeNode>();
  private readonly connectors = new Map<string, RuntimeConnector>();

  /** 获取所有节点信封列表 */
  getAllNodes(): readonly RuntimeNode[] {
    return Array.from(this.nodes.values());
  }

  /** 获取所有连线信封列表 */
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

  /**
   * 注册单个节点实体并初始化运行时信封
   */
  registerNode(entity: NodeEntity): RuntimeNode {
    const existing = this.nodes.get(entity.id);
    if (existing) {
      // 实体已存在，就地更新引用，并根据内容决定是否自增版本号
      (existing as { entity: NodeEntity }).entity = entity;
      return existing;
    }

    const runtime: NodeRuntimeState = {
      geomVersion: 1,
      dataVersion: 1
    };

    const envelope: RuntimeNode = {
      entity,
      runtime
    };

    this.nodes.set(entity.id, envelope);
    return envelope;
  }

  /**
   * 注销节点
   */
  unregisterNode(id: string): boolean {
    return this.nodes.delete(id);
  }

  /**
   * 注册单个连线实体并初始化运行时信封
   */
  registerConnector(entity: ConnectorEntity): RuntimeConnector {
    const existing = this.connectors.get(entity.id);
    if (existing) {
      (existing as { entity: ConnectorEntity }).entity = entity;
      return existing;
    }

    const runtime: ConnectorRuntimeState = {
      geomVersion: 1,
      dataVersion: 1
    };

    const envelope: RuntimeConnector = {
      entity,
      runtime
    };

    this.connectors.set(entity.id, envelope);
    return envelope;
  }

  /**
   * 注销连线
   */
  unregisterConnector(id: string): boolean {
    return this.connectors.delete(id);
  }

  /**
   * 几何变更通知：递增几何版本号 (geomVersion)
   * 触发时机：移动、缩放尺寸、旋转
   */
  notifyNodeGeometryChanged(id: string): void {
    const node = this.nodes.get(id);
    if (node) {
      node.runtime.geomVersion++;
      node.runtime.worldBounds = undefined;
    }
  }

  /**
   * 数据内容变更通知：递增数据版本号 (dataVersion)
   * 触发时机：修改填充色、边框、阴影、富文本内容、业务附加数据
   */
  notifyNodeDataChanged(id: string): void {
    const node = this.nodes.get(id);
    if (node) {
      node.runtime.dataVersion++;
    }
  }

  /**
   * 连线几何与路由变更通知
   */
  notifyConnectorGeometryChanged(id: string): void {
    const connector = this.connectors.get(id);
    if (connector) {
      connector.runtime.geomVersion++;
      // 几何改变时，旧计算的路由点集失效，等待渲染帧重算
      connector.runtime.computedRoute = undefined;
    }
  }

  /**
   * 连线样式与数据变更通知
   */
  notifyConnectorDataChanged(id: string): void {
    const connector = this.connectors.get(id);
    if (connector) {
      connector.runtime.dataVersion++;
    }
  }

  /**
   * 缓存连线的解算路由
   */
  setConnectorRoute(id: string, route: ComputedRoute): void {
    const connector = this.connectors.get(id);
    if (connector) {
      connector.runtime.computedRoute = route;
    }
  }

  /**
   * 批量全量同步持久化列表，刷新内部 Map 索引
   */
  syncFromEntities(nodes: readonly NodeEntity[], connectors: readonly ConnectorEntity[]): void {
    const activeNodeIds = new Set<string>();
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      activeNodeIds.add(node.id);
      this.registerNode(node);
    }
    // 清理已删除节点
    for (const id of this.nodes.keys()) {
      if (!activeNodeIds.has(id)) {
        this.nodes.delete(id);
      }
    }

    const activeConnectorIds = new Set<string>();
    for (let i = 0; i < connectors.length; i++) {
      const conn = connectors[i];
      activeConnectorIds.add(conn.id);
      this.registerConnector(conn);
    }
    // 清理已删除连线
    for (const id of this.connectors.keys()) {
      if (!activeConnectorIds.has(id)) {
        this.connectors.delete(id);
      }
    }
  }

  /**
   * 清空全部实体与运行时缓存
   */
  clear(): void {
    this.nodes.clear();
    this.connectors.clear();
  }
}
