/**
 * @file cursor.protocol.ts
 * @description 画布光标定义契约：光标图形以 SVG 片段描述 (纯数据，平台中立)，由宿主转换为平台光标
 *
 * 设计考量 (Why):
 * 1. 全部自绘：系统光标在各平台外观不一，也没有旋转光标与任意角度的缩放光标；统一自绘后整套风格一致，
 *    缩放光标还能精确对准旋转后的边。
 * 2. 颜色用占位符 {ink} (图形) 与 {halo} (外描边)，由注册表的配色统一替换：换一套配色即可整体换风格。
 * 3. 开放注册与覆盖：插件与宿主应用可以注册新光标或覆盖内置光标 (同 id)，插件卸载时恢复被覆盖的定义。
 */

import type { Point } from '../types/geometry';

export interface CursorDefinition {
  /** 光标 id，如 'default'、'resize'；与内置 id 相同即覆盖内置光标 */
  readonly id: string;
  /**
   * 32×32 画布内的 SVG 片段 (不含外层 svg 标签)；颜色写占位符 {ink} 与 {halo}
   * 随角度旋转的光标按 0° 朝向绘制 (如缩放光标为水平双向箭头)
   */
  readonly svg: string;
  /** 热点 (32×32 坐标)：指针实际指向的位置 */
  readonly hotspot: Point;
  /** 随角度旋转 (缩放、旋转光标)：宿主绕画布中心旋转，热点应在中心 */
  readonly rotatable?: boolean;
  /** 宿主无法显示自绘光标时的退路 (浏览器为 CSS 光标关键字) */
  readonly fallback: string;
}

/** 光标配色：整套光标共用 */
export interface CursorStyle {
  /** 图形颜色 */
  readonly ink: string;
  /** 外描边颜色：保证在任意底色上都清晰 */
  readonly halo: string;
  /** 柔和投影：让光标浮在画布之上，浅色画布上更有层次 */
  readonly shadow: boolean;
}

/** 注册表解析出的完整光标 (宿主据此生成平台光标并按 key 缓存) */
export interface RenderedCursor {
  /** 缓存键：光标 id、角度档位与注册表版本 */
  readonly key: string;
  /** 完整的 SVG 文档 (32×32) */
  readonly svg: string;
  readonly hotspot: Point;
  readonly fallback: string;
}
