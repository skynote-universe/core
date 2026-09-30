/**
 * @file input-scope.protocol.ts
 * @description ADR-005 输入焦点栈与键盘快捷键优先级协议
 *
 * 设计考量 (Why):
 * 1. 键盘严禁私自 window.keydown：所有快捷键必须注册到 InputScope 统一调度。
 * 2. 输入法组合态守卫 (IME Guard)：在中文/日文拼音打字期间 (isComposing === true)，严禁触发任何画布快捷键。
 */

/** 键盘事件归一化载荷 */
export interface CanvasKeyboardEvent {
  readonly key: string;
  readonly code: string;
  readonly keyCode?: number;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  /** 是否处于输入法组合拼音状态 */
  readonly isComposing: boolean;
  /** 阻止原生行为 */
  preventDefault(): void;
  /** 阻止向下一级焦点作用域冒泡 */
  stopPropagation(): void;
}

/** 焦点作用域定义 */
export interface InputScope {
  /** 作用域标识，如 'global', 'mindmap:focused', 'table:editing' */
  readonly id: string;
  /** 优先级权重，数值越大越优先消费按键 */
  readonly priority: number;
  /** 按键事件处理 */
  onKeyDown?(e: CanvasKeyboardEvent): boolean | void;
  onKeyUp?(e: CanvasKeyboardEvent): boolean | void;
  /**
   * 画布失去键盘焦点 (切换窗口、焦点移到其他元素)：此后的 keyup 不会到达，
   * 按住空格、修饰键等状态必须在此复位；所有作用域都会收到，不存在消费
   */
  onBlur?(): void;
}
