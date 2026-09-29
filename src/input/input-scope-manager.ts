/**
 * @file input-scope-manager.ts
 * @description ADR-005 焦点栈与键盘快捷键优先级调度器 (InputScopeManager)
 * 
 * 设计考量 (Why):
 * 1. 键盘严禁私自 window.keydown (AGENTS.md 铁律)：所有快捷键必须注册到此焦点栈统一调度。
 * 2. 输入法组合态守卫 (IME Guard)：在中文/日文拼音打字期间 (e.isComposing === true)，严禁触发任何快捷键打断输入！
 * 3. 作用域自顶向下消费：富文本编辑态 (priority: 100) 优先于节点选中态 (priority: 50)，画布全局 (priority: 0) 兜底。
 */

import type { CanvasKeyboardEvent, InputScope } from '../protocols/input-scope.protocol';

export class InputScopeManager {
  private readonly scopes = new Map<string, InputScope>();
  /** 当前按优先级从高到低排序的活跃作用域列表 */
  private activeScopes: InputScope[] = [];

  /**
   * 注册并激活焦点作用域
   */
  pushScope(scope: InputScope): void {
    this.scopes.set(scope.id, scope);
    this.rebuildActiveScopes();
  }

  /**
   * 弹出/注销指定焦点作用域
   */
  popScope(scopeId: string): boolean {
    const deleted = this.scopes.delete(scopeId);
    if (deleted) {
      this.rebuildActiveScopes();
    }
    return deleted;
  }

  /**
   * 获取当前最高优先级的活跃作用域
   */
  getActiveScope(): InputScope | undefined {
    return this.activeScopes[0];
  }

  /**
   * 判断某个作用域当前是否处于活跃态
   */
  hasScope(scopeId: string): boolean {
    return this.scopes.has(scopeId);
  }

  /**
   * 分发按键按下事件
   * @returns 是否被某个作用域消费 (返回 true 或调用 stopPropagation)
   */
  dispatchKeyDown(e: CanvasKeyboardEvent): boolean {
    return this.dispatch(e, (scope) => scope.onKeyDown);
  }

  /**
   * 分发按键抬起事件
   */
  dispatchKeyUp(e: CanvasKeyboardEvent): boolean {
    return this.dispatch(e, (scope) => scope.onKeyUp);
  }

  /**
   * 清空全部作用域
   */
  clear(): void {
    this.scopes.clear();
    this.activeScopes = [];
  }

  /**
   * 自顶向下依序交给优先级最高的活跃作用域，任一作用域消费即停止
   * 以原事件为原型包装以拦截 stopPropagation，不改写宿主传入的事件对象
   */
  private dispatch(
    event: CanvasKeyboardEvent,
    pickHandler: (scope: InputScope) => ((e: CanvasKeyboardEvent) => boolean | void) | undefined
  ): boolean {
    // IME Guard：输入法组合输入期间 (isComposing 或 Windows 组合键码 229) 绝不触发快捷键打断打字
    if (event.isComposing || event.keyCode === 229) {
      return false;
    }

    let stopped = false;
    const wrapped: CanvasKeyboardEvent = Object.create(event, {
      stopPropagation: {
        value: () => {
          stopped = true;
          event.stopPropagation();
        }
      }
    });

    const scopes = this.activeScopes;
    for (let i = 0; i < scopes.length; i++) {
      const handler = pickHandler(scopes[i]);
      if (!handler) continue;
      if (handler.call(scopes[i], wrapped) === true || stopped) {
        return true;
      }
    }
    return false;
  }

  private rebuildActiveScopes(): void {
    this.activeScopes = Array.from(this.scopes.values()).sort(
      (a, b) => b.priority - a.priority
    );
  }
}
