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

/**
 * 连线端点，三种状态：
 * - 浮动 `{ nodeId }`：绑定整个节点，出线位置由路由器按另一端实时选定
 * - 固定 `{ nodeId, anchor }`：节点轮廓上的一点
 * - 自由 `{ position }`：不连接节点的世界坐标
 */
export interface ConnectorEndpoint {
  nodeId?: string;
  /**
   * 固定点：节点局部坐标按宽高归一化 (0~1)，随节点旋转。
   * 存比例而非像素：矩形、椭圆、菱形缩放后轮廓仍经过这一点，改尺寸不会脱离边框
   */
  anchor?: Point;
  position?: Point;
}

/** 指针处的连线端点吸附结果 (见 SkyNoteEngine.snapConnectorEndpoint) */
export interface ConnectorEndpointSnap {
  /** 写入连线的端点 */
  readonly endpoint: ConnectorEndpoint;
  /** 端点的世界坐标；浮动端为节点中心 (实际出线位置由路由决定) */
  readonly point: Point;
  /** 吸附点、边框上任一点、整个节点 (浮动)、不吸附 (自由端) */
  readonly kind: 'anchor' | 'outline' | 'node' | 'free';
}

/** 连线样式规范 */
export interface ConnectorStyle {
  stroke?: string;
  strokeWidth?: number;
  strokeDashArray?: number[];
  strokeCap?: StrokeCap;
  strokeJoin?: StrokeJoin;
  /**
   * 起始端点箭头标记标识
   * 可为内置类型 ('arrow', 'triangle', 'circle', 'diamond') 或自定义注册的 Marker ID ('uml:composition')
   */
  startArrow?: boolean | string;
  /**
   * 结束端点箭头标记标识
   */
  endArrow?: boolean | string;
  /** 拐点处的圆角半径 (折线的自动拐点与直线的手动拐点共用) */
  cornerRadius?: number;
  /** 正交折线离开节点边框的距离 */
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
  /** 线型：即路由器 id ('straight' | 'orthogonal' | 'curved' 或插件注册的路由器) */
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
   * 仅在用户主动拖折连线时记录；自动路由生成的路径点属于运行时计算态，统一由 RouteStore 内存缓存维护，严禁持久化于此。
   */
  controlPoints?: Point[];
}
