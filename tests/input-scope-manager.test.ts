/**
 * @file input-scope-manager.test.ts
 * @description 键盘焦点栈：优先级消费、stopPropagation 截断且不改写宿主事件、IME 守卫
 */

import { describe, it, expect } from 'vitest';
import { InputScopeManager } from '../src/input/input-scope-manager';
import type { CanvasKeyboardEvent } from '../src/protocols/input-scope.protocol';

function createKeyEvent(overrides?: Partial<CanvasKeyboardEvent>): CanvasKeyboardEvent & { stops: number } {
  const event = {
    key: 'Delete',
    code: 'Delete',
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    isComposing: false,
    stops: 0,
    preventDefault: () => {},
    stopPropagation() {
      event.stops++;
    },
    ...overrides
  };
  return event;
}

describe('InputScopeManager', () => {
  it('stopPropagation 截断低优先级作用域并透传给原事件，且不改写宿主事件对象', () => {
    const manager = new InputScopeManager();
    const log: string[] = [];
    manager.pushScope({ id: 'top', priority: 10, onKeyDown: (e) => { log.push('top'); e.stopPropagation(); } });
    manager.pushScope({ id: 'bottom', priority: 0, onKeyDown: () => { log.push('bottom'); } });

    const event = createKeyEvent();
    const originalStop = event.stopPropagation;
    expect(manager.dispatchKeyDown(event)).toBe(true);

    expect(log).toEqual(['top']);
    expect(event.stops).toBe(1);
    expect(event.stopPropagation).toBe(originalStop);
  });

  it('未被消费时依次传递，返回 false 交由宿主保留默认行为', () => {
    const manager = new InputScopeManager();
    const log: string[] = [];
    manager.pushScope({ id: 'a', priority: 1, onKeyUp: () => { log.push('a'); } });
    manager.pushScope({ id: 'b', priority: 0, onKeyUp: () => { log.push('b'); } });

    expect(manager.dispatchKeyUp(createKeyEvent())).toBe(false);
    expect(log).toEqual(['a', 'b']);
  });

  it('输入法组合输入期间不触发任何作用域', () => {
    const manager = new InputScopeManager();
    let called = false;
    manager.pushScope({ id: 'global', priority: 0, onKeyDown: () => { called = true; return true; } });

    expect(manager.dispatchKeyDown(createKeyEvent({ isComposing: true }))).toBe(false);
    expect(manager.dispatchKeyDown(createKeyEvent({ keyCode: 229 }))).toBe(false);
    expect(called).toBe(false);
  });
});
