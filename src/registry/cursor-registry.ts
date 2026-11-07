/**
 * @file cursor-registry.ts
 * @description 画布光标注册表：内置整套自绘光标，开放注册、覆盖与统一配色
 *
 * 设计考量 (Why):
 * 1. 内置光标统一为「深色图形 + 浅色外描边」，与系统光标的通用画法一致，在任意底色上都清晰；
 *    图形约 20 像素见方，与系统光标大小相当。
 * 2. 填充图形用 paint-order="stroke" 让外描边画在图形下面，只露出外侧一圈；线条图形先画粗的外描边再画细的图形线。
 * 3. 覆盖可撤销：同一 id 的定义按注册顺序叠成一摞，最上面的生效；register 返回的恢复函数只移除自己那一层，
 *    多个插件以任意顺序卸载，生效的始终是仍在的最后一次注册 (都卸载后回到内置)。
 * 4. 带角度的光标按 ANGLE_STEP 取整：缓存数量有上限，肉眼也看不出几度的差别。
 * 5. 投影统一由注册表加在最外层 (旋转之后)：任何角度的光标阴影都朝下，插件注册的光标也自动带上。
 */

import type { CanvasCursor } from '../protocols/host.protocol';
import type { CursorDefinition, CursorStyle, RenderedCursor } from '../protocols/cursor.protocol';

/** 带角度光标的取整步长 (度) */
const ANGLE_STEP = 5;
const SIZE = 32;

const DEFAULT_STYLE: CursorStyle = { ink: 'black', halo: 'white', shadow: true };

/** 柔和投影：向下 1 像素、轻微模糊 */
const SHADOW_FILTER =
  '<defs><filter id="cursor-shadow" x="-50%" y="-50%" width="200%" height="200%">' +
  '<feDropShadow dx="0" dy="1" stdDeviation="0.9" flood-color="black" flood-opacity="0.35"/></filter></defs>';

/** 填充图形：外描边在下，露出外侧 1.25 像素 */
const filled = (shape: string): string =>
  shape.replace(
    '/>',
    ' fill="{ink}" stroke="{halo}" stroke-width="2.5" stroke-linejoin="round" paint-order="stroke"/>'
  );

/** 线条图形：先画粗的外描边，再画细的图形线 */
const stroked = (d: string): string =>
  `<path d="${d}" stroke="{halo}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" fill="none"/>` +
  `<path d="${d}" stroke="{ink}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`;

const CENTER = { x: 16, y: 16 };

/** 内置光标 */
const BUILT_IN_CURSORS: readonly CursorDefinition[] = [
  {
    // 小飞机 (与 FigJam 一致)：尖头指向左上，两翼尖带小圆角，背部内凹；尖头处外描边用尖角连接，保持锐利
    id: 'default',
    svg: '<path d="M6 5L24.2 11.9Q25.6 12.5 24.2 13.1L17.8 15.2Q16.2 15.7 15.6 17.2L13.1 24.2Q12.5 25.6 11.9 24.2Z" fill="{ink}" stroke="{halo}" stroke-width="2.5" stroke-linejoin="miter" stroke-miterlimit="4" paint-order="stroke"/>',
    hotspot: { x: 6, y: 5 },
    fallback: 'default'
  },
  {
    // 可点击控件的指示手型：沿用整套光标的深色图形、浅色描边和统一投影。
    id: 'pointer',
    svg: filled(
      '<path d="M12 17V7a2 2 0 0 1 4 0v6a2 2 0 0 1 4 0v1a2 2 0 0 1 4 0v7c0 3.3-2.7 6-6 6h-2c-2.3 0-4-1.1-5.2-3l-3.6-5.2a1.8 1.8 0 0 1 2.7-2.3L12 19Z"/>'
    ),
    hotspot: { x: 14, y: 5 },
    fallback: 'pointer'
  },
  {
    id: 'move',
    svg: filled(
      '<path d="M16 5L20 9L17 9L17 15L23 15L23 12L27 16L23 20L23 17L17 17L17 23L20 23L16 27L12 23L15 23L15 17L9 17L9 20L5 16L9 12L9 15L15 15L15 9L12 9Z"/>'
    ),
    hotspot: CENTER,
    fallback: 'move'
  },
  {
    // 0° 为水平双向箭头，宿主按边的方向旋转
    id: 'resize',
    svg: filled(
      '<path d="M6 16L10.5 11.5L10.5 14.8L21.5 14.8L21.5 11.5L26 16L21.5 20.5L21.5 17.2L10.5 17.2L10.5 20.5Z"/>'
    ),
    hotspot: CENTER,
    rotatable: true,
    fallback: 'ew-resize'
  },
  {
    // 一段大圆弧加两端切向箭头；0° 时弧线在左侧
    id: 'rotate',
    svg:
      stroked('M14.5 6.5A13.5 13.5 0 0 0 14.5 25.5') +
      filled('<polygon points="17.5,3.5 12.4,4.4 16.6,8.6"/>') +
      filled('<polygon points="17.5,28.5 16.6,23.4 12.4,27.6"/>'),
    hotspot: CENTER,
    rotatable: true,
    fallback: 'crosshair'
  },
  {
    id: 'crosshair',
    svg: stroked('M16 6V13M16 19V26M6 16H13M19 16H26'),
    hotspot: CENTER,
    fallback: 'crosshair'
  },
  {
    id: 'text',
    svg: stroked('M16 8V24M13 8H19M13 24H19'),
    hotspot: CENTER,
    fallback: 'text'
  },
  {
    // 张开的手：四指与拇指在下，手掌最后画，外描边自然勾出指根
    id: 'grab',
    svg:
      filled('<rect x="10.2" y="8" width="3.2" height="10" rx="1.6"/>') +
      filled('<rect x="13.8" y="6.5" width="3.2" height="11.5" rx="1.6"/>') +
      filled('<rect x="17.4" y="7" width="3.2" height="11" rx="1.6"/>') +
      filled('<rect x="21" y="9" width="3.2" height="9" rx="1.6"/>') +
      filled('<rect x="6.6" y="13" width="3.2" height="8" rx="1.6" transform="rotate(-35 8.2 17)"/>') +
      filled('<rect x="9.8" y="15" width="14.4" height="11" rx="4"/>'),
    hotspot: CENTER,
    fallback: 'grab'
  },
  {
    // 握拳：四指收短，拇指贴在手掌前
    id: 'grabbing',
    svg:
      filled('<rect x="10.2" y="12" width="3.2" height="6" rx="1.6"/>') +
      filled('<rect x="13.8" y="11" width="3.2" height="7" rx="1.6"/>') +
      filled('<rect x="17.4" y="11.5" width="3.2" height="6.5" rx="1.6"/>') +
      filled('<rect x="21" y="13" width="3.2" height="5" rx="1.6"/>') +
      filled('<rect x="9.8" y="15" width="14.4" height="11" rx="4"/>') +
      filled('<rect x="7.8" y="16" width="3.2" height="6" rx="1.6" transform="rotate(-50 9.4 19)"/>'),
    hotspot: CENTER,
    fallback: 'grabbing'
  }
];

