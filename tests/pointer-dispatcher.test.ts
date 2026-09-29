/**
 * @file pointer-dispatcher.test.ts
 * @description 指针分发器：独占认领在优先级链上实时可见、stopPropagation 截断、监听者 this 绑定
 */

import { describe, it, expect } from 'vitest';
import { PointerDispatcher } from '../src/input/pointer-dispatcher';
import { SyntheticPointerEvent, SyntheticWheelEvent } from '../src/input/synthetic-events';
import type { NodeEntity } from '../src/types/node';

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

    const event = new SyntheticPointerEvent({ point: { x: 0, y: 0 } });
    dispatcher.dispatchPointerDown(event);

    expect(log).toEqual([]);
    // 认领状态回写到原事件，宿主层同样可见
    expect(event.isClaimed).toBe(true);
  });

  it('stopPropagation 截断后续监听者，并透传给原事件', () => {
    const dispatcher = new PointerDispatcher();
    const log: string[] = [];
    let originStopped = false;

    dispatcher.register(
      'top',
      {
        onWheel: (e) => {
          log.push('top');
          e.stopPropagation?.();
        }
      },
      10
    );
    dispatcher.register('bottom', { onWheel: () => log.push('bottom') }, 0);

    const wheel = new SyntheticWheelEvent({ centerPoint: { x: 0, y: 0 }, deltaZoom: 0.1 });
    dispatcher.dispatchWheel({
      ...wheel,
      stopPropagation: () => {
        originStopped = true;
      }
    });

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

    dispatcher.dispatchPointerMove(new SyntheticPointerEvent({ point: { x: 1, y: 1 } }));
    expect(hooks.moves).toBe(1);
  });
});

describe('指针取消', () => {
  it('pointercancel 分发给 onPointerCancel，拖拽会话据此收尾', () => {
    const dispatcher = new PointerDispatcher();
    const calls: string[] = [];
    dispatcher.register('drag', {
      onPointerDown: () => calls.push('down'),
      onPointerCancel: () => calls.push('cancel')
    });
    dispatcher.dispatchPointerDown(new SyntheticPointerEvent({ point: { x: 0, y: 0 } }));
    dispatcher.dispatchPointerCancel(new SyntheticPointerEvent({ point: { x: 0, y: 0 } }));
    expect(calls).toEqual(['down', 'cancel']);
  });
});

describe('SyntheticPointerEvent', () => {
  it('经分发器原型包装后认领状态仍然共享：低优先级监听者与原事件都能看到', () => {
    const dispatcher = new PointerDispatcher();
    const seen: boolean[] = [];
    dispatcher.register('high', { onPointerDown: (e) => e.claimPointer('high') }, 10);
    dispatcher.register('low', { onPointerDown: (e) => seen.push(e.isClaimed) }, 0);
    const event = new SyntheticPointerEvent({ point: { x: 0, y: 0 } });
    dispatcher.dispatchPointerDown(event);
    expect(seen).toEqual([true]);
    expect(event.isClaimed).toBe(true);
    // 记录首个认领者，后续认领不覆盖
    event.claimPointer('other');
    expect(event.claimedBy).toBe('high');
  });

  it('延迟拾取：读取 target 时才计算，同一事件 (含各监听者的包装) 只计算一次', () => {
    const dispatcher = new PointerDispatcher();
    let calls = 0;
    const node = { id: 'n' } as NodeEntity;
    const targets: (NodeEntity | undefined)[] = [];
    dispatcher.register('a', { onPointerMove: (e) => targets.push(e.target) }, 1);
    dispatcher.register('b', { onPointerMove: (e) => targets.push(e.target) }, 0);
    const event = new SyntheticPointerEvent({ point: { x: 0, y: 0 }, resolveTarget: () => (calls++, node) });
    expect(calls).toBe(0);
    dispatcher.dispatchPointerMove(event);
    expect(targets).toEqual([node, node]);
    expect(calls).toBe(1);
  });
});
