/**
 * @file color.ts
 * @description 十六进制颜色解析与线性混合纯函数
 *
 * 设计考量 (Why):
 * 1. 极简依赖红线：主题推导只需要 hex 解析与按比例混合，手写即可，无需引入颜色库。
 * 2. 在 sRGB 空间线性插值：与设计稿工具 (Figma / CSS color-mix in srgb) 的混色结果一致，便于设计对照。
 */

/** 0~255 的 RGB 通道与 0~1 的透明度 */
export interface RgbaColor {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

/**
 * 解析 #rgb / #rgba / #rrggbb / #rrggbbaa，非法输入返回 null
 */
export function parseHexColor(value: string): RgbaColor | null {
  const match = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(value.trim());
  if (!match) return null;

  let hex = match[1];
  if (hex.length <= 4) {
    hex = hex
      .split('')
      .map((char) => char + char)
      .join('');
  }
  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16),
    a: hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1
  };
}

/** 格式化为 #rrggbb，透明度不足 1 时输出 #rrggbbaa */
export function formatHexColor(color: RgbaColor): string {
  const channel = (value: number): string =>
    Math.round(Math.min(255, Math.max(0, value))).toString(16).padStart(2, '0');
  const alpha = color.a < 1 ? channel(color.a * 255) : '';
  return `#${channel(color.r)}${channel(color.g)}${channel(color.b)}${alpha}`.toUpperCase();
}

/**
 * 按比例混合两种颜色：ratio = 0 得到 from，ratio = 1 得到 to
 * @throws 任一输入不是合法 hex 颜色
 */
export function mixHexColors(from: string, to: string, ratio: number): string {
  const a = parseHexColor(from);
  const b = parseHexColor(to);
  if (!a || !b) {
    throw new Error(`[color] 无法混合非法颜色: ${from} / ${to}`);
  }
  const t = Math.min(1, Math.max(0, ratio));
  return formatHexColor({
    r: a.r + (b.r - a.r) * t,
    g: a.g + (b.g - a.g) * t,
    b: a.b + (b.b - a.b) * t,
    a: a.a + (b.a - a.a) * t
  });
}
