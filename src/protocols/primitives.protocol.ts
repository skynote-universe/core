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
  PathFillRule
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
  PathFillRule
};

/** 基础图元类型辨识符 */
export type CanvasPrimitiveKind = 'rect' | 'text' | 'circle' | 'path' | 'line' | 'image';

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
  strokeWidth?: number;
  strokeDashArray?: number[];
  strokeCap?: StrokeCap;
  strokeJoin?: StrokeJoin;
  strokeAlign?: StrokeAlign;
  /** 圆角半径：支持单值或四角独立配置 [左上, 右上, 右下, 左下] */
  radius?: CornerRadius;
  opacity?: number;
}

/** 文本图元 */
export interface TextPrimitive {
  kind: 'text';
  id?: string;
  x: number;
  y: number;
  text: string;
  fontSize?: number;
  fontFamily?: string;
  fontWeight?: FontWeight;
  fontStyle?: FontStyle;
  lineHeight?: number;
  letterSpacing?: number;
  width?: number;
  fill?: string;
  textAlign?: TextAlign;
  verticalAlign?: VerticalAlign;
  textBaseline?: TextBaseline;
  textOverflow?: TextOverflow;
  textDecoration?: TextDecoration;
  textWrap?: TextWrap;
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
  stroke?: string;
  strokeWidth?: number;
  strokeDashArray?: number[];
  opacity?: number;
}

/** 贝塞尔/SVG 路径图元 */
export interface PathPrimitive {
  kind: 'path';
  id?: string;
  d: string;
  fill?: string;
  fillRule?: PathFillRule;
  stroke?: string;
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

/** 跨引擎通用基础图元联合类型 */
export type CanvasPrimitive =
  | RectPrimitive
  | TextPrimitive
  | CirclePrimitive
  | PathPrimitive
  | LinePrimitive
  | ImagePrimitive;
