/**
 * @file runtime.ts
 * @description 纯内存运行时元数据与实例信封模型 (Runtime State & Envelopes)
 *
 * 设计考量 (Why):
 * 1. 持久化与运行时物理分离：NodeEntity 与 ConnectorEntity 只包含 100% 存入 JSON 的业务数据；
 *    高频脏检查版本号 (geomVersion / dataVersion) 收敛于纯内存运行时包装中，彻底杜绝数据冗余与协同网络雪崩；
 *    连线路由 (ComputedRoute) 由引擎按版本增量求解并缓存 (engine.getConnectorRoute)。
 * 2. 垃圾回收友好：运行时元数据生命周期随内存实例结束而销毁，0 持久化负担，0 撤销栈毒化。
 */

import type { Point } from './canvas';
import type { NodeEntity, NodeStyle } from './node';
import type { ConnectorEntity, ConnectorStyle } from './connector';
import type { RectBounds } from '../utils/geometry';

/** 节点纯内存运行时元数据 */
export interface NodeRuntimeState {
  /** 几何版本号：仅在 x, y, width, height, rotation 变动时自增，驱动快速 Transform 矩阵位移 */
  geomVersion: number;
  /** 数据版本号：在 style, textBlocks, data 变动时自增，驱动图元重绘 */
  dataVersion: number;
}

/**
 * 运行时节点实例信封 (RuntimeNode)
 * 内核内存仓储 (EntityStore) 中的完整实体承载对象
 */
export interface RuntimeNode<TData = Record<string, unknown>, TStyle extends NodeStyle = NodeStyle> {
  /** 纯净的持久化实体模型 (单一事实源) */
  readonly entity: NodeEntity<TData, TStyle>;
  /** 运行时专属可变状态 */
  readonly runtime: NodeRuntimeState;
}

/**
 * 引擎求解的连线路由 (纯内存派生缓存，绝不写入持久化文档)
 * 连线自身或两端节点几何变化时整体替换，下游按对象引用判定是否需要重绘
 */
export interface ComputedRoute {
  /** 路由器求解出的有序折线关键点 (世界坐标，至少两个点) */
  readonly points: readonly Point[];
  /** 路由器预生成的路径指令 (如贝塞尔平滑)，缺失时由渲染端按 points 绘制 */
  readonly pathData?: string;
  /** 折线总长度 (供连线文本标注按比例定位) */
  readonly totalLength: number;
  /** 路由点集的最小外包矩形 (供视锥剔除与空间拾取) */
  readonly bounds: RectBounds;
}

/** 连线纯内存运行时元数据 */
export interface ConnectorRuntimeState {
  /** 几何与路径版本号 */
  geomVersion: number;
  /** 属性版本号 */
  dataVersion: number;
}

/**
 * 运行时连线实例信封 (RuntimeConnector)
 * 内核内存仓储 (EntityStore) 中的完整连线承载对象
 */
export interface RuntimeConnector<TData = Record<string, unknown>, TStyle extends ConnectorStyle = ConnectorStyle> {
  /** 纯净的持久化连线模型 (单一事实源) */
  readonly entity: ConnectorEntity<TData, TStyle>;
  /** 运行时专属可变状态 */
  readonly runtime: ConnectorRuntimeState;
}

/**
 * 运行时节点只读视图
 * 浅层 Readonly 足以在类型层面拦截 `node.x = 1` 这类绕过事务的就地赋值，
 * 同时仍可直接传给接收 NodeEntity 的渲染与排版函数
 */
export interface RuntimeNodeView {
  readonly entity: Readonly<NodeEntity>;
  readonly runtime: Readonly<NodeRuntimeState>;
}

/** 运行时连线只读视图 */
export interface RuntimeConnectorView {
  readonly entity: Readonly<ConnectorEntity>;
  readonly runtime: Readonly<ConnectorRuntimeState>;
}
