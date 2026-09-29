/**
 * @file overlay.protocol.ts
 * @description 覆盖层与宿主能力契约：交互插件在内容之上绘制选中框、框选区域、参考线等，不进入文档
 *
 * 设计考量 (Why):
 * 1. 平台中立：插件只提交声明式图元 (世界坐标)，由渲染器绘制在内容层之上；插件不感知 Leafer 或 DOM。
 * 2. 持久与瞬态分开：选中框等持久图元随状态更新；框选区域、吸附参考线等瞬态图元在失焦或 Esc 时由宿主兜底清除，
 *    避免交互中断后残留，同时不误清仍然有效的选中框。
 * 3. 挂载前可用：渲染器挂载前宿主能力为空实现，插件安装顺序与渲染器挂载顺序互不约束。
 */

import type { CanvasPrimitive } from './primitives.protocol';
import type { IHostBridge, SystemCursor } from './host-bridge.protocol';

export interface OverlayOptions {
  /** 瞬态图元 (框选、参考线)：宿主在失焦或 Esc 时兜底清除；默认 false */
  transient?: boolean;
}

/** 覆盖层通道：按会话声明式设置图元 (世界坐标)，空数组即清除该会话 */
export interface OverlayChannel {
  setPrimitives(sessionId: string, primitives: readonly CanvasPrimitive[], options?: OverlayOptions): void;
  clear(sessionId: string): void;
}

/** 渲染器挂载后向引擎提供的宿主能力 */
export interface CanvasHost {
  readonly bridge: IHostBridge;
  readonly overlay: OverlayChannel;
}

/** 暴露给插件的宿主能力 (调用时转发到当前挂载的宿主) */
export interface CanvasHostServices {
  readonly overlay: OverlayChannel;
  setCursor(cursor: SystemCursor): void;
  capturePointer(pointerId: number): void;
  releasePointer(pointerId: number): void;
  /** 画布视口的屏幕像素尺寸；未挂载时为 0 */
  getViewportSize(): { width: number; height: number };
}

const NOOP_OVERLAY: OverlayChannel = Object.freeze({
  setPrimitives: () => {},
  clear: () => {}
});

/** 渲染器挂载前的空宿主：所有能力静默无效，视口尺寸为 0 */
export const DETACHED_CANVAS_HOST: CanvasHost = Object.freeze({
  bridge: Object.freeze({
    getViewportRect: () => ({ width: 0, height: 0 }),
    setCursor: () => {},
    capturePointer: () => {},
    releasePointer: () => {},
    destroy: () => {}
  }),
  overlay: NOOP_OVERLAY
});
