/**
 * @file connector-source.protocol.ts
 * @description 派生连线来源 (ADR-130)：不存在于文档、由文档数据推导出的连线 (如导图分支线、ER 图外键关系、双向链接)
 *
 * 设计考量 (Why):
 * 1. 内核只提供机制：派生连线与文档连线一起进入实体索引，下游 (路由、空间索引、渲染、拾取、选区、工具栏)
 *    不区分派生与否；推导与写入的语义全部归来源插件，内核不知道任何具体场景。
 * 2. 单一事实源：派生连线的数据就是文档里的某些字段，对它的修改由来源转写为文档补丁，照常撤销与协同。
 * 3. 增量：来源先按本次变化给出需要重算的键，内核只对这些键推导；拖动等高频提交应返回空，零额外开销。
 */

import type { ConnectorEntity } from '../types/connector';
import type { CanvasPatch } from '../types/operation';

/** 派生连线 id 的前缀：文档中的连线不能以此开头 (见提交守卫)，两者不会撞 id */
export const DERIVED_CONNECTOR_PREFIX = '@';

/** 派生连线不在文档中；它的几何 (端点、走向) 由来源决定，界面不提供端点与拐点的拖拽 */
export function isDerivedConnectorId(id: string): boolean {
  return id.startsWith(DERIVED_CONNECTOR_PREFIX);
}

export function derivedConnectorId(sourceId: string, key: string): string {
  return `${DERIVED_CONNECTOR_PREFIX}${sourceId}:${key}`;
}

/** 来源推导出的连线 (id 与 type 由内核填写：id 为 `@<来源 id>:<键>`) */
export type DerivedConnector = Omit<ConnectorEntity, 'id' | 'type'>;

/** 一次提交中节点的变化：被改动的字段；整体新增、删除或替换时为 'entity' */
export type DerivedNodeChange = ReadonlySet<string> | 'entity';

/** 交给来源判断重算范围的变化摘要 (整体替换文档内容时不调用 collect，直接全量重算) */
export interface DerivedSourceChanges {
  readonly nodes: ReadonlyMap<string, DerivedNodeChange>;
}

/** 派生连线来源契约 */
export interface DerivedConnectorSource {
  /** 全局唯一标识 (不含冒号)：派生连线的 id 为 `@<id>:<键>`，文档中的连线不能以 @ 开头 */
  readonly id: string;
  /**
   * 一次提交后需要重算的键 (键通常是节点 id)；null 表示全部重算
   * 只依据本次变化判断：与本来源无关的提交 (如拖动普通节点) 应返回空。
   * 依赖关系由来源负责：被依赖的节点重新出现 (如撤销删除) 时，要把依赖它的键也算进来；
   * 端点节点被删除的情况由内核兜底重算，不会悬空
   */
  collect(changes: DerivedSourceChanges): Iterable<string> | null;
  /**
   * 按键批量推导：每个键当前应有的连线，undefined 表示没有
   * keys 为 null 时给出本来源的全部连线 (未出现的键视为没有)
   */
  derive(keys: Iterable<string> | null): ReadonlyMap<string, DerivedConnector | undefined>;
  /**
   * 对派生连线的修改 (与普通连线同样的字段与合并语义) 转写为文档补丁；缺省为只读
   * @param current 当前的派生连线
   */
  write?(
    key: string,
    current: Readonly<ConnectorEntity>,
    partial: Partial<ConnectorEntity>,
    merge: boolean
  ): CanvasPatch[];
}
