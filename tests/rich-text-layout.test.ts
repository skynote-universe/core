/**
 * @file rich-text-layout.test.ts
 * @description 富文本排版：分行 (词、中日韩、禁则、超长词)、对齐、截断省略、基线，以及光标、点击定位与选区几何
 */

import { describe, it, expect } from 'vitest';
import {
  caretRect,
  hitTestText,
  layoutText,
  offsetAtX,
  selectionRects,
  type TextLayout
} from '../src/layout/rich-text-layout';
import type { FontMeasurer } from '../src/protocols/font-measurer.protocol';
import type { RichTextRun } from '../src/types/text';

/** 每个码点宽 = 字号 × 0.5 (加粗再加 1)，便于手算 */
const fonts: FontMeasurer = {
  measureWidth: (text, font) => [...text].length * (font.size * 0.5 + (font.weight === 'bold' ? 1 : 0))
};

/** 字号 20：每个码点宽 10，行高 30 */
const STYLE = { fontSize: 20 };

function lineTexts(layout: TextLayout): string[] {
  return layout.lines.map((line) => layout.text.slice(line.start, line.end));
}

function layout(text: string | RichTextRun[], width?: number, extra: object = {}, height?: number): TextLayout {
  const runs = typeof text === 'string' ? [{ text }] : text;
  return layoutText(runs, { ...STYLE, ...extra }, { width, height }, fonts);
}

describe('分行', () => {
  it('拉丁文按词折行，行尾空白不计入行宽；宽度缺省时不折行', () => {
    const result = layout('hello world foo', 100);
    expect(lineTexts(result)).toEqual(['hello ', 'world foo']);
    expect(result.lines[0].width).toBe(50);
    expect(result.width).toBe(90);
    expect(lineTexts(layout('hello world foo'))).toEqual(['hello world foo']);
  });

  it('中日韩逐字折行，句号等标点不出现在行首、左括号不出现在行尾', () => {
    expect(lineTexts(layout('你好世界', 30))).toEqual(['你好世', '界']);
    // 「。」不能在行首：随前一个字一起换行
    expect(lineTexts(layout('你好世。', 30))).toEqual(['你好', '世。']);
    // 「（」不能在行尾：与后一个字一起换行
    expect(lineTexts(layout('你好（世', 30))).toEqual(['你好', '（世']);
  });

  it('词内局部换样式不会被拆开；超长的词逐字断开', () => {
    const runs = [{ text: 'ab' }, { text: 'cd', fontWeight: 'bold' as const }, { text: ' ef' }];
    // abcd 宽 10+10+11+11 = 42，接在 x 后放不下 45 时整词换行，不在样式交界处拆开
    expect(lineTexts(layout([{ text: 'x ' }, ...runs], 45))).toEqual(['x ', 'abcd ', 'ef']);
    expect(lineTexts(layout('abcdefgh', 30))).toEqual(['abc', 'def', 'gh']);
  });

  it('换行符开始新段落，空段落保留一行；空文本也有一行 (光标可放)', () => {
    const result = layout('a\n\nb', 100);
    expect(lineTexts(result)).toEqual(['a', '', 'b']);
    expect(result.lines.map((line) => line.hardBreak)).toEqual([true, true, true]);
    expect(result.height).toBe(90);
    expect(layout('').lines).toHaveLength(1);
  });

  it('代理对 (如表情) 不会被拆开', () => {
    expect(lineTexts(layout('😀😀😀', 20))).toEqual(['😀😀', '😀']);
  });
});