export class CursorRegistry {
  /** 每个 id 的定义叠层：最后一个生效，内置光标在最底层 */
  private readonly layers = new Map<string, CursorDefinition[]>();
  private currentStyle: CursorStyle = DEFAULT_STYLE;
  /** 定义或配色每变一次加一：宿主据此让缓存失效 */
  private version = 0;
  private readonly listeners = new Set<() => void>();

  constructor() {
    this.registerBuiltIns();
  }

  get style(): CursorStyle {
    return this.currentStyle;
  }

  /**
   * 注册光标，与已有 id 相同即覆盖
   * @returns 恢复函数：移除这次注册 (只影响自己这一层)
   */
  register(definition: CursorDefinition): () => void {
    if (!definition.id) throw new Error('[CursorRegistry] 注册失败：光标定义缺少 id');
    const layers = this.layers.get(definition.id) ?? [];
    layers.push(definition);
    this.layers.set(definition.id, layers);
    this.changed();
    return () => {
      const index = layers.lastIndexOf(definition);
      if (index < 0) return;
      layers.splice(index, 1);
      if (layers.length === 0) this.layers.delete(definition.id);
      this.changed();
    };
  }

  /** 当前生效的定义 */
  get(id: string): CursorDefinition | undefined {
    return this.layers.get(id)?.at(-1);
  }

  /** 统一配色：整套光标 (含插件注册的) 一起换 */
  setStyle(style: Partial<CursorStyle>): void {
    this.currentStyle = { ...this.currentStyle, ...style };
    this.changed();
  }

  /** 光标定义或配色变化时通知 (宿主据此刷新当前光标) */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * 解析出完整光标；未注册的 id 返回 undefined (宿主可把它当作平台光标名直接使用)
   */
  render(cursor: CanvasCursor): RenderedCursor | undefined {
    const id = typeof cursor === 'string' ? cursor : cursor.kind;
    const definition = this.get(id);
    if (!definition) return undefined;
    const angle =
      typeof cursor === 'string' || !definition.rotatable
        ? 0
        : (((Math.round(cursor.angle / ANGLE_STEP) * ANGLE_STEP) % 360) + 360) % 360;
    const { ink, halo } = this.currentStyle;
    const body = definition.svg.replaceAll('{ink}', ink).replaceAll('{halo}', halo);
    const rotated = angle === 0 ? body : `<g transform="rotate(${angle} ${SIZE / 2} ${SIZE / 2})">${body}</g>`;
    const content = this.currentStyle.shadow
      ? `${SHADOW_FILTER}<g filter="url(#cursor-shadow)">${rotated}</g>`
      : rotated;
    return {
      key: `${id}@${angle}#${this.version}`,
      svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">${content}</svg>`,
      hotspot: definition.hotspot,
      fallback: definition.fallback
    };
  }

  /** 恢复内置光标与默认配色 */
  clear(): void {
    this.layers.clear();
    this.registerBuiltIns();
    this.currentStyle = DEFAULT_STYLE;
    this.changed();
  }

  private registerBuiltIns(): void {
    for (const definition of BUILT_IN_CURSORS) this.layers.set(definition.id, [definition]);
  }

  private changed(): void {
    this.version++;
    for (const listener of this.listeners) listener();
  }
}
