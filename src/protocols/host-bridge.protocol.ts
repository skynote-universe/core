/**
 * @file host-bridge.protocol.ts
 * @description 抽象宿主网关契约 (IHostBridge)
 * 
 * 设计考量 (Why):
 * 1. 平台中立红线：核心引擎不直接操作 DOM 的 setPointerCapture 或 style.cursor。
 * 2. 宿主行为代理：由 Bridge 将抽象的光标枚举和指针锁代理至具体运行平台（Web、小程序或 Mock 容器）。
 */

/** 系统抽象光标形态 */
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

/**
 * 宿主网关网桥接口
 */
export interface IHostBridge {
  /** 获取当前宿主视口尺寸 */
  getViewportRect(): { width: number; height: number };

  /** 设置系统光标 (浏览器映射为 style.cursor，小程序映射为自定义光标图元) */
  setCursor(cursor: SystemCursor): void;

  /** 请求全局指针捕获 (DOM 环境调用 setPointerCapture，非 DOM 环境由 Bridge 内部模拟) */
  capturePointer(pointerId: number): void;

  /** 释放指针捕获 */
  releasePointer(pointerId: number): void;

  /** 销毁并卸载所有原生事件监听 */
  destroy(): void;
}
