/**
 * @file rich-text-layout.ts
 * @description 富文本排版引擎 (纯函数)：分行、对齐、截断，以及光标与选区的几何换算 (ADR-122)
 *
 * 设计考量 (Why):
 * 1. 排版只在内核做一次：渲染器按这里给出的坐标逐片段绘制，测量 (自动尺寸) 与编辑 (光标、选区、点击定位)
 *    读同一份结果，三者不可能错位；宿主只提供 FontMeasurer 量宽度。
 * 2. 分行以「不可断开的单元」为粒度：拉丁文按词、中日韩按字，并遵守标点禁则 (句号、右括号不出现在行首，
 *    左括号不出现在行尾)；单元可以跨越样式分段 (词内局部加粗也不会被拆开)。单元本身比行还宽时才逐字断开。
 * 3. 基线模型：字形上沿按 0.7 倍字号估计，行框内上下半行距均分 (与 Leafer 的单样式文字一致，
 *    切换排版引擎后既有文字的位置不变)；同一行内不同字号按基线对齐，行高取各片段所需的最大值。
 * 4. 段落对齐：取段落首字所在分段的 textAlign (设置时作用于整段)，未设置时取块样式；两端对齐把软折行的剩余空间
 *    均分到断行单元之间 (段落末行照常左对齐)，每个单元单独成片段，光标定位无需特殊处理；内容高于文本框时
 *    从顶部排起 (垂直对齐只在放得下时生效)，编辑时超出部分按滚动显示。
 * 5. 偏移以 UTF-16 码元计 (与 JS 字符串一致)，但断行与光标步进按码点，代理对不会被拆开。
 */

import type { FontMeasurer, FontSpec } from '../protocols/font-measurer.protocol';
import type { LineHeight, TextAlign, TextDecoration } from '../types/style';
import type { NodeTextStyle, RichTextRun, RichTextRunStyle } from '../types/text';
import {
  ASCENT_RATIO,
  DEFAULT_FONT_SIZE,
  DEFAULT_LINE_HEIGHT,
  ELLIPSIS,
  NO_LINE_END,
  NO_LINE_START,
  WIDTH_EPSILON
} from './rich-text-constants';

export { ASCENT_RATIO, DEFAULT_FONT_SIZE, DEFAULT_LINE_HEIGHT, ELLIPSIS, NO_LINE_END, NO_LINE_START, WIDTH_EPSILON };

/** 片段的最终样式：块样式与分段样式合并后的结果 */
export interface ResolvedRunStyle {
  readonly font: FontSpec;
  /** 行高 (像素) */
  readonly lineHeight: number;
  readonly letterSpacing: number;
  readonly color?: string;
  readonly backgroundColor?: string;
  readonly underline: boolean;
  readonly lineThrough: boolean;
}

/** 行内同一样式的一段文字 */
export interface TextFragment {
  readonly text: string;
  readonly start: number;
  readonly end: number;
  /** 片段左边 (文本框坐标，已含对齐偏移) */
  readonly x: number;
  readonly width: number;
  readonly style: ResolvedRunStyle;
}

export interface TextLine {
  readonly start: number;
  /** 行末偏移 (不含换行符)；软折行时等于下一行的 start */
  readonly end: number;
  readonly top: number;
  readonly height: number;
  /** 基线 y (文本框坐标) */
  readonly baseline: number;
  /** 行内容左边 (已含对齐偏移) */
  readonly left: number;
  /** 行宽 (不含行尾空白) */
  readonly width: number;
  readonly fragments: readonly TextFragment[];
  /** 以换行符或文本末尾结束；否则为软折行 */
  readonly hardBreak: boolean;
}

export interface TextLayout {
  /** 全部分段拼接后的纯文本 */
  readonly text: string;
  /** 可见行 (框高截断后) */
  readonly lines: readonly TextLine[];
  /** 全部行的内容宽高 (不受截断影响)：自动尺寸以此为准 */
  readonly width: number;
  readonly height: number;
  /** 因框高不足省略或裁掉了行 */
  readonly truncated: boolean;
}

/** 排版框：宽度缺省时不折行；高度缺省时为内容高度 */
export interface TextLayoutBox {
  readonly width?: number;
  readonly height?: number;
}

