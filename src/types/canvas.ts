/**
 * @file canvas.ts
 * @description 顶层画布树结构 (CanvasDocument)、视口状态与元数据定义
 * 
 * 设计考量 (Why):
 * 1. 单一事实源：CanvasDocument 是状态树的顶层根节点，全量数据可纯净 JSON 序列化。
 * 2. 深度只读投影 (CanvasDocumentView)：对外暴露的实时视图在类型上强锁 readonly，防止外部代码意外 bypass 事务机制直接篡改数据。
 */

import type { NodeEntity } from './node';
import type { ConnectorEntity } from './connector';
import type { CanvasAssetMeta } from './asset';

/** 基础 2D 坐标点（纯逻辑坐标） */
export interface Point {
  x: number;
  y: number;
}

/** 画布实体内容类型：目前分为独立图元节点与连线 */
export type CanvasContentType = 'node' | 'connector';

/** 文档元数据 */
export interface CanvasMeta {
  version: number;
  createdAt: number;
  /**
   * 最后保存时间：由宿主持久化层在保存时以非撤销的系统事务写入，内核不在每次提交时改写。
   * 否则撤销会把时间戳回滚成旧值，协同中每个操作都会争抢同一字段
   */
  updatedAt: number;
  tags?: string[];
  title?: string;
}

/**
 * 视口变换状态（平移与缩放）
 * 属于本地会话状态 (SessionStore)，不进入 CanvasDocument
 */
export interface ViewportState {
  x: number;
  y: number;
  zoom: number;
}

/**
 * 画布实体集合
 * 以 id 为键而非数组下标：补丁路径天然按 id 寻址（如 ["content", "nodes", id, "x"]），
 * 远端插删不会让本地撤销栈中的补丁错位命中其他实体；层叠顺序统一由实体的 zIndex 决定。
 */
export interface CanvasContent {
  nodes: Record<string, NodeEntity>;
  connectors: Record<string, ConnectorEntity>;
}

/** 插件扩展专有资源（如全局配置、草稿索引） */
export interface FeatureResource<TData = unknown> {
  id: string;
  type: string;
  schemaVersion: number;
  ownerPluginId: string;
  data: TData;
}

/**
 * SkyNote 画布完整文档树 (CanvasDocument)
 * 状态树单一事实源，可直接无损 JSON 序列化
 */
export interface CanvasDocument {
  id: string;
  name: string;
  meta: CanvasMeta;
  content: CanvasContent;
  /** 媒体资产表 (以 assetId 建立轻量索引，零 Base64) */
  assets?: Record<string, CanvasAssetMeta>;
  /** 插件私有资源扩展槽 */
  resources?: Record<string, FeatureResource>;
}

/** 深度只读工具类型：保障对外暴露的视图不可被意外篡改 */
export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer TItem)[]
    ? readonly DeepReadonly<TItem>[]
    : T extends object
      ? { readonly [TKey in keyof T]: DeepReadonly<T[TKey]> }
      : T;

/** 文档零拷贝只读投影视图 */
export type CanvasDocumentView = DeepReadonly<CanvasDocument>;
export type NodeEntityView = CanvasDocumentView['content']['nodes'][string];
export type ConnectorEntityView = CanvasDocumentView['content']['connectors'][string];
