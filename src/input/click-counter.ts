/**
 * @file click-counter.ts
 * @description 连击判定：宿主在每次按下时询问，得到双击、三击等连击序号
 *
 * 设计考量 (Why):
 * 1. 平台中立：只依赖屏幕坐标与时间戳，各宿主 (浏览器、小程序) 共用同一套阈值，双击选词的手感一致。
 * 2. 位移按屏幕像素判断：缩放画布不影响连击的容差。
 */

import type { Point } from '../types/geometry';

/** 两次按下间隔超过该值不算连击 (毫秒) */
const CLICK_INTERVAL_MS = 500;
/** 两次按下相距超过该值不算连击 (屏幕像素) */
const CLICK_SLOP_PX = 4;

export class ClickCounter {
  private last: { time: number; point: Point; button: number; count: number } | null = null;

  /** 记录一次按下，返回其连击序号 (1 起) */
  press(clientPoint: Point, button: number, time: number): number {
    const { last } = this;
    const continues =
      last !== null &&
      last.button === button &&
      time - last.time <= CLICK_INTERVAL_MS &&
      Math.hypot(clientPoint.x - last.point.x, clientPoint.y - last.point.y) <= CLICK_SLOP_PX;
    const count = continues ? last.count + 1 : 1;
    this.last = { time, point: clientPoint, button, count };
    return count;
  }
}
