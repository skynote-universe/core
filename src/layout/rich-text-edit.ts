/**
 * @file rich-text-edit.ts
 * @description 富文本分段的编辑纯函数：替换文字、设置样式、选区样式汇总，以及词与段落边界 (ADR-122)
 *
 * 设计考量 (Why):
 * 1. 纯函数：输入分段与偏移，返回新的分段数组，不修改入参；编辑器把结果整体提交为一次补丁，撤销重做由事务负责。
 * 2. 始终规整：相邻同样式分段合并、空分段剔除，但全空时保留一个空分段承载样式 (删光文字后继续输入仍沿用原样式)。
 * 3. 剪贴板中的分段来自外部，按白名单逐键校验后才使用 (防原型链污染与脏数据)。
 * 4. 偏移与排版一致按 UTF-16 码元计；词边界优先用运行时的 Intl.Segmenter (中文按词)，不可用时按字符类别退化。
 */

import type { RectBounds } from '../types/geometry';
import type { TextDecoration, TextDecorationLine } from '../types/style';
import type { NodeTextStyle, RichTextRun, RichTextRunStyle } from '../types/text';
import type { TextPrimitive } from '../protocols/primitives.protocol';
import type { TextComposition, TextEditingTarget } from '../state/session-store';
import { nextCodePoint, previousCodePoint, type TextLayout } from './rich-text-layout';

/** 样式补丁：值为 undefined 的键表示移除该样式 (回到块样式) */
export type RichTextStylePatch = { [K in keyof RichTextRunStyle]?: RichTextRunStyle[K] | undefined };

export interface TextRange {
  readonly start: number;
  readonly end: number;
}

function styleOf(run: Readonly<RichTextRun>): RichTextRunStyle {
  const { text: _text, ...style } = run;
  return style;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => v === b[i]);
  return a === b;
}

function sameStyle(a: RichTextRunStyle, b: RichTextRunStyle): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof RichTextRunStyle>;
  for (const key of keys) if (!sameValue(a[key], b[key])) return false;
  return true;
}

export function getRunsText(runs: readonly RichTextRun[]): string {
  return runs.map((run) => run.text).join('');
}

/** 合并相邻同样式分段、剔除空分段；全空时保留首个分段的样式 */
export function normalizeRuns(runs: readonly RichTextRun[]): RichTextRun[] {
  const result: RichTextRun[] = [];
  for (const run of runs) {
    if (run.text === '') continue;
    const last = result[result.length - 1];
    if (last && sameStyle(styleOf(last), styleOf(run))) {
      result[result.length - 1] = { ...last, text: last.text + run.text };
    } else {
      result.push({ ...run });
    }
  }
  return result.length > 0 ? result : [{ ...(runs[0] ? styleOf(runs[0]) : {}), text: '' }];
}

/** 截取 [start, end) 的分段 (保留样式) */
export function sliceRuns(runs: readonly RichTextRun[], start: number, end: number): RichTextRun[] {
  const result: RichTextRun[] = [];
  let offset = 0;
  for (const run of runs) {
    const runEnd = offset + run.text.length;
    const from = Math.max(start, offset);
    const to = Math.min(end, runEnd);
    if (from < to) result.push({ ...run, text: run.text.slice(from - offset, to - offset) });
    offset = runEnd;
    if (offset >= end) break;
  }
  return result;
}

/**
 * 偏移处新输入文字应沿用的样式：取前一个字的样式 (与常见编辑器一致)，位于开头时取第一个字
 */
export function runStyleAt(runs: readonly RichTextRun[], offset: number): RichTextRunStyle {
  const index = Math.max(offset - 1, 0);
  let position = 0;
  for (const run of runs) {
    position += run.text.length;
    if (index < position) return styleOf(run);
  }
  return runs.length > 0 ? styleOf(runs[runs.length - 1]) : {};
}

