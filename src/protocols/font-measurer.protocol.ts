/**
 * @file font-measurer.protocol.ts
 * @description 字体测量协议 (FontMeasurer)：排版引擎唯一依赖的宿主能力
 *
 * 设计考量 (Why):
 * 1. 平台中立红线：折行、对齐、光标与选区全部由内核排版 (layout/rich-text-layout) 计算，宿主只回答
 *    「这段文字用这个字体有多宽」。换渲染引擎或平台 (小程序画布) 只需换测量实现，排版结果不变。
 * 2. 测量与绘制同源：渲染适配层提供的实现必须与其绘制文字时使用同一字体串与同一画布测量，
 *    绘制时按排版给出的坐标逐片段落笔，因此量出的宽度即画出的宽度 (ADR-122)。
 */

import type { FontStyle, FontWeight } from '../types/style';

/** 字体规格：一段文字测量与绘制所需的全部字体属性 */
export interface FontSpec {
  /** 缺省时由宿主决定默认字体 (测量与绘制须一致) */
  readonly family?: string;
  readonly size: number;
  readonly weight: FontWeight;
  readonly style: FontStyle;
}

/** 字体测量器 (宿主注入) */
export interface FontMeasurer {
  /** 文字在该字体下的前进宽度 (像素，不含字间距) */
  measureWidth(text: string, font: FontSpec): number;
}
