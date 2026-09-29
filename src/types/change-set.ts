/**
 * @file change-set.ts
 * @description 单次事务提交的结构化增量变更集 (DocumentChangeSet)
 *
 * 设计考量 (Why):
 * 1. 一次解析，全员消费：补丁路径只在 DocumentStore 中按实体语义归类一次，空间索引、渲染器与业务插件
 *    直接消费结果，既无需各自重复解析，也不必感知 content.nodes.<id>.<field> 这类持久化存储布局。
 * 2. 增量驱动：下游只处理本次涉及的实体 id，彻底摆脱每次提交 O(N) 全量扫描。
 */

/** 单类实体在一次提交中的增量变更 */
export interface EntityChanges {
  readonly added: ReadonlySet<string>;
  readonly removed: ReadonlySet<string>;
  /**
   * 几何失效的实体 (含新增与整体替换)
   * 连线还包含因两端节点移动或删除而导致路由失效的依附连线
   */
  readonly geometry: ReadonlySet<string>;
  /** 数据失效的实体 (含新增与整体替换) */
  readonly data: ReadonlySet<string>;
}

/** 单次提交的完整增量变更集 */
export interface DocumentChangeSet {
  readonly nodes: EntityChanges;
  readonly connectors: EntityChanges;
  /** 内容层层叠关系可能变化：实体增删替换，或 zIndex / parentId / 连线端点变化 */
  readonly orderChanged: boolean;
}