/** 光标位置的归属：软折行处同一偏移既是上一行末尾也是下一行开头 */
export type CaretAffinity = 'forward' | 'backward';

export interface CaretRect {
  readonly x: number;
  readonly top: number;
  readonly height: number;
  readonly lineIndex: number;
}

export interface TextHit {
  readonly offset: number;
  readonly affinity: CaretAffinity;
}

export interface TextRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** 行高 (像素)：数字为字号倍数，'24px' 为像素 */
export function resolveLineHeightPx(lineHeight: LineHeight | undefined, fontSize: number): number {
  if (lineHeight === undefined) return fontSize * DEFAULT_LINE_HEIGHT;
  return typeof lineHeight === 'number' ? fontSize * lineHeight : Number.parseFloat(lineHeight);
}

function hasDecoration(decoration: TextDecoration | undefined, line: 'underline' | 'line-through'): boolean {
  if (decoration === undefined || decoration === 'none') return false;
  return Array.isArray(decoration) ? decoration.includes(line) : decoration === line;
}

/** 分段样式覆盖块样式；未设置的字段取块样式，再取缺省值 */
export function resolveRunStyle(block: Readonly<NodeTextStyle>, run: Readonly<RichTextRunStyle>): ResolvedRunStyle {
  const size = run.fontSize ?? block.fontSize ?? DEFAULT_FONT_SIZE;
  const decoration = run.textDecoration ?? block.textDecoration;
  const background = run.backgroundColor === undefined ? block.backgroundColor : run.backgroundColor;
  return {
    font: {
      family: run.fontFamily ?? block.fontFamily,
      size,
      weight: run.fontWeight ?? block.fontWeight ?? 'normal',
      style: run.fontStyle ?? block.fontStyle ?? 'normal'
    },
    lineHeight: resolveLineHeightPx(run.lineHeight ?? block.lineHeight, size),
    letterSpacing: run.letterSpacing ?? block.letterSpacing ?? 0,
    color: run.color ?? block.color,
    backgroundColor: background ?? undefined,
    underline: hasDecoration(decoration, 'underline'),
    lineThrough: hasDecoration(decoration, 'line-through')
  };
}

/** 基线以上所需高度：行框上半行距 + 0.7 倍字号 */
function ascentOf(style: ResolvedRunStyle): number {
  return (style.lineHeight + style.font.size * ASCENT_RATIO) / 2;
}

function isSpace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '　';
}

/** 中日韩文字与全角符号：字与字之间可以断行 */
function isCjk(code: number): boolean {
  return (
    (code >= 0x2e80 && code <= 0x9fff) ||
    (code >= 0xac00 && code <= 0xd7af) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xff00 && code <= 0xffef) ||
    (code >= 0x20000 && code <= 0x3ffff)
  );
}

/** 下一个码点的起始偏移 (代理对占两个码元) */
export function nextCodePoint(text: string, offset: number): number {
  const code = text.charCodeAt(offset);
  return code >= 0xd800 && code <= 0xdbff && offset + 1 < text.length ? offset + 2 : offset + 1;
}

/** 上一个码点的起始偏移 */
export function previousCodePoint(text: string, offset: number): number {
  const code = text.charCodeAt(offset - 1);
  return code >= 0xdc00 && code <= 0xdfff && offset >= 2 ? offset - 2 : offset - 1;
}

/**
 * 同一次排版的上下文：纯文本、每个码元所属分段与分段的最终样式
 * 宽度测量按分段切开，词内局部换样式时分别测量再相加
 */
class LayoutContext {
  readonly text: string;
  private readonly runOf: Uint32Array;
  private readonly styles: ResolvedRunStyle[];

  constructor(
    private readonly runs: readonly RichTextRun[],
    readonly block: Readonly<NodeTextStyle>,
    private readonly fonts: FontMeasurer
  ) {
    this.text = runs.map((run) => run.text).join('');
    this.runOf = new Uint32Array(this.text.length);
    this.styles = runs.map((run) => resolveRunStyle(block, run));
    let offset = 0;
    for (let i = 0; i < runs.length; i++) {
      this.runOf.fill(i, offset, offset + runs[i].text.length);
      offset += runs[i].text.length;
    }
  }

