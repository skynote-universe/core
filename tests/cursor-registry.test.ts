/**
 * @file cursor-registry.test.ts
 * @description 光标注册表：内置自绘光标、带角度光标的取整、覆盖与恢复、统一配色
 */

import { describe, it, expect, vi } from 'vitest';
import { CursorRegistry } from '../src/registry/cursor-registry';
import type { CursorDefinition } from '../src/protocols/cursor.protocol';

const dot = (id: string, color = '{ink}'): CursorDefinition => ({
  id,
  svg: `<circle cx="16" cy="16" r="4" fill="${color}"/>`,
  hotspot: { x: 16, y: 16 },
  fallback: 'default'
});

describe('CursorRegistry', () => {
  it('内置光标全部自绘：完整的 32×32 SVG，颜色按配色替换，带热点与退路', () => {
    const registry = new CursorRegistry();
    for (const id of ['default', 'move', 'crosshair', 'text', 'grab', 'grabbing', 'resize', 'rotate']) {
      const rendered = registry.render(id)!;
      expect(rendered.svg).toMatch(/^<svg [^>]*width="32" height="32"/);
      expect(rendered.svg).not.toContain('{ink}');
      expect(rendered.svg).not.toContain('{halo}');
    }
    expect(registry.render('default')).toMatchObject({ hotspot: { x: 6, y: 5 }, fallback: 'default' });
    // 柔和投影包在旋转之外：任何角度的阴影都朝下；可关闭
    const rotated = registry.render({ kind: 'resize', angle: 90 })!.svg;
    expect(rotated.indexOf('filter="url(#cursor-shadow)"')).toBeLessThan(rotated.indexOf('rotate(90'));
    registry.setStyle({ shadow: false });
    expect(registry.render('default')!.svg).not.toContain('cursor-shadow');
  });

  it('带角度的光标按 5° 取整旋转；不可旋转的光标忽略角度；未注册的 id 返回 undefined', () => {
    const registry = new CursorRegistry();
    expect(registry.render({ kind: 'resize', angle: 37 })!.svg).toContain('rotate(35 16 16)');
    expect(registry.render({ kind: 'resize', angle: -90 })!.svg).toContain('rotate(270 16 16)');
    expect(registry.render({ kind: 'resize', angle: 360 })!.svg).not.toContain('rotate(');
    expect(registry.render({ kind: 'move', angle: 45 })!.svg).not.toContain('rotate(');
    expect(registry.render('pointer')).toBeUndefined();
  });

  it('覆盖内置光标：多次覆盖按任意顺序恢复，生效的始终是仍在的最后一次注册，全部恢复后回到内置', () => {
    const registry = new CursorRegistry();
    const builtIn = registry.get('default');
    const restoreA = registry.register(dot('default'));
    const restoreB = registry.register(dot('default', 'red'));
    restoreA();
    expect(registry.render('default')!.svg).toContain('fill="red"');
    restoreB();
    expect(registry.get('default')).toBe(builtIn);

    const restoreNew = registry.register(dot('eraser'));
    expect(registry.render('eraser')).toBeDefined();
    restoreNew();
    expect(registry.render('eraser')).toBeUndefined();
  });

  it('统一配色对整套光标 (含新注册的) 生效；每次变化通知订阅者，缓存键随之改变', () => {
    const registry = new CursorRegistry();
    registry.register(dot('eraser'));
    const listener = vi.fn();
    registry.subscribe(listener);
    const before = registry.render('move')!.key;
    registry.setStyle({ ink: 'navy', halo: 'ivory' });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(registry.render('move')!.svg).toContain('fill="navy" stroke="ivory"');
    expect(registry.render('eraser')!.svg).toContain('fill="navy"');
    expect(registry.render('move')!.key).not.toBe(before);

    registry.clear();
    expect(registry.style).toEqual({ ink: 'black', halo: 'white', shadow: true });
    expect(registry.render('eraser')).toBeUndefined();
  });
});
