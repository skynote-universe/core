/**
 * @file text-measurer.protocol.ts
 * @description 文本测量协议 (TextMeasurer)
 *
 * 设计考量 (Why):
 * 1. 平台中立红线：内核不触碰 Canvas / DOM，文本度量必须由宿主注入；渲染适配层应提供与自身排版一致的实现
 *    (如 renderer-leafer 的 createLeaferTextMeasurer)，保证测得的尺寸与实际绘制完全一致。
 * 2. 只量内容盒：测量结果不含块级 padding，由排版管线统一叠加，测量器实现保持最小职责。
 */

import type { TextBlock, NodeTextStyle, TextSizingMode } from '../types/text';
import type { TextBlockMetrics } from './node-type.protocol';

/** 单个文本块的测量请求 */
export interface TextMeasureRequest {
  readonly block: Readonly<TextBlock>;
  /** 最终生效样式：插槽默认样式 < 节点 textStyle < 文本块 style 逐层覆盖 */
  readonly style: Readonly<NodeTextStyle>;
  readonly sizing: TextSizingMode;
  /** 折行可用宽度 (已扣除左右 padding)；auto-width 时为 undefined，表示不主动折行 */
  readonly maxWidth?: number;
}

/** 文本测量器 (宿主注入) */
export interface TextMeasurer {
  /** 同步测量文本块内容盒尺寸 (不含 padding) */
  measure(request: TextMeasureRequest): TextBlockMetrics;
}