/** 用 text 替换 [start, end)；style 缺省时沿用 start 处的样式 */
export function replaceText(
  runs: readonly RichTextRun[],
  start: number,
  end: number,
  text: string,
  style: RichTextRunStyle = runStyleAt(runs, start)
): RichTextRun[] {
  const length = getRunsText(runs).length;
  return normalizeRuns([...sliceRuns(runs, 0, start), { ...style, text }, ...sliceRuns(runs, end, length)]);
}

/** 用一组分段替换 [start, end) (粘贴富文本) */
export function replaceRuns(
  runs: readonly RichTextRun[],
  start: number,
  end: number,
  inserted: readonly RichTextRun[]
): RichTextRun[] {
  const length = getRunsText(runs).length;
  return normalizeRuns([...sliceRuns(runs, 0, start), ...inserted, ...sliceRuns(runs, end, length)]);
}

/** 清除格式：移除全部行内字符样式 (段落对齐与链接保留) */
export const CLEAR_FORMAT_PATCH: RichTextStylePatch = Object.freeze({
  color: undefined,
  backgroundColor: undefined,
  fontSize: undefined,
  fontWeight: undefined,
  fontStyle: undefined,
  fontFamily: undefined,
  lineHeight: undefined,
  letterSpacing: undefined,
  textDecoration: undefined,
  code: undefined
});

/** 对 [start, end) 应用样式补丁 */
export function applyRunStyle(
  runs: readonly RichTextRun[],
  start: number,
  end: number,
  patch: RichTextStylePatch
): RichTextRun[] {
  const length = getRunsText(runs).length;
  // 空文本没有可截取的字：样式写在承载样式的空分段上，之后输入的文字沿用
  if (length === 0) return [mergeStyle(runs[0] ?? { text: '' }, patch)];
  const styled = sliceRuns(runs, start, end).map((run) => mergeStyle(run, patch));
  return normalizeRuns([...sliceRuns(runs, 0, start), ...styled, ...sliceRuns(runs, end, length)]);
}

/** 合并样式补丁：值为 undefined 的键移除 */
export function mergeStyle<T extends RichTextRunStyle>(style: T, patch: RichTextStylePatch): T {
  const result = { ...style } as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete result[key];
    else result[key] = value;
  }
  return result as T;
}

/** 选区内所有文字共有的样式 (某键取值不一致时不出现在结果中)；空选区取光标处样式 */
export function selectionRunStyle(runs: readonly RichTextRun[], start: number, end: number): RichTextRunStyle {
  if (start >= end) return runStyleAt(runs, start);
  const pieces = sliceRuns(runs, start, end).map(styleOf);
  const [first, ...rest] = pieces;
  const common: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(first)) {
    if (rest.every((style) => sameValue(style[key as keyof RichTextRunStyle], value))) common[key] = value;
  }
  // 某些分段缺省的键不算共有 (缺省即沿用块样式，与显式值不同)
  return common as RichTextRunStyle;
}

/** 装饰线开关：保留另一种装饰线 (下划线与删除线互不影响) */
export function toggleDecorationLine(
  decoration: TextDecoration | undefined,
  line: TextDecorationLine,
  on: boolean
): TextDecoration {
  const lines =
    decoration === undefined || decoration === 'none' ? [] : Array.isArray(decoration) ? decoration : [decoration];
  const next = on ? [...new Set([...lines, line])] : lines.filter((l) => l !== line);
  if (next.length === 0) return 'none';
  return next.length === 1 ? next[0] : next;
}

export function hasDecorationLine(decoration: TextDecoration | undefined, line: TextDecorationLine): boolean {
  if (decoration === undefined || decoration === 'none') return false;
  return Array.isArray(decoration) ? decoration.includes(line) : decoration === line;
}

// ================= 剪贴板 =================

