/**
 * @file runtime.ts
 * @description 纯内存运行时元数据与实例信封模型 (Runtime State & Envelopes)
 * 
 * 设计考量 (Why):
 * 1. 持久化与运行时物理分离：NodeEntity 与 ConnectorEntity 只包含 100% 存入 JSON 的业务数据；
 *    所有高频脏检查版本号 (geomVersion / dataVersion)、实时包围盒、避障算法折线点集 (ComputedRoute)，
 *    全部收敛于纯内存运行时包装中，彻底杜绝数据冗余与协同网络雪崩。
 * 2. 垃圾回收友好：运行时元数据生命周期随内存实例结束而销毁，0 持久化负担，0 撤销栈毒化。
 */

import type { Point } from './canvas';
import type { NodeEntity } from './node';
import type { ConnectorEntity } from './connector';
import type { RectBounds } from '../utils/geometry';

/** 节点纯内存运行时元数据 */
export interface NodeRuntimeState {
  /** 几何版本号：仅在 x, y, width, height, rotation 变动时自增，驱动快速 Transform 矩阵位移 */
  geomVersion: number;
  /** 数据版本号：在 style, textBlocks, data 变动时自增，驱动图元重绘 */
  dataVersion: number;
  /** 当前节点在世界坐标系中的实时外包围盒 (供空间四叉树检索与视锥剔除) */
  worldBounds?: RectBounds;
  /** 交互态标记 (选填) */
  isHovered?: boolean;
}

/**
 * 运行时节点实例信封 (RuntimeNode)
 * 内核内存仓储 (EntityStore) 中的完整实体承载对象
 */
export interface RuntimeNode<
  TData = Record<string, unknown>,
  TStyle extends Record<string, unknown> = Record<string, unknown>
> {
  /** 纯净的持久化实体模型 (单一事实源) */
  readonly entity: NodeEntity<TData, TStyle>;
  /** 运行时专属可变状态 */
  readonly runtime: NodeRuntimeState;
}

/** 算法动态解算出的连线路径几何描述 (纯内存计算缓存) */
export interface ComputedRoute {
  readonly connectorId: string;
  /** 算法结合两端节点与 controlPoints 最终解算出的完整折线/曲线点序列 */
  readonly points: Point[];
  /** 预生成的 SVG Path "M ... L ..." 路径字符串 (供渲染器 O(1) 直接绘制) */
  readonly pathString: string;
  /** 折线几何总长度 (供连线文本标注按 position: 0.5 百分比居中定位) */
  readonly totalLength: number;
  /** 实时最小外包矩形 (供视锥剔除与空间拾取) */
  readonly bounds: RectBounds;
  /** 计算此路径时的两端节点几何版本快照 (用于版本脏检查缓存失效) */
  readonly versionHash: string;
}

/** 连线纯内存运行时元数据 */
export interface ConnectorRuntimeState {
  /** 几何与路径版本号 */
  geomVersion: number;
  /** 属性版本号 */
  dataVersion: number;
  /**
   * 路由算法实时求解的路径折点与几何缓存
   * 随两端节点移动动态生成，绝不写入持久化文档
   */
  computedRoute?: ComputedRoute;
  /** 交互态标记 */
  isHovered?: boolean;
}

/**
 * 运行时连线实例信封 (RuntimeConnector)
 * 内核内存仓储 (EntityStore) 中的完整连线承载对象
 */
export interface RuntimeConnector<
  TData = Record<string, unknown>,
  TStyle extends Record<string, unknown> = Record<string, unknown>
> {
  /** 纯净的持久化连线模型 (单一事实源) */
  readonly entity: ConnectorEntity<TData, TStyle>;
  /** 运行时专属可变状态 */
  readonly runtime: ConnectorRuntimeState;
}
