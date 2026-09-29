/**
 * @file connector-router.protocol.ts
 * @description 连线寻路算法定义契约与 defineConnectorRouter 注册协议
 *
 * 设计考量 (Why):
 * 1. 算法与核心解耦：连线寻路具有高度多样性（直线、曼哈顿正交、A* 避障、贝塞尔平滑、思维导图分支），
 *    核心层不应写死实现，而是通过 ConnectorRouterRegistry 策略模式开放插拔。
 * 2. 纯函数铁律 (AGENTS.md)：寻路计算严禁修改输入的坐标或节点对象，必须生成全新坐标数组或 SVG 路径。
 * 3. 渐进式消费：既支持返回纯关键折点 points: Point[]，也支持直接输出带贝塞尔曲线的 SVG pathData。
 */

import type { Point } from '../types/canvas';
import type { RectBounds } from '../utils/geometry';
import type { ConnectorEntity, ConnectorStyle } from '../types/connector';

/** 端点连接几何朝向/法线 */
export type ConnectorDirection = 'top' | 'right' | 'bottom' | 'left';

/** 连线寻路算法入参上下文 */
export interface ConnectorRouterInput {
  /** 起始端点物理世界坐标 */
  readonly startPoint: Point;
  /** 结束端点物理世界坐标 */
  readonly endPoint: Point;
  /** 起始锚点离开方向 (可选) */
  readonly startDirection?: ConnectorDirection;
  /** 结束锚点进入方向 (可选) */
  readonly endDirection?: ConnectorDirection;
  /** 用户拖拽产生的手动控制点列表 (可选) */
  readonly controlPoints?: readonly Point[];
  /** 连线样式配置 */
  readonly style?: ConnectorStyle;
  /** 宿主连线实体元数据 */
  readonly connector?: ConnectorEntity;
  /**
   * 避障障碍物包围盒集合 (可选，空间索引查询或画布传入)
   * 供 A* / 曼哈顿避障等高级算法使用
   */
  readonly obstacles?: readonly RectBounds[];
}

/** 连线寻路计算输出结果 */
export interface ConnectorRouterResult {
  /**
   * 寻路求解出的有序折线关键点 (World Coordinates)
   * 至少包含起点与终点两个点
   */
  readonly points: Point[];
  /**
   * 可选的预生成 SVG 路径指令字符串 (例如已计算好圆角或贝塞尔平滑的 'M ... C ...')
   * 渲染端优先消费 pathData，缺失时降级为 points 生成
   */
  readonly pathData?: string;
}

/**
 * 连线寻路算法定义契约
 */
export interface ConnectorRouterDefinition {
  /** 路由算法全局唯一标识，如 'straight', 'orthogonal', 'curved', 'mindmap' */
  readonly id: string;
  /** UI 呈现说明 */
  readonly label: string;
  /**
   * 寻路执行纯函数 (Pure Function)
   * 严禁篡改入参中的点或障碍物，必须返回全新计算结果
   */
  route(input: ConnectorRouterInput): ConnectorRouterResult;
}

/**
 * 连线寻路算法抽象基类 (策略模式)
 * 允许上层插件通过继承扩展专业寻路算法，具备完整的类型守卫与实例化能力
 */
export abstract class ConnectorRouter implements ConnectorRouterDefinition {
  abstract readonly id: string;
  abstract readonly label: string;
  abstract route(input: ConnectorRouterInput): ConnectorRouterResult;
}

/**
 * 辅助构造函数：为插件开发者提供类型推导友好的路由算法定义工具
 */
export function defineConnectorRouter(definition: ConnectorRouterDefinition): ConnectorRouterDefinition {
  return definition;
}
