/**
 * @file node.ts
 * @description 通用图元节点实体 (NodeEntity) 与样式模型
 *
 * 设计考量 (Why):
 * 1. 纯净持久化模型：仅包含 100% 存入 JSON 的业务数据，脏检查版本号已彻底剥离至 RuntimeNode 信封中。
 * 2. 消费统一 TextBlock：节点内所有文字排版统一收敛，消灭多套排版逻辑。
 */

import type { Point } from "./canvas";
import type { TextBlock, NodeTextStyle } from "./text";
import type { CornerRadius, StrokeCap, StrokeJoin, StrokeAlign } from "./style";

/** 渐变停靠点 */
export interface NodeGradientStop {
    offset: number;
    color: string;
}

/** 渐变填充样式 */
export interface NodeGradientFill {
    type: "linear" | "radial";
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

/** 连线吸附锚点 */
export interface NodeAnchor {
    id: string;
    x: number;
    y: number;
    name?: string;
    direction?: Point;
}

/**
 * 通用图元节点实体 (NodeEntity)
 * 纯内存不可变实体数据源
 */
export interface NodeEntity<TData = Record<string, unknown>, TStyle extends NodeStyle = NodeStyle> {
    id: string;
    type: "node";
    /** 节点具体业务类型，如 free-text, card, rect, mindmap 等 */
    nodeType: string;
    /** 所属容器或父节点 ID (用于画框嵌套、导图父子树等) */
    parentId?: string;
    /** 纯逻辑世界坐标 x */
    x: number;
    /** 纯逻辑世界坐标 y */
    y: number;
    width: number;
    height: number;
    rotation: number;
    zIndex: number;
    locked: boolean;

    /** 绑定的统一文本块列表 (单一事实源) */
    textBlocks?: TextBlock[];
    /** 几何外观样式 */
    style?: TStyle;
    /** 默认文本外观 */
    textStyle?: NodeTextStyle;
    /** 暴露给连线的吸附锚点 */
    anchors?: NodeAnchor[];
    /** 业务自定义私有结构载荷 */
    data?: TData;
}
