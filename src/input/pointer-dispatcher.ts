/**
 * @file pointer-dispatcher.ts
 * @description 虚拟指针与手势交互调度器 (PointerDispatcher)
 *
 * 设计考量 (Why):
 * 1. 职责单一原则 (SRP)：从 PluginManager 中彻底剥离高频指针事件，与键盘 InputScopeManager
 *    共同构成 core 的标准【输入子系统 (src/input)】。
 * 2. 独占指针会话裁判 (claimPointer)：支持优先级链与会话独占状态拦截，防止拉连线与画框选发生交互冲突。
 * 3. 内存安全：提供完善的监听者注销回收机制，插件 unmount 时自动解绑，杜绝事件监听泄漏。
 */

import type { CanvasPointerEvent, CanvasWheelEvent } from '../protocols/events.protocol';

/** 指针交互钩子集合 */
export interface PointerHooks {
  onPointerDown?(e: CanvasPointerEvent): void;
  onPointerMove?(e: CanvasPointerEvent): void;
  onPointerUp?(e: CanvasPointerEvent): void;
  onWheel?(e: CanvasWheelEvent): void;
}

/** 注册项包装 */
interface PointerEntry {
  readonly id: string;
  readonly priority: number;
  readonly hooks: PointerHooks;
}

export class PointerDispatcher {
  private readonly entries = new Map<string, PointerEntry>();
  /** 按优先级从高到低排序的活跃监听项 */
  private sortedEntries: PointerEntry[] = [];

  /**
   * 注册指针与滚轮监听项
   * @param id 唯一标识 (通常为插件 ID 或组件 ID)
   * @param hooks 交互钩子
   * @param priority 优先级权重 (默认 0，数值越大越先接收事件)
   * @returns 注销解绑函数
   */
  register(id: string, hooks: PointerHooks, priority = 0): () => void {
    this.entries.set(id, { id, hooks, priority });
    this.rebuildSortedEntries();

    return () => {
      this.unregister(id);
    };
  }

  /**
   * 注销指定监听项
   */
  unregister(id: string): boolean {
    const deleted = this.entries.delete(id);
    if (deleted) {
      this.rebuildSortedEntries();
    }
    return deleted;
  }

  // ================= 虚拟指针事件分发 =================

  dispatchPointerDown(e: CanvasPointerEvent): void {
    this.dispatch(e, (hooks) => hooks.onPointerDown);
  }

  dispatchPointerMove(e: CanvasPointerEvent): void {
    this.dispatch(e, (hooks) => hooks.onPointerMove);
  }

  dispatchPointerUp(e: CanvasPointerEvent): void {
    this.dispatch(e, (hooks) => hooks.onPointerUp);
  }

  dispatchWheel(e: CanvasWheelEvent): void {
    this.dispatch(e, (hooks) => hooks.onWheel);
  }

  /**
   * 清空全部监听项
   */
  clear(): void {
    this.entries.clear();
    this.sortedEntries = [];
  }

  get size(): number {
    return this.entries.size;
  }

  /**
   * 按优先级从高到低分发，任一监听者调用 stopPropagation 即截断后续分发
   * 以原事件为原型包装而非对象展开：展开会把 isClaimed 访问器求值成固定快照，
   * 导致高优先级插件 claimPointer 后，低优先级的框选/拖拽读到的仍是 false
   */
  private dispatch<TEvent extends { stopPropagation?(): void }>(
    event: TEvent,
    pickHandler: (hooks: PointerHooks) => ((e: TEvent) => void) | undefined
  ): void {
    let stopped = false;
    const wrapped: TEvent = Object.create(event, {
      stopPropagation: {
        value: () => {
          stopped = true;
          event.stopPropagation?.();
        }
      }
    });

    const entries = this.sortedEntries;
    for (let i = 0; i < entries.length && !stopped; i++) {
      const { hooks } = entries[i];
      pickHandler(hooks)?.call(hooks, wrapped);
    }
  }

  private rebuildSortedEntries(): void {
    this.sortedEntries = Array.from(this.entries.values()).sort((a, b) => b.priority - a.priority);
  }
}
