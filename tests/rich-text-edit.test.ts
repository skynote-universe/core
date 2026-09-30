/**
 * @file rich-text-edit.test.ts
 * @description 富文本分段编辑纯函数与连击判定
 */

import { describe, it, expect } from 'vitest';
import {
  applyRunStyle,
  normalizeRuns,
  paragraphRangeAt,
  previousWordBoundary,
  nextWordBoundary,
  replaceText,
  runStyleAt,
  selectionRunStyle,
  stepOffset,
  toggleDecorationLine,
  wordRangeAt
} from '../src/layout/rich-text-edit';
import { ClickCounter } from '../src/input/click-counter';
import type { RichTextRun } from '../src/types/text';

const RUNS: RichTextRun[] = [{ text: 'ab' }, { text: 'cd', fontWeight: 'bold' }, { text: 'ef' }];

describe('分段编辑', () => {
  it('替换文字沿用前一个字的样式，结果规整 (同样式合并、空分段剔除)，不修改入参', () => {
    const snapshot = JSON.stringify(RUNS);
    expect(replaceText(RUNS, 3, 3, 'X')).toEqual([{ text: 'ab' }, { text: 'cXd', fontWeight: 'bold' }, { text: 'ef' }]);
    expect(replaceText(RUNS, 1, 5, '')).toEqual([{ text: 'af' }]);
    expect(replaceText(RUNS, 0, 0, 'Z', { color: '$red' })[0]).toEqual({ text: 'Z', color: '$red' });
    expect(JSON.stringify(RUNS)).toBe(snapshot);
  });

  it('删光文字后保留一个空分段承载样式，继续输入沿用原样式', () => {
    const empty = replaceText([{ text: 'x', color: '$red' }], 0, 1, '');
    expect(empty).toEqual([{ text: '', color: '$red' }]);
    expect(replaceText(empty, 0, 0, 'y')).toEqual([{ text: 'y', color: '$red' }]);
    expect(normalizeRuns([])).toEqual([{ text: '' }]);
  });

  it('样式补丁作用于区间，值为 undefined 时移除该键；选区共有样式只含全部一致的键', () => {
    expect(applyRunStyle(RUNS, 1, 5, { fontWeight: undefined, color: '$red' })).toEqual([
      { text: 'a' },
      { text: 'bcde', color: '$red' },
      { text: 'f' }
    ]);
    expect(selectionRunStyle(RUNS, 2, 4)).toEqual({ fontWeight: 'bold' });
    expect(selectionRunStyle(RUNS, 1, 4)).toEqual({});
    expect(selectionRunStyle(RUNS, 3, 3)).toEqual({ fontWeight: 'bold' });
    expect(runStyleAt(RUNS, 0)).toEqual({});
  });

  it('下划线与删除线开关互不影响，全部关闭为 none', () => {
    expect(toggleDecorationLine('underline', 'line-through', true)).toEqual(['underline', 'line-through']);
    expect(toggleDecorationLine(['underline', 'line-through'], 'underline', false)).toBe('line-through');
    expect(toggleDecorationLine('underline', 'underline', false)).toBe('none');
  });
});

describe('边界', () => {
  it('选词、选段落、按词跳转与按码点步进 (代理对不拆开)', () => {
    const text = 'hello world\nsecond line';
    expect(wordRangeAt(text, 7)).toEqual({ start: 6, end: 11 });
    expect(paragraphRangeAt(text, 14)).toEqual({ start: 12, end: 23 });
    expect(previousWordBoundary(text, 9)).toBe(6);
    expect(nextWordBoundary(text, 0)).toBe(5);
    expect(stepOffset('a😀b', 1, 1)).toBe(3);
    expect(stepOffset('a😀b', 3, -1)).toBe(1);
  });
});

describe('连击判定', () => {
  it('间隔与位移都在阈值内的连续按下计为连击，否则重新计数', () => {
    const counter = new ClickCounter();
    expect(counter.press({ x: 0, y: 0 }, 0, 0)).toBe(1);
    expect(counter.press({ x: 2, y: 1 }, 0, 200)).toBe(2);
    expect(counter.press({ x: 2, y: 1 }, 0, 400)).toBe(3);
    expect(counter.press({ x: 2, y: 1 }, 0, 1000)).toBe(1);
    expect(counter.press({ x: 20, y: 1 }, 0, 1100)).toBe(1);
    expect(counter.press({ x: 20, y: 1 }, 2, 1200)).toBe(1);
  });
});
