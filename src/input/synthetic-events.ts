/**
 * @file synthetic-events.ts
 * @description 归一化虚拟事件的标准实现 (宿主桥接与测试共用)
 *
 * 设计考量 (Why):
 * 1. 类而非对象字面量：方法定义在原型上，高频 pointermove 不再为每个事件新建一组闭包。
 * 2. 可变状态放在独立的状态对象里：PointerDispatcher 以原事件为原型包装后再交给各监听者，
 *    认领与拾取状态若写在事件自身字段上，会落到包装对象上而与原事件分叉；
 *    放在共享状态对象中，经原型链读写的始终是同一份 (因此不用 #私有字段：原型包装对象无法访问)。
 * 3. 命中节点按需计算：多数移动监听者不读 target，拾取延迟到首次读取，且同一事件只算一次。
 */

import type { Point } from '../types/canvas';
import type { NodeEntity } from '../types/node';
import type { CanvasPointerEvent, CanvasWheelEvent, EventModifiers } from '../protocols/events.protocol';

interface PointerEventState {
  /** 首个认领者 (便于排查认领冲突)；null 表示未被认领 */
  claimedBy: string | null;
  target: NodeEntity | undefined;
  targetResolved: boolean;
}

export interface SyntheticPointerEventInit {
  point: Point;
  /** 相对视口容器的像素坐标；缺省与 point 相同 (视口为单位矩阵时) */
  clientPoint?: Point;
  pointerId?: number;
  button?: number;
  modifiers?: Partial<EventModifiers>;
  pressure?: number;
  /** 已知的命中节点；与 resolveTarget 二选一 */
  target?: NodeEntity;
  /** 延迟拾取：首次读取 target 时调用 */
  resolveTarget?: () => NodeEntity | undefined;
  /** 转发到宿主原生事件的 stopPropagation */
  onStopPropagation?: () => void;
}

export class SyntheticPointerEvent implements CanvasPointerEvent {
  readonly point: Point;
  readonly clientPoint: Point;
  readonly pointerId: number;
  readonly button: number;
  readonly modifiers: EventModifiers;
  readonly pressure: number;
  private readonly state: PointerEventState;
  private readonly resolveTarget: (() => NodeEntity | undefined) | undefined;
  private readonly onStopPropagation: (() => void) | undefined;

  constructor(init: SyntheticPointerEventInit) {
    this.point = init.point;
    this.clientPoint = init.clientPoint ?? init.point;
    this.pointerId = init.pointerId ?? 0;
    this.button = init.button ?? 0;
    this.modifiers = {
      shift: init.modifiers?.shift ?? false,
      alt: init.modifiers?.alt ?? false,
      ctrl: init.modifiers?.ctrl ?? false,
      meta: init.modifiers?.meta ?? false
    };
    this.pressure = init.pressure ?? 0.5;
    this.resolveTarget = init.resolveTarget;
    this.onStopPropagation = init.onStopPropagation;
    this.state = { claimedBy: null, target: init.target, targetResolved: init.resolveTarget === undefined };
  }

  get target(): NodeEntity | undefined {
    const { state } = this;
    if (!state.targetResolved) {
      state.target = this.resolveTarget!();
      state.targetResolved = true;
    }
    return state.target;
  }

  get isClaimed(): boolean {
    return this.state.claimedBy !== null;
  }

  /** 认领该指针会话的认领者 (未认领为 null) */
  get claimedBy(): string | null {
    return this.state.claimedBy;
  }

  claimPointer(claimerId: string): void {
    this.state.claimedBy ??= claimerId;
  }

  stopPropagation(): void {
    this.onStopPropagation?.();
  }
}

export interface SyntheticWheelEventInit {
  centerPoint: Point;
  deltaPan?: Point;
  deltaZoom?: number;
  isGesture?: boolean;
  onStopPropagation?: () => void;
}

export class SyntheticWheelEvent implements CanvasWheelEvent {
  readonly centerPoint: Point;
  readonly deltaPan: Point;
  readonly deltaZoom: number;
  readonly isGesture: boolean;
  private readonly onStopPropagation: (() => void) | undefined;

  constructor(init: SyntheticWheelEventInit) {
    this.centerPoint = init.centerPoint;
    this.deltaPan = init.deltaPan ?? { x: 0, y: 0 };
    this.deltaZoom = init.deltaZoom ?? 0;
    this.isGesture = init.isGesture ?? false;
    this.onStopPropagation = init.onStopPropagation;
  }

  stopPropagation(): void {
    this.onStopPropagation?.();
  }
}
