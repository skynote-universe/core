/**
 * @file events.protocol.ts
 * @description 宿主无关归一化虚拟事件规范
 *
 * 设计考量 (Why):
 * 1. 平台中立红线：插件严禁感知原生 clientX/Y，事件直接派发已解算完成的世界逻辑坐标 point。
 * 2. 交互零耦合 (Pointer Claiming)：通过 claimPointer() 实现独占指针会话，单元格或导图节点认领后，外部通用拖拽/框选自动短路放弃，无需跨插件探测状态。
 */

import type { Point, NodeEntity } from '../types';

/** 修饰键状态掩码 */
export interface EventModifiers {
  readonly shift: boolean;
  readonly alt: boolean;
  readonly ctrl: boolean;
  readonly meta: boolean;
}

/**
 * 归一化虚拟指针事件 (CanvasPointerEvent)
 */
export interface CanvasPointerEvent {
  /** 纯逻辑世界坐标 (已自动剥离平移与缩放矩阵，真实画布物理位置) */
  readonly point: Point;

  /** 相对视口容器的视口像素坐标 (仅用于定位右键菜单、浮动工具栏等 DOM 覆盖层) */
  readonly clientPoint: Point;

  /** 拾取命中的节点实体引用 (若点击在空白处则为 undefined) */
  readonly target?: Readonly<NodeEntity>;

  /** 原始指针唯一 ID */
  readonly pointerId: number;

  /** 按键识别: 0 主键(左键), 1 中键, 2 次键(右键) */
  readonly button: number;

  /** 键盘修饰键 */
  readonly modifiers: EventModifiers;

  /** 笔压感 (0.0 ~ 1.0，手写笔专用，鼠标恒为 0.5) */
  readonly pressure: number;

  /** 按下的连击序号：1 单击、2 双击、3 三击 (间隔与位移都在阈值内的连续按下)；移动与抬起沿用按下时的值 */
  readonly clickCount: number;

  /** 当前事件是否已被某个上层交互认领 */
  readonly isClaimed: boolean;

  /**
   * 独占认领指针会话 (Pointer Claiming)
   * 当表格单元格、导图连接桩认领后，外层通用拖拽/框选见 isClaimed === true 必须自动短路退出。
   * @param claimerId 认领者语义标识 (例如 'table:cell-select')
   */
  claimPointer(claimerId: string): void;

  /** 阻止事件在图元树中继续向上传播 */
  stopPropagation(): void;
}

/**
 * 归一化滚轮与缩放手势事件 (CanvasWheelEvent)
 */
export interface CanvasWheelEvent {
  /** 世界坐标系下的缩放中心点 */
  readonly centerPoint: Point;

  /** 归一化后的平移量 (已做平台平滑滤波，抹平 Windows 机械滚轮与 Mac 触控板差异) */
  readonly deltaPan: Point;

  /**
   * 对数刻度的缩放增量：缩放倍率 = Math.exp(deltaZoom)，正数放大、负数缩小
   * 对数刻度下多次增量可直接相加 (宿主按帧合并滚轮时结果不变)，且快速滚动也不会得到负倍率
   */
  readonly deltaZoom: number;

  /** 是否由触控板双指捏合 (Pinch) 触发 */
  readonly isGesture: boolean;

  /** 阻止滚轮/缩放事件向底层冒泡 (防止局部滚动容器穿透触发全画板缩放平移) */
  stopPropagation?(): void;
}
