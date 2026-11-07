import { describe, expect, it, vi } from 'vitest';
import { SkyNoteEngine } from '../src/engine';
import { DETACHED_CANVAS_HOST } from '../src/protocols/host.protocol';
import type { CanvasPluginContext } from '../src/protocols/plugin.protocol';

function host() {
  return {
    ...DETACHED_CANVAS_HOST,
    capturePointer: vi.fn(),
    releasePointer: vi.fn(),
    overlay: { setPrimitives: vi.fn(), clear: vi.fn() }
  };
}

describe('插件宿主生命周期', () => {
  it('同一个宿主对象重新挂载后旧句柄失效，当前句柄重复卸载不重复通知', () => {
    const engine = new SkyNoteEngine();
    const active = host();
    const listener = vi.fn();
    engine.onHostChange(listener);
    const detachOld = engine.attachHost(active);
    const detachCurrent = engine.attachHost(active);
    listener.mockClear();
    detachOld();
    expect(engine.host).toBe(active);
    expect(listener).not.toHaveBeenCalled();
    detachCurrent();
    detachCurrent();
    expect(engine.host).toBe(DETACHED_CANVAS_HOST);
    expect(listener.mock.calls).toEqual([[false]]);
    engine.destroy();
  });

  it('已卸载宿主再次挂载后旧句柄仍失效，引擎销毁使当前句柄失效', () => {
    const engine = new SkyNoteEngine();
    const active = host();
    const detachOld = engine.attachHost(active);
    detachOld();
    const detachCurrent = engine.attachHost(active);
    const listener = vi.fn();
    engine.onHostChange(listener);
    detachOld();
    expect(engine.host).toBe(active);
    expect(listener).not.toHaveBeenCalled();
    engine.destroy();
    expect(listener.mock.calls).toEqual([[false]]);
    detachCurrent();
    expect(listener.mock.calls).toEqual([[false]]);
    expect(engine.host).toBe(DETACHED_CANVAS_HOST);
  });

  it('未订阅宿主变化的既有插件仍可在unmount中释放旧宿主资源', () => {
    const engine = new SkyNoteEngine();
    const active = host();
    let context!: CanvasPluginContext;
    engine.use({
      id: 'legacy-cleanup',
      name: '既有释放行为',
      version: 'test',
      install(ctx) {
        context = ctx;
      },
      unmount() {
        context.host.releasePointer(9);
      }
    });
    engine.attachHost(active);
    engine.destroy();
    expect(active.releasePointer).toHaveBeenCalledWith(9);
    expect(engine.host).toBe(DETACHED_CANVAS_HOST);
  });

  it('销毁引擎时在旧宿主上完成最终清理，再切回空宿主', () => {
    const engine = new SkyNoteEngine();
    const active = host();
    engine.attachHost(active);
    engine.onHostChange((available) => {
      if (!available) engine.host.releasePointer(7);
    });
    engine.destroy();
    expect(active.releasePointer).toHaveBeenCalledWith(7);
    expect(engine.host).toBe(DETACHED_CANVAS_HOST);
    engine.destroy();
    expect(active.releasePointer).toHaveBeenCalledTimes(1);
  });

  it('在旧宿主上回收资源，再在新宿主上重绘；旧卸载函数不会释放新宿主', () => {
    const engine = new SkyNoteEngine();
    const states: boolean[] = [];
    engine.use({
      id: 'persistent-controls',
      name: '持久控件',
      version: 'test',
      install(ctx) {
        ctx.onHostChange((available) => {
          states.push(available);
          if (available) {
            ctx.host.capturePointer(7);
            ctx.host.overlay.setPrimitives('controls', [{ kind: 'circle', cx: 0, cy: 0, r: 10 }]);
          } else ctx.host.releasePointer(7);
        });
      }
    });
    const first = host(),
      second = host();
    const detachFirst = engine.attachHost(first);
    const detachSecond = engine.attachHost(second);
    expect(first.releasePointer).toHaveBeenCalledTimes(1);
    expect(first.overlay.setPrimitives).toHaveBeenCalledTimes(1);
    expect(second.overlay.setPrimitives).toHaveBeenCalledTimes(1);
    detachFirst();
    expect(engine.host).toBe(second);
    expect(second.releasePointer).not.toHaveBeenCalled();
    detachSecond();
    expect(second.releasePointer).toHaveBeenCalledWith(7);
    expect(engine.host).toBe(DETACHED_CANVAS_HOST);
    expect(states).toEqual([false, true, false, true, false]);
    engine.destroy();
  });

  it('宿主订阅随插件卸载释放，不残留重绘回调', () => {
    const engine = new SkyNoteEngine();
    const listener = vi.fn();
    engine.use({
      id: 'observer',
      name: '订阅',
      version: 'test',
      install: (ctx) => {
        ctx.onHostChange(listener);
      }
    });
    engine.attachHost(host());
    expect(listener).toHaveBeenCalledTimes(2);
    engine.plugins.remove('observer');
    engine.attachHost(host());
    expect(listener).toHaveBeenCalledTimes(2);
    engine.destroy();
  });

  it('单个插件回调异常不会阻断其他插件或宿主挂载', () => {
    const engine = new SkyNoteEngine();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const release = engine.onHostChange(() => {
      throw new Error('绘制失败');
    });
    const listener = vi.fn();
    const stop = engine.onHostChange(listener);
    const next = host();
    try {
      expect(() => engine.attachHost(next)).not.toThrow();
      expect(engine.host).toBe(next);
      expect(listener.mock.calls).toEqual([[false], [true]]);
    } finally {
      release();
      stop();
      logged.mockRestore();
      engine.destroy();
    }
  });
});
