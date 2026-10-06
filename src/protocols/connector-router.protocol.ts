/**
 * @file connector-router.protocol.ts
 * @description 连线寻路算法定义契约：插件继承 ConnectorRouter 实现，经 registerConnectorRouter 注册
 *
 * 设计考量 (Why):
 * 1. 算法与核心解耦：连线寻路具有高度多样性（直线、曼哈顿正交、A* 避障、贝塞尔平滑、思维导图分支），
 *    核心层不应写死实现，而是通过 ConnectorRouterRegistry 策略模式开放插拔。
 * 2. 纯函数铁律 (AGENTS.md)：寻路计算严禁修改输入的坐标或节点对象，必须生成全新坐标数组或 SVG 路径。
 * 3. 渐进式消费：既支持返回纯关键折点 points: Point[]，也支持直接输出带贝塞尔曲线的 SVG pathData。
 */

import type { Point, RectBounds } from '../types/geometry';
import type { ConnectorStyle } from '../types/connector';

/** 已解析的连线一端 (世界坐标) */
export interface ConnectorRouteEnd {
  readonly point: Point;
  /** 出线方向 (单位向量，轮廓外法线)；自由端缺省，由路由器按另一端自行决定 */
  readonly direction?: Point;
  /** 所连节点的世界包围盒：正交折线据此绕开两端节点；自由端缺省 */
  readonly bounds?: RectBounds;
}

/** 连线寻路算法入参上下文 */
export interface ConnectorRouterInput {
  readonly start: ConnectorRouteEnd;
  readonly end: ConnectorRouteEnd;
  /** 用户拖拽产生的手动拐点 (世界坐标) */
  readonly controlPoints?: readonly Point[];
  /** 生效样式：路由器默认样式 < 连线自身样式 */
  readonly style: ConnectorStyle;
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
 * 浮动端 (只绑定节点) 的出线位置：
 * - 'side'：取面向另一端的那条边的吸附点，线垂直离开边框 (折线、曲线)
 * - 'boundary'：取节点中心指向另一端的射线与轮廓的交点 (直线)
 */
export type FloatingEndpointMode = 'side' | 'boundary';

/**
 * 连线寻路算法定义契约
 */
export interface ConnectorRouterDefinition {
  /** 路由算法全局唯一标识，即连线的 connectorType，如 'straight', 'orthogonal', 'curved' */
  readonly id: string;
  /** UI 呈现说明 */
  readonly label: string;
  /** 浮动端出线位置 (缺省 'boundary') */
  readonly floating?: FloatingEndpointMode;
  /** 连线未设置的样式项取此默认值 (如折线圆角 8)；绘制与界面面板读同一份生效样式 */
  readonly defaultStyle?: ConnectorStyle;
  /**
   * 寻路执行纯函数 (Pure Function)
   * 严禁篡改入参，必须返回全新计算结果
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
