/**
 * @file runtime.ts
 * @description 纯内存运行时信封：实体 + 双版本号，以及引擎求解的连线路由
 *
 * 设计考量 (Why):
 * 持久化实体只含存入 JSON 的业务数据；脏检查版本号与路由缓存只活在内存中，
 * 不进文档、不进撤销栈、不参与协同，随实例销毁回收。
 */

import type { Point, RectBounds } from './geometry';
import type { NodeEntity } from './node';
import type { ConnectorEntity } from './connector';

/** 实体双版本号：取值来自全局单调时钟，删除后以同 id 恢复也不会复用旧值 */
export interface EntityVersions {
  /** 几何版本：位置、尺寸、旋转 (连线含路由) 变化时递增，渲染器据此只更新变换 */
  geomVersion: number;
  /** 数据版本：样式、文本、业务数据变化时递增，渲染器据此重建图元 */
  dataVersion: number;
}

/** 节点运行时信封 (EntityStore 内部可写) */
export interface RuntimeNode {
  readonly entity: NodeEntity;
  readonly runtime: EntityVersions;
}

/** 连线运行时信封 (EntityStore 内部可写) */
export interface RuntimeConnector {
  readonly entity: ConnectorEntity;
  readonly runtime: EntityVersions;
}

/**
 * 节点运行时只读视图
 * 浅层 Readonly 足以在类型上拦截 `node.x = 1` 这类绕过事务的赋值，同时仍可直接传给接收 NodeEntity 的函数
 */
export interface RuntimeNodeView {
  readonly entity: Readonly<NodeEntity>;
  readonly runtime: Readonly<EntityVersions>;
}

/** 连线运行时只读视图 */
export interface RuntimeConnectorView {
  readonly entity: Readonly<ConnectorEntity>;
  readonly runtime: Readonly<EntityVersions>;
}

/**
 * 引擎求解的连线路由 (纯内存派生缓存)
 * 连线自身或两端节点几何变化时整体替换，下游按对象引用判定是否需要重绘
 */
export interface ComputedRoute {
  /** 有序折线关键点 (世界坐标，至少两个点) */
  readonly points: readonly Point[];
  /** 路由器预生成的路径指令 (如贝塞尔平滑)，缺失时由渲染端按 points 绘制 */
  readonly pathData?: string;
  /** 折线总长度 (供连线文本标注按比例定位) */
  readonly totalLength: number;
  /** 路由点集的外包矩形 (视锥剔除与空间拾取) */
  readonly bounds: RectBounds;
}
