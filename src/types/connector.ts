/**
 * @file connector.ts
 * @description 连线图元实体 (ConnectorEntity) 与样式模型
 *
 * 设计考量 (Why):
 * 1. 箭头扩展性：startArrow / endArrow 支持字符串 Marker ID (如 'uml:composition', 'standard:arrow')，打通用户自定义注册。
 * 2. 文本块继承统一 TextBlock：连线标注与节点文字共享同一套排版渲染管线。
 */

import type { Point } from './geometry';
import type { FractionalIndex } from './canvas';
import type { TextBlock } from './text';
import type { StrokeCap, StrokeJoin } from './style';

/** 连线端点绑定位置描述 */
export interface ConnectorEndpoint {
  /** 绑定的目标节点 ID */
  nodeId?: string;
  /** 绑定的具体锚点 ID (若未指定则动态吸附到边缘最近点) */
  anchorId?: string;
  /** 自由端点世界坐标 (当未连接到具体节点时使用) */
  position?: Point;
}

/** 连线样式规范 */
export interface ConnectorStyle {
  stroke?: string;
  strokeWidth?: number;
  strokeDashArray?: number[];
  strokeCap?: StrokeCap;
  strokeJoin?: StrokeJoin;
  curveType?: 'bezier' | 'rounded-polyline' | 'polyline' | 'straight';
  /**
   * 起始端点箭头标记标识
   * 可为内置类型 ('arrow', 'triangle', 'circle', 'diamond') 或自定义注册的 Marker ID ('uml:composition')
   */
  startArrow?: boolean | string;
  /**
   * 结束端点箭头标记标识
   */
  endArrow?: boolean | string;
  /** 折线或多段线转弯处的圆角平滑半径 */
  cornerRadius?: number;
  padding?: number;
}

/** 依附在连线上的文本标注块 */
export interface ConnectorTextBlock extends TextBlock {
  /** 沿连线路径归一化的相对距离比例 (0.0 起点 ~ 1.0 终点) */
  position: number;
  offsetX?: number;
  offsetY?: number;
}

/**
 * 连线实体 (ConnectorEntity)
 */
export interface ConnectorEntity<TData = Record<string, unknown>, TStyle extends ConnectorStyle = ConnectorStyle> {
  id: string;
  type: 'connector';
  connectorType: string;
  from: ConnectorEndpoint;
  to: ConnectorEndpoint;
  /** 伴生锚定到同一节点的连线之间的层叠顺序 (分数索引) */
  zIndex: FractionalIndex;
  locked: boolean;
  style?: TStyle;
  textBlocks?: ConnectorTextBlock[];
  /** 业务自定义私有结构载荷 */
  data?: TData;
  /**
   * 用户显式拖拽的手动控制拐点 (单一事实源)
   * 仅在用户主动拖折连线时记录；算法实时避障生成的几十个路径点属于运行时计算态，统一由 RouteStore 内存缓存维护，严禁持久化于此。
   */
  controlPoints?: Point[];
}
