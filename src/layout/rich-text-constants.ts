/**
 * @file rich-text-constants.ts
 * @description 富文本排版常量：默认字号、行距、容差与中日韩标点禁则集合 (ADR-122)
 *
 * 设计考量 (Why):
 * 1. 纯净静态数据抽离：将大段不常变动的字符集与排版数学容差从算法主流程剥离，减少排版主文件心智干扰。
 * 2. 标点避头尾法则 (JIS X 4051 / 标点禁则规范)：句号、逗号、右括弧等不得出现在行首，左括弧等不得出现在行尾。
 */

export const DEFAULT_FONT_SIZE = 14;

/** 行高缺省为 1.5 倍字号 (与此前 Leafer 文字的缺省一致) */
export const DEFAULT_LINE_HEIGHT = 1.5;

export const ASCENT_RATIO = 0.7;

export const ELLIPSIS = '…';

/** 宽度比较容差：浮点测量误差不应导致多折一行 */
export const WIDTH_EPSILON = 0.01;

/** 尺寸比较容差：浮点测量抖动 (半像素内) 不产生无意义的尺寸补丁 */
export const SIZE_EPSILON = 0.5;

/** 不能出现在行首的标点 (避头尾法则 / 行首禁则) */
export const NO_LINE_START: ReadonlySet<string> = new Set(
  '!),.:;?]}¢°·’”…‥、。〉》」』】〕〗〞︰︱︳﹐﹒﹔﹕﹖﹗﹚﹜﹞！），．：；？］｝～％'.split('')
);

/** 不能出现在行尾的标点 (避头尾法则 / 行尾禁则) */
export const NO_LINE_END: ReadonlySet<string> = new Set('([{£¥‘“〈《「『【〔〖〝﹙﹛﹝（［｛￡￥'.split(''));
