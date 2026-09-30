/**
 * @file host.protocol.ts
 * @description 宿主能力契约：覆盖层、光标与指针捕获，由渲染器挂载时提供给引擎
 *
 * 设计考量 (Why):
 * 1. 平台中立：内核与插件只提交声明式覆盖层图元 (世界坐标) 与抽象光标，不感知 DOM 或 Leafer。
 * 2. 持久与瞬态分开：选中框等持久图元随状态更新；框选、参考线等瞬态图元在失焦或 Esc 时由宿主兜底清除，
 *    交互中断后不残留，也不误清仍然有效的选中框。
 * 3. 挂载前可用：挂载前宿主为空实现，插件安装与渲染器挂载顺序互不约束；视口像素尺寸由会话提供，不在这里。
 */

import type { CanvasPrimitive } from './primitives.protocol';

/** 抽象光标 (浏览器映射为 CSS cursor) */
export type SystemCursor =
  | 'default'
  | 'grab'
  | 'grabbing'
  | 'crosshair'
  | 'text'
  | 'move'
  | 'nwse-resize'
  | 'nesw-resize'
  | 'ew-resize'
  | 'ns-resize';

export interface OverlayOptions {
  /** 瞬态图元 (框选、参考线)：宿主在失焦或 Esc 时兜底清除；默认 false */
  transient?: boolean;
}

/** 覆盖层通道：按会话声明式设置图元 (世界坐标)，空数组即清除该会话 */
export interface OverlayChannel {
  setPrimitives(sessionId: string, primitives: readonly CanvasPrimitive[], options?: OverlayOptions): void;
  clear(sessionId: string): void;
}

/** 宿主能力 */
export interface CanvasHost {
  readonly overlay: OverlayChannel;
  setCursor(cursor: SystemCursor): void;
  /** 指针捕获：拖拽移出画布后仍能收到移动与抬起 */
  capturePointer(pointerId: number): void;
  releasePointer(pointerId: number): void;
}

const noop = (): void => {};

/** 渲染器挂载前的空宿主：所有能力静默无效 */
export const DETACHED_CANVAS_HOST: CanvasHost = Object.freeze({
  overlay: Object.freeze({ setPrimitives: noop, clear: noop }),
  setCursor: noop,
  capturePointer: noop,
  releasePointer: noop
});
