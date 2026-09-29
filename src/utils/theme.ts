/**
 * @file theme.ts
 * @description 主题预设、语义色推导与颜色引用解析 (纯函数)
 *
 * 设计考量 (Why):
 * 1. 全仓唯一的色值定义处：预设种子色是设计 Token 的源头，渲染层与节点 compose() 不得再写死任何色值。
 * 2. 推导比例的取值依据：以「前景色混入背景色的比例」表达层级强弱，明暗主题下对比关系保持一致，
 *    例如描边 22% 在白底上约等于 slate-300，在深色底上同样是柔和的分隔线。
 * 3. 图元主题化集中一处：compose() 产出的图元在交给任何渲染后端前统一解析颜色引用与缺省色，
 *    渲染后端只做结构映射，不感知主题。
 */

import type { CanvasTheme, CanvasThemeConfig, CanvasThemeSeed } from '../types/theme';
import type { CanvasPrimitive } from '../protocols/primitives.protocol';
import { mixHexColors, parseHexColor } from './color';

/** 浅色主题预设 */
export const LIGHT_CANVAS_THEME_SEED: CanvasThemeSeed = Object.freeze({
  background: '#FFFFFF',
  foreground: '#1E293B',
  accent: '#3B82F6'
});

/** 深色主题预设 */
export const DARK_CANVAS_THEME_SEED: CanvasThemeSeed = Object.freeze({
  background: '#0F172A',
  foreground: '#E2E8F0',
  accent: '#60A5FA'
});

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
  const theme: CanvasTheme = {
    background: seed.background,
    foreground: seed.foreground,
    accent: seed.accent,
    nodeFill: tint(0.02),
    nodeStroke: tint(0.22),
    textColor: seed.foreground,
    connectorStroke: tint(0.7),
    placeholderFill: tint(0.12),
    selectionStroke: seed.accent,
    palette: Object.freeze(palette),
    ...overrides
  };
  return Object.freeze(theme);
}

/**
 * 解析颜色取值：未设置取 fallback，`$名称` 从主题调色板查找 (查不到退回 fallback)，其余原样返回
 */
export function resolveThemeColor(value: string | undefined, theme: CanvasTheme, fallback?: string): string | undefined {
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