  /** 偏移处文字的样式；空行取前一个字的样式 (光标高度随上文)，全空时取首个分段或块样式 */
  styleAt(offset: number): ResolvedRunStyle {
    if (this.text.length === 0) return this.styles[0] ?? resolveRunStyle(this.block, {});
    const index = Math.min(Math.max(offset - 1, 0), this.text.length - 1);
    return this.styles[this.runOf[index]];
  }

  /** 段落对齐：段落首字 (空段落取其换行符或前一个字) 所在分段的 textAlign，未设置时取块样式 */
  alignAt(paragraphStart: number): TextAlign | undefined {
    const index = paragraphStart < this.text.length ? paragraphStart : paragraphStart - 1;
    const run = index < 0 ? this.runs[0] : this.runs[this.runOf[index]];
    return run?.textAlign ?? this.block.textAlign;
  }

  /** 按分段切开 [start, end)，逐段回调 */
  forEachPiece(start: number, end: number, visit: (from: number, to: number, style: ResolvedRunStyle) => void): void {
    let from = start;
    while (from < end) {
      const run = this.runOf[from];
      let to = from + 1;
      while (to < end && this.runOf[to] === run) to++;
      visit(from, to, this.styles[run]);
      from = to;
    }
  }

  measure(start: number, end: number): number {
    let width = 0;
    this.forEachPiece(start, end, (from, to, style) => {
      width += this.fonts.measureWidth(this.text.slice(from, to), style.font) + style.letterSpacing * (to - from);
    });
    return width;
  }

  measureText(text: string, style: ResolvedRunStyle): number {
    return this.fonts.measureWidth(text, style.font) + style.letterSpacing * text.length;
  }
}

/** 断行位置：返回 true 表示 prev 与 cur 之间允许折行 */
function canBreakBetween(prev: string, cur: string, breakAll: boolean): boolean {
  if (NO_LINE_START.has(cur) || NO_LINE_END.has(prev)) return false;
  if (isSpace(cur)) return false;
  if (isSpace(prev)) return true;
  if (breakAll) return true;
  return isCjk(prev.codePointAt(0)!) || isCjk(cur.codePointAt(0)!);
}

/** 段落 [start, end) 切分为不可断开的单元，单元末尾可带空白 (空白挂在行尾，不参与折行判断) */
function splitUnits(text: string, start: number, end: number, breakAll: boolean): number[] {
  const bounds = [start];
  let prev = '';
  for (let i = start; i < end;) {
    const next = nextCodePoint(text, i);
    const cur = text.slice(i, next);
    if (i > start && canBreakBetween(prev, cur, breakAll)) bounds.push(i);
    prev = cur;
    i = next;
  }
  bounds.push(end);
  return bounds;
}

function trimTrailingSpaces(text: string, start: number, end: number): number {
  let i = end;
  while (i > start && isSpace(text[i - 1])) i--;
  return i;
}

/** 行的偏移区间：[start, end)，hardBreak 表示以换行符或文本末尾结束 */
interface LineRange {
  start: number;
  end: number;
  hardBreak: boolean;
  /** 所在段落的起点 (段落对齐据此取值) */
  paragraph: number;
}

/** 贪心分行：单元放不下就换行；单元本身比行还宽时逐码点断开 */
function breakLines(ctx: LayoutContext, maxWidth: number | undefined, breakAll: boolean, noWrap: boolean): LineRange[] {
  const { text } = ctx;
  const lines: LineRange[] = [];
  let paragraphStart = 0;
  while (paragraphStart <= text.length) {
    const newline = text.indexOf('\n', paragraphStart);
    const paragraphEnd = newline === -1 ? text.length : newline;
    if (maxWidth === undefined || noWrap || paragraphEnd === paragraphStart) {
      lines.push({ start: paragraphStart, end: paragraphEnd, hardBreak: true, paragraph: paragraphStart });
    } else {
      const bounds = splitUnits(text, paragraphStart, paragraphEnd, breakAll);
      let lineStart = paragraphStart;
      let lineWidth = 0;
      for (let u = 0; u < bounds.length - 1; u++) {
        const unitStart = bounds[u];
        const unitEnd = bounds[u + 1];
        const contentEnd = trimTrailingSpaces(text, unitStart, unitEnd);
        const contentWidth = ctx.measure(unitStart, contentEnd);
        if (lineWidth + contentWidth <= maxWidth + WIDTH_EPSILON) {
          lineWidth += contentWidth + ctx.measure(contentEnd, unitEnd);
          continue;
        }
        if (unitStart > lineStart) {
          lines.push({ start: lineStart, end: unitStart, hardBreak: false, paragraph: paragraphStart });
          lineStart = unitStart;
          lineWidth = 0;
          u--;
          continue;
        }
        // 单元独占一行仍放不下：逐码点断开
        let x = 0;
        for (let i = unitStart; i < contentEnd;) {
          const next = nextCodePoint(text, i);
          const charWidth = ctx.measure(i, next);
          if (x + charWidth > maxWidth + WIDTH_EPSILON && i > lineStart) {
            lines.push({ start: lineStart, end: i, hardBreak: false, paragraph: paragraphStart });
            lineStart = i;
            x = 0;
          }
          x += charWidth;
          i = next;
        }
        lineWidth = x + ctx.measure(contentEnd, unitEnd);
      }
      lines.push({ start: lineStart, end: paragraphEnd, hardBreak: true, paragraph: paragraphStart });
    }
    if (newline === -1) break;
    paragraphStart = newline + 1;
  }
  return lines;
}

