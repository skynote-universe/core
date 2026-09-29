/**
 * @file pointer-dispatcher.test.ts
 * @description 指针分发器：独占认领在优先级链上实时可见、stopPropagation 截断、监听者 this 绑定
 */

import { describe, it, expect } from 'vitest';
import { PointerDispatcher } from '../src/input/pointer-dispatcher';
import { createCanvasPointerEvent, createCanvasWheelEvent } from '../src/protocols/events.protocol';

describe('PointerDispatcher', () => {
  it('高优先级 claimPointer 后，低优先级监听者读到 isClaimed === true 并短路', () => {
    const dispatcher = new PointerDispatcher();
    const log: string[] = [];

    dispatcher.register('handle', { onPointerDown: (e) => e.claimPointer('handle') }, 100);
    dispatcher.register(
      'box-select',
      {
        onPointerDown: (e) => {
          if (e.isClaimed) return;
          log.push('box-select started');
        }
      },
      0
    );

    const event = createCanvasPointerEvent({ point: { x: 0, y: 0 } });
    dispatcher.dispatchPointerDown(event);

    expect(log).toEqual([]);
    // 认领状态回写到原事件，宿主层同样可见
    expect(event.isClaimed).toBe(true);
  });

  it('stopPropagation 截断后续监听者，并透传给原事件', () => {
    const dispatcher = new PointerDispatcher();
    const log: string[] = [];
    let originStopped = false;

    dispatcher.register('top', { onWheel: (e) => { log.push('top'); e.stopPropagation?.(); } }, 10);
    dispatcher.register('bottom', { onWheel: () => log.push('bottom') }, 0);

    const wheel = createCanvasWheelEvent({ centerPoint: { x: 0, y: 0 }, deltaZoom: 0.1 });
    dispatcher.dispatchWheel({ ...wheel, stopPropagation: () => { originStopped = true; } });

    expect(log).toEqual(['top']);
    expect(originStopped).toBe(true);
  });

  it('监听者以方法形式调用，保留 this 绑定', () => {
    const dispatcher = new PointerDispatcher();
    const hooks = {
      moves: 0,
      onPointerMove(): void {
        this.moves++;
      }
    };
    dispatcher.register('stateful', hooks);

    dispatcher.dispatchPointerMove(createCanvasPointerEvent({ point: { x: 1, y: 1 } }));
    expect(hooks.moves).toBe(1);
  });
});
