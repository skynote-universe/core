/**
 * @file theme.test.ts
 * @description 主题：颜色混合、种子推导与校验、`$名称` 调色板引用、图元主题化、会话显式切换
 */

import { describe, it, expect, vi } from 'vitest';
import { mixHexColors, parseHexColor, formatHexColor } from '../src/utils/color';
import {
  deriveCanvasTheme,
  resolveThemeColor,
  applyThemeToPrimitives,
  LIGHT_CANVAS_THEME_SEED,
  DARK_CANVAS_THEME_SEED
} from '../src/utils/theme';
import { SkyNoteEngine } from '../src/engine';
import type { CanvasPrimitive, TextPrimitive } from '../src/protocols/primitives.protocol';

describe('颜色工具', () => {
  it('解析各种 hex 写法并按比例线性混合', () => {
    expect(parseHexColor('#fff')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseHexColor('#11223380')?.a).toBeCloseTo(128 / 255);
    expect(parseHexColor('red')).toBeNull();

    expect(mixHexColors('#000000', '#FFFFFF', 0.5)).toBe('#808080');
    expect(mixHexColors('#000000', '#FFFFFF', 0)).toBe('#000000');
    expect(formatHexColor({ r: 255, g: 0, b: 0, a: 0.5 })).toBe('#FF000080');
  });
});

describe('deriveCanvasTheme', () => {
  it('由种子色推导语义色：深色底使用更大的混合比例，保证节点与底色有可见的层次', () => {
    const light = deriveCanvasTheme({ seed: LIGHT_CANVAS_THEME_SEED });
    const dark = deriveCanvasTheme({ seed: DARK_CANVAS_THEME_SEED });

    expect(light.textColor).toBe(LIGHT_CANVAS_THEME_SEED.foreground);
    expect(light.selectionStroke).toBe(LIGHT_CANVAS_THEME_SEED.accent);
    // 描边介于底色与前景之间
    expect(light.nodeStroke).toBe(
      mixHexColors(LIGHT_CANVAS_THEME_SEED.background, LIGHT_CANVAS_THEME_SEED.foreground, 0.22)
    );
    expect(dark.nodeStroke).toBe(
      mixHexColors(DARK_CANVAS_THEME_SEED.background, DARK_CANVAS_THEME_SEED.foreground, 0.34)
    );
    expect(dark.nodeFill).toBe(
      mixHexColors(DARK_CANVAS_THEME_SEED.background, DARK_CANVAS_THEME_SEED.foreground, 0.08)
    );
    expect(Object.isFrozen(light)).toBe(true);
  });

  it('逐项覆盖优先于推导值，值为 undefined 的覆盖项被忽略', () => {
    const theme = deriveCanvasTheme({
      seed: LIGHT_CANVAS_THEME_SEED,
      overrides: { nodeStroke: '#FF0000', nodeFill: undefined }
    });
    expect(theme.nodeStroke).toBe('#FF0000');
    expect(theme.nodeFill).toBe(deriveCanvasTheme({ seed: LIGHT_CANVAS_THEME_SEED }).nodeFill);
  });

  it('非法颜色配置立即抛错', () => {
    expect(() => deriveCanvasTheme({ seed: { ...LIGHT_CANVAS_THEME_SEED, accent: 'blue' } })).toThrow(/accent/);
    expect(() => deriveCanvasTheme({ seed: { ...LIGHT_CANVAS_THEME_SEED, palette: { yellow: 'nope' } } })).toThrow(
      /palette\.yellow/
    );
  });
});

describe('颜色引用解析与图元主题化', () => {
  const theme = deriveCanvasTheme({ seed: { ...LIGHT_CANVAS_THEME_SEED, palette: { yellow: '#FDE68A' } } });

  it('未设置取缺省、$名称查调色板、显式色值原样保留', () => {
    expect(resolveThemeColor(undefined, theme, theme.nodeFill)).toBe(theme.nodeFill);
    expect(resolveThemeColor('$yellow', theme)).toBe('#FDE68A');
    expect(resolveThemeColor('$missing', theme, theme.nodeFill)).toBe(theme.nodeFill);
    expect(resolveThemeColor('#123456', theme, theme.nodeFill)).toBe('#123456');
  });

  it('递归解析图元颜色 (含文字分段颜色与背景色) 并为文字、线条补齐主题缺省色，不修改入参', () => {
    const primitives: CanvasPrimitive[] = [
      {
        kind: 'text',
        x: 0,
        y: 0,
        runs: [{ text: 'h' }, { text: 'i', color: '$yellow', backgroundColor: '$yellow' }],
        style: {}
      },
      { kind: 'line', points: [0, 0, 10, 10] },
      {
        kind: 'group',
        x: 0,
        y: 0,
        children: [{ kind: 'rect', x: 0, y: 0, width: 1, height: 1, fill: '$yellow' }]
      }
    ] as CanvasPrimitive[];
    const snapshot = JSON.stringify(primitives);

    const themed = applyThemeToPrimitives(primitives, theme) as unknown as Record<string, unknown>[];
    const text = themed[0] as unknown as TextPrimitive;
    expect(text.style.color).toBe(theme.textColor);
    expect(text.runs[0]).toEqual({ text: 'h' });
    expect(text.runs[1]).toMatchObject({ color: '#FDE68A', backgroundColor: '#FDE68A' });
    expect(themed[1].stroke).toBe(theme.foreground);
    expect((themed[2].children as Record<string, unknown>[])[0].fill).toBe('#FDE68A');
    expect(JSON.stringify(primitives)).toBe(snapshot);
  });
});

describe('会话主题', () => {
  it('引擎初始化时显式配置主题，运行时 setTheme 切换并广播；非法配置不改变当前主题', () => {
    const engine = new SkyNoteEngine({ theme: { seed: DARK_CANVAS_THEME_SEED } });
    expect(engine.session.theme.background).toBe(DARK_CANVAS_THEME_SEED.background);

    const listener = vi.fn();
    engine.session.subscribe(listener);
    const before = engine.session.theme;

    engine.session.setTheme({ seed: LIGHT_CANVAS_THEME_SEED });
    expect(engine.session.theme).not.toBe(before);
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ themeChanged: true }));

    const current = engine.session.theme;
    expect(() => engine.session.setTheme({ seed: { ...LIGHT_CANVAS_THEME_SEED, background: 'white' } })).toThrow();
    expect(engine.session.theme).toBe(current);
    // 主题不进入文档
    expect('theme' in engine.documentStore.getView()).toBe(false);
  });
});
