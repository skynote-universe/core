import { afterEach, describe, expect, it, vi } from 'vitest';
import { SkyNoteEngine } from '../src/engine';
import type { SkyNotePlugin } from '../src/protocols/plugin.protocol';

declare module '../src/protocols/event-hub.protocol' {
  interface CanvasEventMap {
    'test:ping': { readonly count: number };
  }
}

const engines: SkyNoteEngine[] = [];
afterEach(() => {
  engines.splice(0).forEach((engine) => engine.destroy());
  vi.restoreAllMocks();
});

describe('CanvasEventHub 统一低频事件中心', () => {
  it('内置事件自带说明，支持模块扩展强类型订阅、发布与异常隔离', () => {
    const engine = new SkyNoteEngine();
    engines.push(engine);

    const names = engine.events.list().map((item) => item.name);
    expect(names).toEqual(expect.arrayContaining(['host:change', 'asset:task', 'node:activate']));

    const received: number[] = [];
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const offBroken = engine.events.on('test:ping', () => {
      throw new Error('broken listener');
    });
    const offGood = engine.events.on('test:ping', ({ count }) => {
      received.push(count);
    });

    engine.events.emit('test:ping', { count: 1 });
    expect(received).toEqual([1]);

    offBroken();
    offGood();
    engine.events.emit('test:ping', { count: 2 });
    expect(received).toEqual([1]);
  });

  it('经插件上下文登记的事件说明与监听在插件卸载时自动清理', () => {
    const engine = new SkyNoteEngine();
    engines.push(engine);

    const received: number[] = [];
    const plugin: SkyNotePlugin = {
      id: 'test-events',
      name: '测试事件插件',
      version: '0.1.0',
      install(ctx) {
        ctx.events.define('test:ping', { description: '测试心跳事件', source: 'test-events' });
        ctx.events.on('test:ping', ({ count }) => received.push(count));
      }
    };

    engine.use(plugin);
    expect(engine.events.list()).toContainEqual({
      name: 'test:ping',
      description: '测试心跳事件',
      source: 'test-events'
    });

    engine.events.emit('test:ping', { count: 42 });
    expect(received).toEqual([42]);

    engine.plugins.remove('test-events');
    expect(engine.events.list().some((item) => item.name === 'test:ping')).toBe(false);

    engine.events.emit('test:ping', { count: 99 });
    expect(received).toEqual([42]);
  });

  it('引擎销毁后清空全部监听与事件登记', () => {
    const engine = new SkyNoteEngine();
    const received: string[] = [];
    engine.events.on('node:activate', ({ nodeId }) => received.push(nodeId));
    engine.destroy();

    expect(engine.events.list()).toEqual([]);
    engine.events.emit('node:activate', { nodeId: 'n1', nodeType: 'video', trigger: 'pointer' });
    expect(received).toEqual([]);
  });
});