/** 行内片段 (x 从 0 起)、行宽与行高 */
function buildLine(ctx: LayoutContext, range: LineRange) {
  const fragments: TextFragment[] = [];
  let x = 0;
  let ascent = 0;
  let descent = 0;
  ctx.forEachPiece(range.start, range.end, (from, to, style) => {
    const text = ctx.text.slice(from, to);
    const width = ctx.measureText(text, style);
    fragments.push({ text, start: from, end: to, x, width, style });
    x += width;
    const a = ascentOf(style);
    ascent = Math.max(ascent, a);
    descent = Math.max(descent, style.lineHeight - a);
  });
  if (fragments.length === 0) {
    const style = ctx.styleAt(range.start);
    ascent = ascentOf(style);
    descent = style.lineHeight - ascent;
  }
  const contentEnd = trimTrailingSpaces(ctx.text, range.start, range.end);
  const width = contentEnd === range.end ? x : x - ctx.measure(contentEnd, range.end);
  return { fragments, width, ascent, height: ascent + descent };
}

/**
 * 两端对齐：把行内剩余空间均分到断行单元之间 (英文落在词间，中文落在字间)
 * 每个单元与分段的交集各自成为片段，片段内照常按原文绘制与测量，光标与点击定位无需特殊处理
 * @returns 单元不足两个 (无处可分) 时返回 null，按左对齐处理
 */
function justifyLine(
  ctx: LayoutContext,
  range: LineRange,
  containerWidth: number,
  breakAll: boolean
): { fragments: TextFragment[]; width: number } | null {
  const contentEnd = trimTrailingSpaces(ctx.text, range.start, range.end);
  const bounds = splitUnits(ctx.text, range.start, contentEnd, breakAll);
  const unitCount = bounds.length - 1;
  if (unitCount < 2) return null;
  const units: TextFragment[][] = [];
  let natural = 0;
  for (let u = 0; u < unitCount; u++) {
    const pieces: TextFragment[] = [];
    ctx.forEachPiece(bounds[u], bounds[u + 1], (from, to, style) => {
      const text = ctx.text.slice(from, to);
      const width = ctx.measureText(text, style);
      pieces.push({ text, start: from, end: to, x: 0, width, style });
      natural += width;
    });
    units.push(pieces);
  }
  const gap = Math.max(0, containerWidth - natural) / (unitCount - 1);
  const fragments: TextFragment[] = [];
  let x = 0;
  for (const pieces of units) {
    for (const piece of pieces) {
      fragments.push({ ...piece, x });
      x += piece.width;
    }
    x += gap;
  }
  return { fragments, width: Math.max(containerWidth, natural) };
}

/** 行末放不下时截断并补省略号 */
function truncateWithEllipsis(
  ctx: LayoutContext,
  range: LineRange,
  maxWidth: number | undefined
): LineRange & { ellipsis: TextFragment } {
  const style = ctx.styleAt(range.end);
  const ellipsisWidth = ctx.measureText(ELLIPSIS, style);
  let end = trimTrailingSpaces(ctx.text, range.start, range.end);
  if (maxWidth !== undefined) {
    while (end > range.start && ctx.measure(range.start, end) + ellipsisWidth > maxWidth + WIDTH_EPSILON) {
      end = previousCodePoint(ctx.text, end);
    }
  }
  return {
    ...range,
    end,
    ellipsis: { text: ELLIPSIS, start: end, end, x: 0, width: ellipsisWidth, style }
  };
}

