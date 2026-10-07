/**
 * @file primitives.protocol.ts
 * @description 声明式跨引擎中间图元协议 (Canvas Primitive IR)
 *
 * 设计考量 (Why):
 * 1. 跨渲染器统一语言：定义纯 JSON 描述的基础图元（矩形、文本、圆、路径）。
 * 2. 第三方插件免适配：插件开发者只需实现 nodeType.compose(node)，即可自动在 LeaferJS、PixiJS、WebGPU 或 SVG 导出器中绘制，无需针对每个引擎写原生代码。
 */

import type {
  CornerRadius,
  StrokeCap,
  StrokeJoin,
  StrokeAlign,
  FontWeight,
  FontStyle,
  TextAlign,
  VerticalAlign,
  TextBaseline,
  TextOverflow,
  TextDecoration,
  TextDecorationLine,
  TextWrap,
  ImageFit,
  PathFillRule,
  OverflowMode,
  NodeTextStyle,
  RichTextRun
} from '../types';

export type {
  CornerRadius,
  StrokeCap,
  StrokeJoin,
  StrokeAlign,
  FontWeight,
  FontStyle,
  TextAlign,
  VerticalAlign,
  TextBaseline,
  TextOverflow,
  TextDecoration,
  TextDecorationLine,
  TextWrap,
  ImageFit,
  PathFillRule,
  OverflowMode
};

/** 基础图元类型辨识符 */
export type CanvasPrimitiveKind =
  'rect' | 'text' | 'circle' | 'ellipse' | 'polygon' | 'path' | 'line' | 'image' | 'group' | 'box';

/** 矩形图元 */
export interface RectPrimitive {
  kind: 'rect';
  id?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fill?: string;
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
  opacity?: number;
}

/**
 * 文本图元：富文本分段 + 块级样式，由内核排版 (layoutText) 分行对齐后，渲染器逐片段绘制 (ADR-122)
 * 绘制与测量共用同一份排版，自动尺寸与画面一致
 */
export interface TextPrimitive {
  kind: 'text';
  id?: string;
  x: number;
  y: number;
  /** 排版宽度：缺省为不折行 */
  width?: number;
  /** 文本框高度：配合 verticalAlign 垂直对齐，配合 textOverflow 截断超出的行；缺省为内容高度 */
  height?: number;
  runs: readonly RichTextRun[];
  /** 块级样式 (内边距已由位置与尺寸体现，这里不再处理) */
  style: NodeTextStyle;
  /** 画布内编辑时的滚动：内容上移 scrollY，并裁剪到文本框内 (需有 height) */
  scrollY?: number;
  opacity?: number;
}

/** 圆形图元 */
export interface CirclePrimitive {
  kind: 'circle';
  id?: string;
  cx: number;
  cy: number;
  r: number;
  fill?: string;
  fillOpacity?: number;
  stroke?: string;
  strokeOpacity?: number;
  strokeWidth?: number;
  strokeDashArray?: number[];
  opacity?: number;
}

/** 椭圆图元 (双轴半径，支持流程图起止符与任意倾角) */
export interface EllipsePrimitive {
  kind: 'ellipse';
  id?: string;
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  rotation?: number;
  fill?: string;
  fillOpacity?: number;
  stroke?: string;
  strokeOpacity?: number;
  strokeWidth?: number;
  strokeDashArray?: number[];
  opacity?: number;
}

/** 闭合多边形图元 (流程图菱形判断框、三角形、正多边形，支持自动闭合与顶点倒圆角) */
export interface PolygonPrimitive {
  kind: 'polygon';
  id?: string;
  points: number[];
  fill?: string;
  fillOpacity?: number;
  stroke?: string;
  strokeOpacity?: number;
  strokeWidth?: number;
  strokeDashArray?: number[];
  strokeCap?: StrokeCap;
  strokeJoin?: StrokeJoin;
  /** 顶点倒圆角平滑半径 */
  cornerRadius?: number;
  opacity?: number;
}

/** 贝塞尔/SVG 路径图元 */
export interface PathPrimitive {
  kind: 'path';
  id?: string;
  d: string;
  fill?: string;
  fillOpacity?: number;
  fillRule?: PathFillRule;
  stroke?: string;
  strokeOpacity?: number;
  strokeWidth?: number;
  strokeDashArray?: number[];
  strokeCap?: StrokeCap;
  strokeJoin?: StrokeJoin;
  opacity?: number;
}

/** 线段/折线图元 */
export interface LinePrimitive {
  kind: 'line';
  id?: string;
  points: number[];
  stroke?: string;
  strokeOpacity?: number;
  strokeWidth?: number;
  strokeDashArray?: number[];
  strokeCap?: StrokeCap;
  strokeJoin?: StrokeJoin;
  /** 折线拐弯处的圆角平滑半径 */
  cornerRadius?: number;
  opacity?: number;
}

/** 图片图元 (遵守零 Base64 红线，通过 assetId 引用资产或静态安全 URL) */
export interface ImagePrimitive {
  kind: 'image';
  id?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  assetId?: string;
  url?: string;
  fit?: ImageFit;
  /** 圆角半径：支持单值或四角独立配置 */
  radius?: CornerRadius;
  opacity?: number;
}

/** 复合图元组 (支持局部坐标系嵌套与整体透明度，无自身外观) */
export interface GroupPrimitive {
  kind: 'group';
  id?: string;
  x?: number;
  y?: number;
  rotation?: number;
  opacity?: number;
  children: CanvasPrimitive[];
}

/** 盒模型内容容器图元 (拥有自身矩形外观、尺寸、圆角与溢出裁剪，对标 LeaferJS Box 与 Figma Frame) */
export interface BoxPrimitive {
  kind: 'box';
  id?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fill?: string;
  fillOpacity?: number;
  stroke?: string;
  strokeOpacity?: number;
  strokeWidth?: number;
  strokeDashArray?: number[];
  strokeCap?: StrokeCap;
  strokeJoin?: StrokeJoin;
  strokeAlign?: StrokeAlign;
  /** 圆角半径：当 overflow 为 'hidden' 时连同圆角内胆一同裁剪 */
  radius?: CornerRadius;
  /** 容器内容溢出控制：'visible' (默认溢出可见) | 'hidden' (超出矩形/圆角区域自动裁切) */
  overflow?: OverflowMode;
  rotation?: number;
  opacity?: number;
  children: CanvasPrimitive[];
}

/** 跨引擎通用基础图元联合类型 */
export type CanvasPrimitive =
  | RectPrimitive
  | TextPrimitive
  | CirclePrimitive
  | EllipsePrimitive
  | PolygonPrimitive
  | PathPrimitive
  | LinePrimitive
  | ImagePrimitive
  | GroupPrimitive
  | BoxPrimitive;
