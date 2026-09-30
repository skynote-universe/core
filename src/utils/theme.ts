/**
 * @file theme.ts
 * @description 主题预设、语义色推导与颜色引用解析 (纯函数)
 *
 * 设计考量 (Why):
 * 1. 全仓唯一的色值定义处：预设种子色是设计 Token 的源头，渲染层与节点 compose() 不得再写死任何色值。
 * 2. 推导比例的取值依据：以「前景色混入背景色的比例」表达层级强弱。
 *    人眼对暗部的亮度差更不敏感，深色底需要更大的比例才有同等的层次感 (浅色底 2% 的卡片填充在深色底上几乎不可见)，
 *    因此按背景明暗选用两组比例。
 * 3. 图元主题化集中一处：compose() 产出的图元在交给任何渲染器前统一解析颜色引用与缺省色，
 *    渲染器只做结构映射，不感知主题。
 */

import type { CanvasTheme, CanvasThemeConfig, CanvasThemeSeed } from '../types/theme';
import type { CanvasPrimitive } from '../protocols/primitives.protocol';
import { mixHexColors, parseHexColor } from './color';

/**
 * 标准语义调色板：文档中以 `$名称` 引用 (如便签底色 `$yellow`)
 * 便签类内容明暗主题下保持明亮底色与深色文字 (与 FigJam 一致)，因此两套主题共用同一组取值；
 * ink 为这类亮底上的文字色。
 */
export const CANVAS_PALETTE: Readonly<Record<string, string>> = Object.freeze({
  yellow: '#FFE38A',
  orange: '#FFC89A',
  pink: '#FFB8C8',
  purple: '#D9C2FF',
  blue: '#A8D1FF',
  teal: '#9FE3D6',
  green: '#B8E6A0',
  gray: '#E3E6EA',
  ink: '#1F2937'
});

/** 浅色主题预设 */
export const LIGHT_CANVAS_THEME_SEED: CanvasThemeSeed = Object.freeze({
  background: '#FFFFFF',
  foreground: '#1E293B',
  accent: '#3B82F6',
  palette: CANVAS_PALETTE
});

/** 深色主题预设 */
export const DARK_CANVAS_THEME_SEED: CanvasThemeSeed = Object.freeze({
  background: '#0F172A',
  foreground: '#E2E8F0',
  accent: '#60A5FA',
  palette: CANVAS_PALETTE
});

/** 前景色混入背景色的比例：浅色底 */
const LIGHT_TINT_RATIOS = { nodeFill: 0.02, nodeStroke: 0.22, connectorStroke: 0.7, placeholderFill: 0.12 };
/** 前景色混入背景色的比例：深色底 (暗部层次需要更大的亮度差) */
const DARK_TINT_RATIOS = { nodeFill: 0.08, nodeStroke: 0.34, connectorStroke: 0.72, placeholderFill: 0.18 };

/** 按相对亮度 (sRGB 近似) 判断深色背景 */
function isDarkColor(hex: string): boolean {
  const { r, g, b } = parseHexColor(hex)!;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128;
}

/**
 * 由种子色推导完整语义色板
 * @throws 种子色、调色板或覆盖项中存在非法 hex 颜色 (开发者配置错误应尽早暴露)
 */
export function deriveCanvasTheme(config: CanvasThemeConfig): CanvasTheme {
  const { seed } = config;
  const palette = { ...seed.palette };
  // 丢弃值为 undefined 的覆盖项，避免把推导结果覆盖成空
  const overrides = Object.fromEntries(
    Object.entries(config.overrides ?? {}).filter(([, color]) => color !== undefined)
  );

  const colors: [string, unknown][] = [
    ['background', seed.background],
    ['foreground', seed.foreground],
    ['accent', seed.accent],
    ...Object.entries(palette).map(([name, color]): [string, unknown] => [`palette.${name}`, color]),
    ...Object.entries(overrides)
  ];
  for (const [name, color] of colors) {
    if (typeof color !== 'string' || !parseHexColor(color)) {
      throw new Error(`[theme] 非法主题颜色 ${name}: ${String(color)}`);
    }
  }

  const tint = (ratio: number): string => mixHexColors(seed.background, seed.foreground, ratio);
  const ratios = isDarkColor(seed.background) ? DARK_TINT_RATIOS : LIGHT_TINT_RATIOS;
  const theme: CanvasTheme = {
    background: seed.background,
    foreground: seed.foreground,
    accent: seed.accent,
    nodeFill: tint(ratios.nodeFill),
    nodeStroke: tint(ratios.nodeStroke),
    textColor: seed.foreground,
    connectorStroke: tint(ratios.connectorStroke),
    placeholderFill: tint(ratios.placeholderFill),
    selectionStroke: seed.accent,
    palette: Object.freeze(palette),
    ...overrides
  };
  return Object.freeze(theme);
}

/**
 * 解析颜色取值：未设置取 fallback，`$名称` 从主题调色板查找 (查不到退回 fallback)，其余原样返回
 */
export function resolveThemeColor(
  value: string | undefined,
  theme: CanvasTheme,
  fallback?: string
): string | undefined {
  if (value === undefined) return fallback;
  if (value.startsWith('$')) return theme.palette[value.slice(1)] ?? fallback;
  return value;
}

/**
 * 将 compose() 产出的图元主题化：解析所有颜色引用，并为文字、线条补齐主题缺省色
 * 返回新的图元树，不修改入参
 */
export function applyThemeToPrimitives(primitives: readonly CanvasPrimitive[], theme: CanvasTheme): CanvasPrimitive[] {
  return primitives.map((primitive): CanvasPrimitive => {
    switch (primitive.kind) {
      case 'text':
        return { ...primitive, fill: resolveThemeColor(primitive.fill, theme, theme.textColor) };
      case 'line':
        return { ...primitive, stroke: resolveThemeColor(primitive.stroke, theme, theme.foreground) };
      case 'image':
        return primitive;
      case 'group':
        return { ...primitive, children: applyThemeToPrimitives(primitive.children, theme) };
      case 'box':
        return {
          ...primitive,
          fill: resolveThemeColor(primitive.fill, theme),
          stroke: resolveThemeColor(primitive.stroke, theme),
          children: applyThemeToPrimitives(primitive.children, theme)
        };
      default:
        return {
          ...primitive,
          fill: resolveThemeColor(primitive.fill, theme),
          stroke: resolveThemeColor(primitive.stroke, theme)
        };
    }
  });
}