function alignOffset(align: TextAlign | undefined, containerWidth: number, lineWidth: number): number {
  if (align === 'center') return (containerWidth - lineWidth) / 2;
  if (align === 'right') return containerWidth - lineWidth;
  return 0;
}

/**
 * 排版文本块
 * @param style 块级样式 (内边距由调用方扣除，这里不处理 padding)
 * @param box 排版框 (文本框坐标原点为框左上角)
 */
export function layoutText(
  runs: readonly RichTextRun[],
  style: Readonly<NodeTextStyle>,
  box: TextLayoutBox,
  fonts: FontMeasurer
): TextLayout {
  const ctx = new LayoutContext(runs, style, fonts);
  const noRoom = (box.width !== undefined && box.width <= 0) || (box.height !== undefined && box.height <= 0);

  // 1. [断行与初步测量] 贪心分行并初建每行片段
  const ranges = breakLines(ctx, box.width, style.textWrap === 'break-all', style.textWrap === 'none');
  const built = ranges.map((range) => buildLine(ctx, range));
  const contentWidth = built.reduce((max, line) => Math.max(max, line.width), 0);
  const contentHeight = built.reduce((sum, line) => sum + line.height, 0);

  // 2. [溢出截断] 框高不足时按溢出方式截断：只保留完整可见的行，省略号补在最后一个可见行末
  let visibleCount = ranges.length;
  const overflow = style.textOverflow ?? 'none';
  if (noRoom) {
    visibleCount = 0;
  } else if (box.height !== undefined && overflow !== 'none' && contentHeight > box.height + WIDTH_EPSILON) {
    let bottom = 0;
    visibleCount = 0;
    while (visibleCount < built.length && bottom + built[visibleCount].height <= box.height + WIDTH_EPSILON) {
      bottom += built[visibleCount].height;
      visibleCount++;
    }
  }
  const truncated = visibleCount < ranges.length;
  if (truncated && overflow === 'ellipsis' && visibleCount > 0) {
    const last = visibleCount - 1;
    const cut = truncateWithEllipsis(ctx, ranges[last], box.width);
    const line = buildLine(ctx, cut);
    built[last] = {
      ...line,
      fragments: [...line.fragments, { ...cut.ellipsis, x: line.width }],
      width: line.width + cut.ellipsis.width
    };
    ranges[last] = cut;
  }

  // 3. [对齐与基线换算] 垂直与水平对齐计算，组装最终渲染行数据
  const visibleHeight = built.slice(0, visibleCount).reduce((sum, line) => sum + line.height, 0);
  const containerWidth = box.width ?? contentWidth;
  // 内容高于文本框时从顶部排起：超出部分向下延伸 (编辑时可滚动查看)，不向上越出文本框
  let top =
    box.height === undefined
      ? 0
      : Math.max(
          0,
          style.verticalAlign === 'middle'
            ? (box.height - visibleHeight) / 2
            : style.verticalAlign === 'bottom'
              ? box.height - visibleHeight
              : 0
        );
  const lines: TextLine[] = [];
  const ellipsisLine = truncated && overflow === 'ellipsis' ? visibleCount - 1 : -1;
  for (let i = 0; i < visibleCount; i++) {
    let line = built[i];
    const align = ctx.alignAt(ranges[i].paragraph);
    // 两端对齐只作用于软折行 (段落末行与省略号行照常左对齐)，且需要确定的排版宽度
    if (align === 'justify' && !ranges[i].hardBreak && box.width !== undefined && i !== ellipsisLine) {
      const justified = justifyLine(ctx, ranges[i], box.width, style.textWrap === 'break-all');
      if (justified) line = { ...line, ...justified };
    }
    const left = alignOffset(align, containerWidth, line.width);
    lines.push({
      start: ranges[i].start,
      end: ranges[i].end,
      top,
      height: line.height,
      baseline: top + line.ascent,
      left,
      width: line.width,
      fragments: line.fragments.map((fragment) => ({ ...fragment, x: fragment.x + left })),
      hardBreak: ranges[i].hardBreak
    });
    top += line.height;
  }
  return { text: ctx.text, lines, width: contentWidth, height: contentHeight, truncated };
}

