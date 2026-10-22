/**
 * @file text.ts
 * @description 统一富文本数据模型与排版规范
 *
 * 设计考量 (Why):
 * 1. 消除文本双轨制：废除旧版中并存的 value: string 与 runs: RichTextRun[]。
 *    单一事实源铁律：纯文本本质上就是仅含 1 个无修饰 run 的特例。
 * 2. 测量与渲染管线复用：测量引擎与渲染器只需针对 RichTextRun[] 进行处理。
 * 3. 对齐行业排版三态：支持 auto-height (固定宽度/自动向下撑高)、auto-width (双向自适应)、fixed (完全固定)。
 */

import type {
  FontWeight,
  FontStyle,
  TextAlign,
  VerticalAlign,
  TextBaseline,
  TextOverflow,
  TextDecoration,
  TextDecorationLine,
  TextWrap,
  TextPadding,
  LineHeight
} from './style';

/** 行内富文本分段样式 (单一事实源) */
export interface RichTextRunStyle {
  color?: string;
  backgroundColor?: string | null;
  fontSize?: number;
  fontWeight?: FontWeight;
  fontStyle?: FontStyle;
  fontFamily?: string;
  lineHeight?: LineHeight;
  letterSpacing?: number;
  textDecoration?: TextDecoration;
  textAlign?: TextAlign;

  /** 超链接目标 URL (支持外部 http/https 或画布内部定位 skynote://node/id) */
  link?: string;
  /** 行内代码标记 (呈现为 Monospace 浅背景样式) */
  code?: boolean;
}

/** 富文本分段原子 (RichTextRun) - 排版最小颗粒 */
export interface RichTextRun extends RichTextRunStyle {
  text: string;
}

/** 块级文本排版外观样式 */
export interface NodeTextStyle {
  color?: string;
  backgroundColor?: string | null;
  fontSize?: number;
  fontWeight?: FontWeight;
  fontStyle?: FontStyle;
  fontFamily?: string;
  lineHeight?: LineHeight;
  letterSpacing?: number;
  textAlign?: TextAlign;
  verticalAlign?: VerticalAlign;
  textBaseline?: TextBaseline;
  /** 文字超出文本框时的显示方式 (缺省 none)；编辑时一律完整显示，见 editingTextPrimitive */
  textOverflow?: TextOverflow;
  textDecoration?: TextDecoration;
  textWrap?: TextWrap;
  /** 文本块内边距：支持单值或 [上, 右, 下, 左] */
  padding?: TextPadding;
}

/** 文本排版尺寸自适应策略 (对标 Figma 标准排版三态) */
export type TextSizingMode =
  | 'auto-height' // 固定宽度，自动折行，高度向下自动随文字行数撑开 (最常用的便签卡片、正文段落)
  | 'auto-width' // 宽度随文字延伸不主动折行，单行/双向自适应 (适合短标题、按钮标签)
  | 'fixed'; // 宽高完全固定锁死，超出部分截断

/**
 * 统一文本块实体 (TextBlock)
 * 供节点、便签、连线标签等所有需要文字排版的图元统一消费
 */
export interface TextBlock {
  id: string;
  /**
   * 文本块在宿主节点内部绑定的语义插槽 (Slot)
   * 例如：卡片的 'title' | 'body'，UML 节点的 'class-name' | 'attributes'，连线的 'label'
   */
  slot?: string;

  /**
   * 文本片段序列 (单一事实源)
   * 即使是纯文本，也以 runs: [{ text: "..." }] 的形式表达
   */
  runs: RichTextRun[];

  /** 块级排版样式 */
  style?: NodeTextStyle;

  /** 尺寸自适应策略重载 (选填，若未指定则跟随所属 Slot 的默认定义) */
  sizing?: TextSizingMode;

  /**
   * 显式指定的排版宽度 (像素)
   * 手动调整或整体内容缩放时持久化覆盖；未提供时使用宿主可用宽度，连线标注使用默认最大排版宽度
   */
  explicitWidth?: number;

  /** 显式指定的排版高度 (仅当用户手动拉新手柄时持久化覆盖) */
  explicitHeight?: number;
}

/** 便捷构建选项参数 */
export interface SimpleTextBlockOptions {
  style?: NodeTextStyle;
  sizing?: TextSizingMode;
  slot?: string;
}

/**
 * 纯函数：提取文本块中的纯文本内容 (用于全文搜索、无样式导出)
 */
export function getPlainText(block: TextBlock): string {
  if (!block.runs || block.runs.length === 0) return '';
  return block.runs.map((run) => run.text).join('');
}

/**
 * 纯函数：判断文本块是否为单段纯文本 (供渲染器与测量管线走单段文本的简化分支)
 */
export function isSimpleText(block: TextBlock): boolean {
  return block.runs.length === 1 && !block.runs[0].link && !block.runs[0].code;
}

/**
 * 纯函数：便捷构建单段纯文本块
 * 让上层开发者无需手写 runs 数组，兼顾开发爽快度
 */
export function createSimpleTextBlock(id: string, text: string, options?: SimpleTextBlockOptions): TextBlock {
  return {
    id,
    slot: options?.slot,
    runs: [{ text }],
    style: options?.style,
    sizing: options?.sizing
  };
}

/**
 * 纯函数：判断文本装饰线是否包含指定样式
 */
export function hasTextDecoration(decoration: TextDecoration | undefined, target: TextDecorationLine): boolean {
  if (!decoration || decoration === 'none') return false;
  return Array.isArray(decoration) ? decoration.includes(target) : decoration === target;
}

/**
 * 纯函数：向现有装饰线中安全添加新样式 (自动去重)
 */
export function addTextDecoration(
  current: TextDecoration | undefined,
  target: TextDecorationLine
): TextDecorationLine[] {
  if (!current || current === 'none') return [target];
  const list = Array.isArray(current) ? current : [current];
  return list.includes(target) ? list : [...list, target];
}

/**
 * 纯函数：从现有装饰线中移除指定样式
 */
export function removeTextDecoration(
  current: TextDecoration | undefined,
  target: TextDecorationLine
): TextDecorationLine[] | 'none' {
  if (!current || current === 'none') return 'none';
  const list = Array.isArray(current) ? current : [current];
  const filtered = list.filter((item) => item !== target);
  return filtered.length > 0 ? filtered : 'none';
}

/**
 * 纯函数：切换装饰线状态 (有则移除，无则追加，自动规范化)
 */
export function toggleTextDecoration(
  current: TextDecoration | undefined,
  target: TextDecorationLine
): TextDecorationLine[] | 'none' {
  return hasTextDecoration(current, target)
    ? removeTextDecoration(current, target)
    : addTextDecoration(current, target);
}
