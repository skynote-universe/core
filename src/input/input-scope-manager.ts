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
   * 键盘按下事件统一分发处理
   * @returns 是否已被某个作用域成功消费
   */
  dispatchKeyDown(e: CanvasKeyboardEvent): boolean {
    // 守卫 1：输入法组合输入期间 (isComposing 或 Windows 组合键码 229)，绝对严禁触发任何快捷键打断用户打字
    if (e.isComposing || e.keyCode === 229) {
      return false;
    }

    let stopped = false;
    // 包装 stopPropagation 侦听
    const originalStop = e.stopPropagation.bind(e);
    (e as { stopPropagation: () => void }).stopPropagation = () => {
      stopped = true;
      originalStop();
    };

    // 自顶向下依序遍历优先级最高的活跃作用域
    for (let i = 0; i < this.activeScopes.length; i++) {
      const scope = this.activeScopes[i];
      if (scope.onKeyDown) {
        const handled = scope.onKeyDown(e);
        if (handled === true || stopped) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * 键盘弹起事件统一分发处理
   */
  dispatchKeyUp(e: CanvasKeyboardEvent): boolean {
    if (e.isComposing || e.keyCode === 229) {
      return false;
    }

    let stopped = false;
    const originalStop = e.stopPropagation.bind(e);
    (e as { stopPropagation: () => void }).stopPropagation = () => {
      stopped = true;
      originalStop();
    };

    for (let i = 0; i < this.activeScopes.length; i++) {
      const scope = this.activeScopes[i];
      if (scope.onKeyUp) {
        const handled = scope.onKeyUp(e);
        if (handled === true || stopped) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * 清空全部作用域
   */
  clear(): void {
    this.scopes.clear();
    this.activeScopes = [];
  }

  private rebuildActiveScopes(): void {
    this.activeScopes = Array.from(this.scopes.values()).sort(
      (a, b) => b.priority - a.priority
    );
  }
}