// ================= 光标与选区几何 =================

/** 行内某偏移处的 x (偏移需落在该行内) */
export function offsetToX(line: TextLine, offset: number, fonts: FontMeasurer): number {
  for (const fragment of line.fragments) {
    if (offset > fragment.end) continue;
    if (offset <= fragment.start) return fragment.x;
    const prefix = fragment.text.slice(0, offset - fragment.start);
    return fragment.x + fonts.measureWidth(prefix, fragment.style.font) + fragment.style.letterSpacing * prefix.length;
  }
  const last = line.fragments[line.fragments.length - 1];
  return last ? last.x + last.width : line.left;
}

/** 偏移所在的行：软折行处按归属取上一行末尾或下一行开头 */
export function lineIndexOfOffset(layout: TextLayout, offset: number, affinity: CaretAffinity = 'forward'): number {
  const { lines } = layout;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (offset < line.end) return offset >= line.start ? i : Math.max(0, i - 1);
    if (offset === line.end && (line.hardBreak || affinity === 'backward' || i === lines.length - 1)) return i;
  }
  return Math.max(0, lines.length - 1);
}

/** 光标竖线的位置与高度 */
export function caretRect(
  layout: TextLayout,
  offset: number,
  affinity: CaretAffinity,
  fonts: FontMeasurer
): CaretRect | null {
  const lineIndex = lineIndexOfOffset(layout, offset, affinity);
  const line = layout.lines[lineIndex];
  if (!line) return null;
  return { x: offsetToX(line, offset, fonts), top: line.top, height: line.height, lineIndex };
}

/** 行内距 x 最近的字符边界 */
export function offsetAtX(layout: TextLayout, lineIndex: number, x: number, fonts: FontMeasurer): TextHit {
  const line = layout.lines[lineIndex];
  const softEnd: CaretAffinity = line.hardBreak ? 'forward' : 'backward';
  if (line.fragments.length === 0 || x <= line.fragments[0].x) return { offset: line.start, affinity: 'forward' };
  for (const fragment of line.fragments) {
    if (x > fragment.x + fragment.width) continue;
    // 片段内按码点逐个累加，取离 x 最近的边界
    let left = fragment.x;
    for (let i = 0; i < fragment.text.length;) {
      const next = nextCodePoint(fragment.text, i);
      const right =
        left +
        fonts.measureWidth(fragment.text.slice(i, next), fragment.style.font) +
        fragment.style.letterSpacing * (next - i);
      if (x < (left + right) / 2) return { offset: fragment.start + i, affinity: 'forward' };
      left = right;
      i = next;
    }
    const offset = Math.min(fragment.end, line.end);
    return { offset, affinity: offset === line.end ? softEnd : 'forward' };
  }
  return { offset: line.end, affinity: softEnd };
}

/** 文本框坐标中的点 → 最近的字符边界 */
export function hitTestText(layout: TextLayout, point: { x: number; y: number }, fonts: FontMeasurer): TextHit {
  const { lines } = layout;
  if (lines.length === 0) return { offset: 0, affinity: 'forward' };
  let lineIndex = lines.length - 1;
  for (let i = 0; i < lines.length; i++) {
    if (point.y < lines[i].top + lines[i].height) {
      lineIndex = i;
      break;
    }
  }
  return offsetAtX(layout, lineIndex, point.x, fonts);
}

/** 选区 [start, end) 在每一行上的矩形；跨过换行符时行末补一小段，表示换行也被选中 */
export function selectionRects(layout: TextLayout, start: number, end: number, fonts: FontMeasurer): TextRect[] {
  const rects: TextRect[] = [];
  if (start >= end) return rects;
  for (const line of layout.lines) {
    if (line.end < start || line.start > end) continue;
    const from = Math.max(start, line.start);
    const to = Math.min(end, line.end);
    const coversBreak = line.hardBreak && end > line.end;
    if (from >= to && !coversBreak) continue;
    const x1 = offsetToX(line, from, fonts);
    const x2 = offsetToX(line, to, fonts) + (coversBreak ? line.height * 0.25 : 0);
    rects.push({ x: x1, y: line.top, width: x2 - x1, height: line.height });
  }
  return rects;
}
