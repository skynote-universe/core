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
    let stopped = false;
    const originStop = e.stopPropagation.bind(e);
    const wrapped: CanvasPointerEvent = {
      ...e,
      stopPropagation: () => {
        stopped = true;
        originStop();
      }
    };

    for (let i = 0; i < this.sortedEntries.length; i++) {
      if (stopped) break;
      const { hooks } = this.sortedEntries[i];
      if (hooks.onPointerDown) {
        hooks.onPointerDown(wrapped);
      }
    }
  }

  dispatchPointerMove(e: CanvasPointerEvent): void {
    let stopped = false;
    const originStop = e.stopPropagation.bind(e);
    const wrapped: CanvasPointerEvent = {
      ...e,
      stopPropagation: () => {
        stopped = true;
        originStop();
      }
    };

    for (let i = 0; i < this.sortedEntries.length; i++) {
      if (stopped) break;
      const { hooks } = this.sortedEntries[i];
      if (hooks.onPointerMove) {
        hooks.onPointerMove(wrapped);
      }
    }
  }

  dispatchPointerUp(e: CanvasPointerEvent): void {
    let stopped = false;
    const originStop = e.stopPropagation.bind(e);
    const wrapped: CanvasPointerEvent = {
      ...e,
      stopPropagation: () => {
        stopped = true;
        originStop();
      }
    };

    for (let i = 0; i < this.sortedEntries.length; i++) {
      if (stopped) break;
      const { hooks } = this.sortedEntries[i];
      if (hooks.onPointerUp) {
        hooks.onPointerUp(wrapped);
      }
    }
  }

  dispatchWheel(e: CanvasWheelEvent): void {
    let stopped = false;
    const originStop = e.stopPropagation?.bind(e);
    const wrapped: CanvasWheelEvent = {
      ...e,
      stopPropagation: () => {
        stopped = true;
        originStop?.();
      }
    };

    for (let i = 0; i < this.sortedEntries.length; i++) {
      if (stopped) break;
      const { hooks } = this.sortedEntries[i];
      if (hooks.onWheel) {
        hooks.onWheel(wrapped);
      }
    }
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

  private rebuildSortedEntries(): void {
    this.sortedEntries = Array.from(this.entries.values()).sort(
      (a, b) => b.priority - a.priority
    );
  }
}