type StyleChecker = (value: unknown) => boolean;
const isString: StyleChecker = (v) => typeof v === 'string';
const isNumber: StyleChecker = (v) => typeof v === 'number' && Number.isFinite(v);
const DECORATIONS = new Set(['none', 'underline', 'line-through']);
/** 允许从剪贴板带入的分段样式键及其取值校验 */
const RUN_STYLE_CHECKERS: Readonly<Record<keyof RichTextRunStyle, StyleChecker>> = {
  color: isString,
  backgroundColor: (v) => v === null || isString(v),
  fontSize: (v) => isNumber(v) && (v as number) > 0,
  fontWeight: (v) => isString(v) || isNumber(v),
  fontStyle: (v) => v === 'normal' || v === 'italic' || v === 'oblique',
  fontFamily: isString,
  lineHeight: (v) => isNumber(v) || (isString(v) && /^\d+(\.\d+)?px$/.test(v as string)),
  letterSpacing: isNumber,
  textDecoration: (v) =>
    (isString(v) && DECORATIONS.has(v as string)) ||
    (Array.isArray(v) && v.every((line) => line === 'underline' || line === 'line-through')),
  textAlign: (v) => v === 'left' || v === 'center' || v === 'right' || v === 'justify',
  link: isString,
  code: (v) => typeof v === 'boolean'
};

/**
 * 校验外部来源的富文本分段 (文档导入、剪贴板)：结构不符返回 null；只保留白名单内且取值合法的样式键
 * 不合并相邻分段，载入的文档保持原样
 */
export function sanitizeRichTextRuns(value: unknown): RichTextRun[] | null {
  if (!Array.isArray(value)) return null;
  const runs: RichTextRun[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null || typeof (item as { text?: unknown }).text !== 'string') return null;
    const run: Record<string, unknown> = { text: (item as { text: string }).text };
    for (const [key, check] of Object.entries(RUN_STYLE_CHECKERS)) {
      const style = (item as Record<string, unknown>)[key];
      if (Object.hasOwn(item, key) && check(style)) run[key] = style;
    }
    runs.push(run as unknown as RichTextRun);
  }
  return runs;
}

/** 解析剪贴板中的富文本分段 (JSON)：校验后合并相邻同样式分段 */
export function parseRichTextRuns(json: string): RichTextRun[] | null {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return null;
  }
  const runs = sanitizeRichTextRuns(data);
  return runs && normalizeRuns(runs);
}

// ================= 编辑视图 =================

/** 把输入法组合中的文字 (带下划线) 插入分段：只用于本地显示与测量，不写入文档 */
export function withComposition(
  runs: readonly RichTextRun[],
  composition: TextComposition | null,
  style: NodeTextStyle
): readonly RichTextRun[] {
  if (!composition) return runs;
  return replaceText(runs, composition.offset, composition.offset, composition.text, {
    ...composition.style,
    textDecoration: toggleDecorationLine(composition.style.textDecoration ?? style.textDecoration, 'underline', true)
  });
}

/**
 * 编辑中文字是否在文本框内滚动：固定高度且会折行的文字超出时滚动查看；
 * 不折行的单行文字 (如画框标题) 编辑时向右延展完整可见，不滚动也不裁剪
 */
function scrollsWhileEditing(primitive: TextPrimitive): boolean {
  return primitive.height !== undefined && primitive.style.textWrap !== 'none';
}

/**
 * 编辑中文字块的视图 (渲染器与编辑插件共用，二者看到的排版完全一致)：
 * 插入输入法组合文字、不截断；会折行的文字超出文本框时裁剪并滚动，不折行的文字向外延展
 */
export function editingTextPrimitive(primitive: TextPrimitive, editing: TextEditingTarget): TextPrimitive {
  return {
    ...primitive,
    runs: withComposition(primitive.runs, editing.composition, primitive.style),
    style: { ...primitive.style, textOverflow: 'none' },
    scrollY: scrollsWhileEditing(primitive) ? editing.scrollY : undefined
  };
}

/**
 * 编辑中文字块在节点局部坐标中的可见范围 (点击是否仍在编辑区、工具栏定位)：
 * 滚动的文字即文本框；延展的文字取文本框与排版结果的较大者；未限定的边取排版结果
 * @param layout 编辑视图 (editingTextPrimitive) 的排版
 */
