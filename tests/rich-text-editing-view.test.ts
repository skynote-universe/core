/**
 * @file rich-text-editing-view.test.ts
 * @description 段落对齐、超高内容的排版起点、编辑视图 (组合文字与滚动) 与剪贴板分段校验
 */

import { describe, it, expect } from 'vitest';
import { caretRect, hitTestText, layoutText } from '../src/layout/rich-text-layout';
import { applyRunStyle, editingTextPrimitive, paragraphsRange, parseRichTextRuns } from '../src/layout/rich-text-edit';
import type { FontMeasurer } from '../src/protocols/font-measurer.protocol';
import type { TextPrimitive } from '../src/protocols/primitives.protocol';

/** 每个码点宽 = 字号 × 0.5；字号 20 时每字宽 10、行高 30 */
const fonts: FontMeasurer = { measureWidth: (text, font) => [...text].length * font.size * 0.5 };
const NL = '\n';

describe('段落对齐', () => {
  it('每段取段首所在分段的 textAlign，未设置时取块样式', () => {
    const layout = layoutText(
      [{ text: `ab${NL}`, textAlign: 'right' }, { text: 'cd' }],
      { fontSize: 20, textAlign: 'center' },
      { width: 100 },
      fonts
    );
    expect(layout.lines.map((line) => line.left)).toEqual([80, 40]);
  });

  it('两端对齐：软折行把剩余空间均分到词间 (中文为字间)，段落末行左对齐；光标与点击沿用片段坐标', () => {
    // 宽 70：「aa bb cc」折成「aa bb 」「cc」，首行 aa、bb 两个单元共宽 40，剩余 30 放在词间
    const layout = layoutText([{ text: 'aa bb cc' }], { fontSize: 20, textAlign: 'justify' }, { width: 70 }, fonts);
    const [first, last] = layout.lines;
    expect(first.fragments.map((f) => [f.text, f.x])).toEqual([
      ['aa ', 0],
      ['bb', 50]
    ]);
    expect(first.width).toBe(70);
    expect(last.left).toBe(0);
    expect(caretRect(layout, 4, 'forward', fonts)!.x).toBe(60);
    // 点在词间空隙：落到后一个单元开头
    expect(hitTestText(layout, { x: 45, y: 5 }, fonts).offset).toBe(3);

    // 宽 45：首行「一二三四」共宽 40，剩余 5 均分到 3 个字间
    const cjk = layoutText([{ text: '一二三四五' }], { fontSize: 20, textAlign: 'justify' }, { width: 45 }, fonts);
    cjk.lines[0].fragments.forEach((f, i) => expect(f.x).toBeCloseTo(i * (10 + 5 / 3)));
  });

  it('选区覆盖的段落区间含末段换行符，末段没有换行符时止于文本末尾', () => {
    const text = `ab${NL}cd${NL}ef`;
    expect(paragraphsRange(text, 1, 1)).toEqual({ start: 0, end: 3 });
    expect(paragraphsRange(text, 1, 4)).toEqual({ start: 0, end: 6 });
    expect(paragraphsRange(text, 7, 7)).toEqual({ start: 6, end: 8 });
  });
});

describe('超高内容', () => {
  it('内容高于文本框时从顶部排起，不因垂直居中越出文本框上沿', () => {
    const layout = layoutText(
      [{ text: `a${NL}b${NL}c` }],
      { fontSize: 20, verticalAlign: 'middle' },
      { width: 100, height: 50 },
      fonts
    );
    expect(layout.lines[0].top).toBe(0);
    expect(
      layoutText([{ text: 'a' }], { fontSize: 20, verticalAlign: 'middle' }, { height: 50 }, fonts).lines[0].top
    ).toBe(10);
  });
});

describe('编辑视图', () => {
  const primitive: TextPrimitive = {
    kind: 'text',
    id: 'body',
    x: 0,
    y: 0,
    width: 100,
    height: 50,
    runs: [{ text: 'abc' }],
    style: { fontSize: 20, textOverflow: 'ellipsis' }
  };

  it('插入带下划线的组合文字、取消截断、带上滚动；无文本框高度时不滚动', () => {
    const view = editingTextPrimitive(primitive, {
      nodeId: 'n',
      blockId: 'body',
      scrollY: 12,
      composition: { offset: 1, text: 'ni', style: { color: '$red' } }
    });
    expect(view.runs).toEqual([
      { text: 'a' },
      { text: 'ni', color: '$red', textDecoration: 'underline' },
      { text: 'bc' }
    ]);
    expect(view.style.textOverflow).toBe('none');
    expect(view.scrollY).toBe(12);
    const autoHeight = editingTextPrimitive(
      { ...primitive, height: undefined },
      { nodeId: 'n', blockId: 'body', scrollY: 12, composition: null }
    );
    expect(autoHeight.scrollY).toBeUndefined();
    expect(autoHeight.runs).toBe(primitive.runs);

    const singleLine = editingTextPrimitive(
      { ...primitive, style: { ...primitive.style, textWrap: 'none' } },
      { nodeId: 'n', blockId: 'body', scrollY: 12, composition: null }
    );
    expect(singleLine.scrollY).toBeUndefined();
    expect(singleLine.style.textOverflow).toBe('none');

    const explicitVisible = editingTextPrimitive(
      { ...primitive, style: { ...primitive.style, editingOverflow: 'visible' } },
      { nodeId: 'n', blockId: 'body', scrollY: 12, composition: null }
    );
    expect(explicitVisible.scrollY).toBeUndefined();
    expect(explicitVisible.style.overflow).toBe('visible');

    const explicitScroll = editingTextPrimitive(
      { ...primitive, style: { ...primitive.style, textWrap: 'none', editingOverflow: 'scroll' } },
      { nodeId: 'n', blockId: 'body', scrollY: 12, composition: null }
    );
    expect(explicitScroll.scrollY).toBe(12);
    expect(explicitScroll.style.overflow).toBe('scroll');
  });

  it('空文本设置样式写在承载样式的空分段上', () => {
    expect(applyRunStyle([{ text: '' }], 0, 0, { textAlign: 'center' })).toEqual([{ text: '', textAlign: 'center' }]);
  });
});

describe('剪贴板分段', () => {
  it('只保留白名单内且取值合法的样式键；结构不符返回 null', () => {
    expect(
      parseRichTextRuns(
        '[{"text":"a","fontWeight":"bold","fontSize":-1,"onclick":"x"},{"text":"b","fontWeight":"bold"}]'
      )
    ).toEqual([{ text: 'ab', fontWeight: 'bold' }]);
    expect(parseRichTextRuns('{"text":"a"}')).toBeNull();
    expect(parseRichTextRuns('[{"style":"a"}]')).toBeNull();
    expect(parseRichTextRuns('oops')).toBeNull();
  });
});
