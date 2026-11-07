/**
 * @file node.ts
 * @description 通用图元节点实体 (NodeEntity) 与样式模型
 *
 * 设计考量 (Why):
 * 1. 纯净持久化模型：仅包含 存入 JSON 的业务数据，脏检查版本号已剥离至 RuntimeNode 信封中。
 * 2. 消费统一 TextBlock：节点内所有文字排版统一收敛，消灭多套排版逻辑。
 */

import type { Point } from './geometry';
import type { FractionalIndex } from './canvas';
import type { TextBlock, NodeTextStyle } from './text';
import type { CornerRadius, StrokeCap, StrokeJoin, StrokeAlign } from './style';

/** 渐变停靠点 */
export interface NodeGradientStop {
  offset: number;
  color: string;
}

/** 渐变填充样式 */
export interface NodeGradientFill {
  type: 'linear' | 'radial';
  from?: Point;
  to?: Point;
  stops: NodeGradientStop[];
}

export type NodeFill = string | NodeGradientFill;

/** 通用图元几何样式 */
export interface NodeStyle {
  fill?: NodeFill;
  fillOpacity?: number;
  stroke?: string;
  strokeOpacity?: number;
  strokeWidth?: number;
  strokeDashArray?: number[];
  strokeCap?: StrokeCap;
  strokeJoin?: StrokeJoin;
  strokeAlign?: StrokeAlign;
  /** 圆角半径：支持单值或四角独立配置 [左上, 右上, 右下, 左下] */
  radius?: CornerRadius;
  shadowColor?: string;
  shadowBlur?: number;
  shadowOffsetX?: number;
  shadowOffsetY?: number;
  opacity?: number;
}

/** 布局根声明 (ADR-130)：节点的成员子树按此布局自动排列 */
export interface NodeLayout {
  /** 已注册布局的 id，如 'mindmap' */
  type: string;
  /** 布局自有参数：由布局在读取时校验，非法值回落默认 */
  options?: Record<string, unknown>;
}

/** 布局成员的持久化展示状态，由声明对应能力的布局解释。 */
export interface NodeLayoutState {
  collapsed?: boolean;
}

/**
 * 节点顶层自定义字段登记表：插件通过模块扩展声明有明确结构的特性字段，避免将其埋入通用 data
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- 供模块扩充的登记表，内核自身不登记任何类型
export interface CustomNodeFields {}

/** 节点实体：持久化的纯数据，只经事务修改 */
export interface NodeEntity<
  TData = Record<string, unknown>,
  TStyle extends NodeStyle = NodeStyle
> extends CustomNodeFields {
  id: string;
  type: 'node';
  /** 节点业务类型，对应已注册的 NodeTypeDefinition.type */
  nodeType: string;
  /** 所属容器 (画框嵌套、导图父子树)；缺省为根层级 */
  parentId?: string;
  /** 左上角，父容器局部坐标 (ADR-114)；世界位置见 EntityReader.getWorldTransform */
  x: number;
  y: number;
  width: number;
  height: number;
  /** 绕自身中心旋转的角度 (度)，相对父容器 */
  rotation: number;
  /**
   * 同一容器 (相同 parentId) 兄弟之间的层叠顺序：分数索引字符串，越大越靠上
   * 调整层级只改被移动节点自身；键相同时按 id 决出先后，保证各客户端一致
   */
  zIndex: FractionalIndex;
  locked: boolean;
  /**
   * 比例锁定：锁定后缩放只能等比 (比例即当前宽高之比，不单独存储)
   * 缺省时取节点类型的 defaultAspectLocked；用户切换后写入显式值
   */
  aspectLocked?: boolean;

  /** 绑定的统一文本块列表 (单一事实源) */
  textBlocks?: TextBlock[];
  /** 几何外观样式 */
  style?: TStyle;
  /** 默认文本外观 */
  textStyle?: NodeTextStyle;
  /** 开放式业务载荷；有明确结构与语义的节点特性应声明为具名扩展字段 */
  data?: TData;
  /** 布局根：成员子树按此布局排列 (ADR-130) */
  layout?: NodeLayout;
  /**
   * 布局成员标记与成员属性 (ADR-130)：带此字段且父节点是成员或布局根的节点参与排版；
   * 各键归使用它的插件 (如导图的左右侧、分支线来源的 branch)，内核不解释
   */
  layoutItem?: Record<string, unknown>;
  /** 布局成员的展示状态；仅声明 collapsible 的布局解释折叠。 */
  layoutState?: NodeLayoutState;
}