export function editingTextBounds(primitive: TextPrimitive, layout: TextLayout): RectBounds {
  const scrolls = scrollsWhileEditing(primitive);
  const width = scrolls ? (primitive.width ?? layout.width) : Math.max(primitive.width ?? 0, layout.width);
  const height = scrolls ? primitive.height! : Math.max(primitive.height ?? 0, layout.height);
  return { left: primitive.x, top: primitive.y, right: primitive.x + width, bottom: primitive.y + height };
}

// ================= 边界 =================

type CharClass = 'space' | 'word' | 'cjk' | 'punct' | 'newline';

function classify(ch: string): CharClass {
  if (ch === '\n') return 'newline';
  if (/\s/.test(ch)) return 'space';
  if (/[\p{L}\p{N}_]/u.test(ch))
    return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(ch) ? 'cjk' : 'word';
  return 'punct';
}

interface WordSegment {
  readonly segment: string;
  readonly index: number;
  readonly isWordLike?: boolean;
}
/** 词切分：优先 Intl.Segmenter (中文按词)；较旧的运行环境没有它，按字符类别切分 (中日韩逐字) */
function segmentWords(text: string): WordSegment[] {
  if ('Segmenter' in Intl) return [...new Intl.Segmenter(undefined, { granularity: 'word' }).segment(text)];
  const segments: WordSegment[] = [];
  let i = 0;
  while (i < text.length) {
    const start = i;
    const cls = classify(text.slice(i, nextCodePoint(text, i)));
    i = nextCodePoint(text, i);
    if (cls === 'word' || cls === 'space') {
      while (i < text.length && classify(text.slice(i, nextCodePoint(text, i))) === cls) i = nextCodePoint(text, i);
    }
    segments.push({ segment: text.slice(start, i), index: start, isWordLike: cls === 'word' || cls === 'cjk' });
  }
  return segments;
}

/** 双击选词：偏移所在的词 (落在空白上时选中这段空白) */
export function wordRangeAt(text: string, offset: number): TextRange {
  if (text.length === 0) return { start: 0, end: 0 };
  const segments = segmentWords(text);
  const at = Math.min(offset, text.length - 1);
  for (const { segment, index } of segments) {
    if (at >= index && at < index + segment.length) return { start: index, end: index + segment.length };
  }
  return { start: offset, end: offset };
}

/**
 * 选区覆盖的段落区间：从首段开头到末段的换行符 (含)；设置段落对齐时作用于此区间
 * 末段没有换行符时止于文本末尾
 */
export function paragraphsRange(text: string, start: number, end: number): TextRange {
  const first = paragraphRangeAt(text, start);
  const last = paragraphRangeAt(text, end);
  return { start: first.start, end: Math.min(last.end + 1, text.length) };
}

/** 三击选段落：偏移所在段落 (不含换行符) */
export function paragraphRangeAt(text: string, offset: number): TextRange {
  const start = text.lastIndexOf('\n', offset - 1) + 1;
  const newline = text.indexOf('\n', offset);
  return { start, end: newline === -1 ? text.length : newline };
}

/** Ctrl + 左方向 / Ctrl + 退格：跳过空白后移到上一个词的开头 */
export function previousWordBoundary(text: string, offset: number): number {
  let result = 0;
  for (const { segment, index, isWordLike } of segmentWords(text)) {
    if (index >= offset) break;
    if (isWordLike || classify(segment[0]) === 'punct') result = index;
  }
  return result;
}

/** Ctrl + 右方向 / Ctrl + Delete：移到下一个词的结尾 */
export function nextWordBoundary(text: string, offset: number): number {
  for (const { segment, index, isWordLike } of segmentWords(text)) {
    const end = index + segment.length;
    if (end > offset && (isWordLike || classify(segment[0]) === 'punct')) return end;
  }
  return text.length;
}

/** 按码点左右移动一格 */
export function stepOffset(text: string, offset: number, direction: -1 | 1): number {
  if (direction < 0) return offset <= 0 ? 0 : previousCodePoint(text, offset);
  return offset >= text.length ? text.length : nextCodePoint(text, offset);
}