describe('对齐、截断与基线', () => {
  it('水平对齐按框宽，垂直对齐按框高', () => {
    const centered = layout('ab', 100, { textAlign: 'center', verticalAlign: 'middle' }, 100);
    expect(centered.lines[0]).toMatchObject({ left: 40, top: 35 });
    expect(centered.lines[0].fragments[0].x).toBe(40);
    expect(layout('ab', 100, { textAlign: 'right' }).lines[0].left).toBe(80);
  });

  it('框高不足时只保留完整可见的行，省略号补在最后一行末；内容尺寸不受截断影响', () => {
    const result = layout('abcdefghij', 40, { textOverflow: 'ellipsis' }, 65);
    expect(result.truncated).toBe(true);
    expect(result.lines).toHaveLength(2);
    // 第二行 efgh 放不下省略号 (40)：截到 efg + …
    const last = result.lines[1];
    expect(result.text.slice(last.start, last.end)).toBe('efg');
    expect(last.fragments.at(-1)).toMatchObject({ text: '…', x: 30 });
    expect(result.height).toBe(90);

    expect(layout('abcdefghij', 40, { textOverflow: 'none' }, 65).lines).toHaveLength(3);
    expect(layout('abc', 0).lines).toHaveLength(0);
  });

  it('单行不换行文本 (textWrap: none) 超出框宽时，末尾正确截断并补省略号', () => {
    // 文本宽度 10 字 × 10 = 100px，框宽 50px
    const result = layout('abcdefghij', 50, { textWrap: 'none', textOverflow: 'ellipsis' });
    expect(result.lines).toHaveLength(1);
    expect(result.truncated).toBe(true);
    const line = result.lines[0];
    expect(line.fragments.at(-1)?.text).toBe('…');
    expect(line.width).toBeLessThanOrEqual(50);
  });

  it('行高：数字为字号倍数，px 字符串为像素，两种写法等价时排版一致', () => {
    expect(layout('ab', 100, { lineHeight: 2 }).height).toBe(40);
    expect(layout('ab', 100, { lineHeight: '40px' }).height).toBe(40);
  });

  it('同一行不同字号按基线对齐，行高取所需最大值', () => {
    const result = layout([{ text: 'a' }, { text: 'B', fontSize: 40 }], 200);
    const [line] = result.lines;
    // 字号 40：行高 60，基线以上 (60 + 28) / 2 = 44；字号 20 的片段基线以上 (30 + 14) / 2 = 22
    expect(line.baseline).toBe(44);
    expect(line.height).toBe(44 + Math.max(60 - 44, 30 - 22));
  });
});

describe('光标与选区', () => {
  it('光标 x 取前缀宽度；软折行处按归属落在上一行末或下一行首', () => {
    const result = layout('hello world', 60);
    expect(caretRect(result, 2, 'forward', fonts)).toMatchObject({ x: 20, top: 0, lineIndex: 0 });
    // 偏移 6 是软折行处
    expect(caretRect(result, 6, 'forward', fonts)).toMatchObject({ x: 0, top: 30, lineIndex: 1 });
    expect(caretRect(result, 6, 'backward', fonts)).toMatchObject({ x: 60, lineIndex: 0 });
  });

  it('点击定位到最近的字符边界；行外点击吸附到行首行尾', () => {
    const result = layout('hello world', 60);
    expect(hitTestText(result, { x: 14, y: 5 }, fonts)).toEqual({ offset: 1, affinity: 'forward' });
    expect(hitTestText(result, { x: 16, y: 5 }, fonts)).toEqual({ offset: 2, affinity: 'forward' });
    expect(hitTestText(result, { x: 999, y: 5 }, fonts)).toEqual({ offset: 6, affinity: 'backward' });
    expect(hitTestText(result, { x: 999, y: 999 }, fonts)).toEqual({ offset: 11, affinity: 'forward' });
    expect(offsetAtX(result, 1, -5, fonts).offset).toBe(6);
  });

  it('选区按行给出矩形，跨过换行符时行末补一小段', () => {
    const result = layout('ab\ncd', 100);
    expect(selectionRects(result, 1, 4, fonts)).toEqual([
      { x: 10, y: 0, width: 10 + 30 * 0.25, height: 30 },
      { x: 0, y: 30, width: 10, height: 30 }
    ]);
    expect(selectionRects(result, 2, 2, fonts)).toEqual([]);
  });
});
