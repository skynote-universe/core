/**
 * @file host.protocol.ts
 * @description 宿主能力契约：覆盖层、光标、指针捕获与文字输入，由渲染器挂载时提供给引擎
 *
 * 设计考量 (Why):
 * 1. 平台中立：内核与插件只提交声明式覆盖层图元 (世界坐标) 与抽象光标，不感知 DOM 或 Leafer。
 * 2. 持久与瞬态分开：选中框等持久图元随状态更新；框选、参考线等瞬态图元在失焦或 Esc 时由宿主兜底清除，
 *    交互中断后不残留，也不误清仍然有效的选中框。
 * 3. 文字输入只借用宿主的输入通道 (浏览器为隐藏的 textarea)：输入法、粘贴与剪贴板由宿主接收后转为回调，
 *    光标、选区与文字排版全部在画布内完成 (ADR-122)；方向键等编辑按键照常经键盘作用域分发。
 * 4. 挂载前可用：挂载前宿主为空实现，插件安装与渲染器挂载顺序互不约束；视口像素尺寸由会话提供，不在这里。
 */

import type { CanvasPrimitive } from './primitives.protocol';

/** 内置光标 (见 CursorRegistry)：全部自绘，可被覆盖 */
export type BuiltinCursorId = 'default' | 'pointer' | 'move' | 'crosshair' | 'text' | 'grab' | 'grabbing';

/**
 * 带角度的光标：缩放光标 (resize，0° 为水平双向箭头) 与旋转光标 (rotate，0° 时弧线在左侧)，
 * 随控制柄方位与节点旋转变化；也可用于插件注册的可旋转光标
 */
export interface AngledCursor {
  readonly kind: 'resize' | 'rotate' | (string & {});
  readonly angle: number;
}

/**
 * 宿主光标：光标注册表中的 id (内置或插件注册)，或带角度的光标；
 * 未注册的 id 由宿主当作平台光标名直接使用 (浏览器即 CSS cursor 关键字)
 */
export type CanvasCursor = BuiltinCursorId | (string & {}) | AngledCursor;

export interface OverlayOptions {
  /** 瞬态图元 (框选、参考线)：宿主在失焦或 Esc 时兜底清除；默认 false */
  transient?: boolean;
}

/** 覆盖层通道：按会话声明式设置图元 (世界坐标)，空数组即清除该会话 */
export interface OverlayChannel {
  setPrimitives(sessionId: string, primitives: readonly CanvasPrimitive[], options?: OverlayOptions): void;
  clear(sessionId: string): void;
}

/** 剪贴板中的文字：纯文本供外部应用，richText 为画布富文本分段 (JSON，粘贴时由内核校验) */
export interface TextClipboardContent {
  readonly text: string;
  readonly richText?: string;
}

/** 画布富文本分段在剪贴板中的 MIME 类型 */
export const RICH_TEXT_CLIPBOARD_TYPE = 'application/x-skynote-rich-text';

/** 文字输入回调：宿主把键入、输入法、粘贴与剪贴板操作转为这些调用 */
export interface TextInputHandler {
  /** 插入文字并替换当前选区 (键入；回车为 '
') */
  insertText(text: string): void;
  /** 粘贴：有富文本分段时保留样式，否则按纯文本插入 */
  paste(content: TextClipboardContent): void;
  /** 输入法组合开始 */
  compositionStart(): void;
  /** 输入法组合文字更新 (尚未确认的拼音或候选) */
  compositionUpdate(text: string): void;
  /** 输入法组合结束，text 为最终确认的文字 (取消时为空串) */
  compositionEnd(text: string): void;
  /** 复制：返回选区内容；空选区返回 null */
  copySelection(): TextClipboardContent | null;
  /** 剪切：返回选区内容并删除选区 */
  cutSelection(): TextClipboardContent | null;
}

/** 一次文字输入会话 */
export interface TextInputSession {
  /** 光标位置 (画布容器内的屏幕像素)：输入法候选框跟随光标显示 */
  setCaretRect(rect: { x: number; y: number; height: number }): void;
  /** 重新取得键盘焦点 (点击画布时宿主会把焦点交给画布容器) */
  focus(): void;
  close(): void;
}

/** 宿主能力 */
export interface CanvasHost {
  readonly overlay: OverlayChannel;
  setCursor(cursor: CanvasCursor): void;
  /** 指针捕获：拖拽移出画布后仍能收到移动与抬起 */
  capturePointer(pointerId: number): void;
  releasePointer(pointerId: number): void;
  /** 开始接收文字输入 (同一时刻只有一个会话，开启新会话会关闭旧会话) */
  openTextInput(handler: TextInputHandler): TextInputSession;
}

const noop = (): void => {};

/** 渲染器挂载前的空宿主：所有能力静默无效 */
export const DETACHED_CANVAS_HOST: CanvasHost = Object.freeze({
  overlay: Object.freeze({ setPrimitives: noop, clear: noop }),
  setCursor: noop,
  capturePointer: noop,
  releasePointer: noop,
  openTextInput: () => Object.freeze({ setCaretRect: noop, focus: noop, close: noop })
});
