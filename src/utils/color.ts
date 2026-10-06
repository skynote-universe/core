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

/** rgb() / rgba() 函数写法 (逗号或空格分隔，透明度可为小数或百分比) */
const RGB_FUNCTION = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*(?:[,/]\s*([\d.]+)(%?)\s*)?\)$/i;

/** 解析十六进制或 rgb() / rgba() 颜色；其他写法 (颜色名、主题色引用) 返回 null */
export function parseCssColor(value: string): RgbaColor | null {
  const hex = parseHexColor(value);
  if (hex) return hex;
  const match = RGB_FUNCTION.exec(value.trim());
  if (!match) return null;
  const [, r, g, b, alpha, percent] = match;
  const a = alpha === undefined ? 1 : Number(alpha) / (percent ? 100 : 1);
  return { r: Number(r), g: Number(g), b: Number(b), a: Math.min(1, Math.max(0, a)) };
}

/**
 * 把带透明度的颜色拆成不透明的色值与透明度：文档中颜色只存不透明值，透明度存在单独的字段里，
 * 界面上的不透明度才与实际效果一致
 * @returns 不带透明度 (或无法解析) 时为 null，原样保留
 */
export function splitColorAlpha(value: string): { color: string; alpha: number } | null {
  const color = parseCssColor(value);
  if (!color || color.a >= 1) return null;
  return { color: formatHexColor({ ...color, a: 1 }), alpha: color.a };
}

/** 格式化为 #rrggbb，透明度不足 1 时输出 #rrggbbaa */
export function formatHexColor(color: RgbaColor): string {
  const channel = (value: number): string =>
    Math.round(Math.min(255, Math.max(0, value)))
      .toString(16)
      .padStart(2, '0');
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
