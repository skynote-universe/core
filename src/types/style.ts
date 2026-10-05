/**
 * @file style.ts
 * @description 通用图形与排版样式基础枚举及值对象
 *
 * 设计考量 (Why):
 * 1. 单一事实源：几何、边框、字体、排版与填充模式在实体层与协议层 共享，消灭重复定义。
 * 2. 纯净跨端：纯数据与字面量联合类型，零 DOM / Canvas 依赖。
 */

/** 圆角规格定义：单值统一圆角，或四角分别设定 [左上, 右上, 右下, 左下] */
export type CornerRadius = number | [number, number, number, number];

/** 线条端点样式 */
export type StrokeCap = 'butt' | 'round' | 'square';

/** 线条拐角连接样式 */
export type StrokeJoin = 'miter' | 'round' | 'bevel';

/** 描边对齐方式 */
export type StrokeAlign = 'center' | 'inside' | 'outside';

/** 文本字重枚举 */
export type FontWeight = 'normal' | 'bold' | 'lighter' | 'bolder' | 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900;

/** 字体倾斜样式 */
export type FontStyle = 'normal' | 'italic' | 'oblique';

/** 文本水平对齐方式 */
export type TextAlign = 'left' | 'center' | 'right' | 'justify';

/** 文本垂直对齐方式 */
export type VerticalAlign = 'top' | 'middle' | 'bottom';

/** 文本基线对齐方式 */
export type TextBaseline = 'top' | 'middle' | 'bottom' | 'alphabetic';

/** 文字超出文本框时的显示方式：none 照常显示；clip 裁剪到文本框；ellipsis 裁剪并在可见末尾补省略号 */
export type TextOverflow = 'none' | 'clip' | 'ellipsis';

/** 文本装饰线原子基元 */
export type TextDecorationLine = 'underline' | 'line-through';

/** 文本下划线/删除线装饰规范：支持单值基元、结构化多选数组、或无 */
export type TextDecoration = 'none' | TextDecorationLine | TextDecorationLine[];

/** 文本折行与分词模式 */
export type TextWrap = 'normal' | 'break-all' | 'break-word' | 'none';

/** 图片适应与填充缩放模式 */
export type ImageFit = 'fill' | 'cover' | 'contain' | 'none';

/** SVG 路径填充环绕规则 */
export type PathFillRule = 'nonzero' | 'evenodd';

/** 容器与文本内边距规范：支持统一单值，或四边独立设定 [上, 右, 下, 左] */
export type TextPadding = number | [number, number, number, number];

/**
 * 行高：数字表示字号的倍数 (如 1.5，改字号时行高自动跟随)，`'24px'` 形式的字符串表示像素值
 * 与 CSS 无单位 line-height 与像素写法一致
 */
export type LineHeight = number | `${number}px`;

/** 容器图元溢出裁剪模式 */
export type OverflowMode = 'visible' | 'hidden';
