/**
 * @file patch-applier.test.ts
 * @description 现代化正交原子补丁 (set/unset/splice/text) 与逆向推导器单元测试
 */

import { describe, it, expect } from 'vitest';
import { applyPatch, applyPatches } from '../src/operation/patch-applier';
import { getValueByPath, normalizePatchPath } from '../src/operation/patch-path';

describe('PatchPath', () => {
  it('正确解析点号分词与纯数字下标', () => {
    expect(normalizePatchPath('content.nodes.0.x')).toEqual(['content', 'nodes', 0, 'x']);
    expect(normalizePatchPath(['content', 'nodes', 1, 'y'])).toEqual(['content', 'nodes', 1, 'y']);
  });

  it('读取深层属性值', () => {
    const doc = {
      viewport: { zoom: 1.5 },
      content: {
        nodes: [{ id: 'n1', x: 100 }]
      }
    };
    expect(getValueByPath(doc, 'viewport.zoom')).toBe(1.5);
    expect(getValueByPath(doc, 'content.nodes.0.id')).toBe('n1');
    expect(getValueByPath(doc, 'content.nodes.0.x')).toBe(100);
    expect(getValueByPath(doc, 'content.nodes.1')).toBeUndefined();
  });

  it('防原型链污染：禁止访问 __proto__ / prototype / constructor', () => {
    const doc = {};
    expect(getValueByPath(doc, '__proto__.polluted')).toBeUndefined();
    expect(getValueByPath(doc, 'constructor.name')).toBeUndefined();
  });
});

describe('PatchApplier 正交原子操作', () => {
  it('set (直接覆盖): 存在时替换并推导对偶 set 逆向补丁', () => {
    const target = { style: { fill: '#ffffff' } };
    const res = applyPatch(target, {
      op: 'set',
      path: 'style.fill',
      value: '#ff0000'
    });

    expect(res.success).toBe(true);
    expect(target.style.fill).toBe('#ff0000');
    expect(res.inversePatch).toEqual({
      op: 'set',
      path: 'style.fill',
      value: '#ffffff',
      oldValue: '#ff0000'
    });

    // 执行逆向补丁应完美复原
    const undoRes = applyPatch(target, res.inversePatch);
    expect(undoRes.success).toBe(true);
    expect(target.style.fill).toBe('#ffffff');
  });

  it('set (全新属性): 原先不存在时写入，逆向自动推导为 unset', () => {
    const target: Record<string, unknown> = {};
    const res = applyPatch(target, {
      op: 'set',
      path: 'customTag',
      value: 'important'
    });

    expect(res.success).toBe(true);
    expect(target.customTag).toBe('important');
    // 逆向补丁必须是 unset，确保撤销时彻底清理该 key
    expect(res.inversePatch).toEqual({
      op: 'unset',
      path: 'customTag'
    });

    // 撤销回滚
    applyPatch(target, res.inversePatch);
    expect(Object.prototype.hasOwnProperty.call(target, 'customTag')).toBe(false);
  });

  it('set (merge: true): 字典增量浅合并并精准生成逆向覆盖字典', () => {
    const target = {
      style: { fill: '#111111', stroke: '#222222', strokeWidth: 1 }
    };

    const res = applyPatch(target, {
      op: 'set',
      path: 'style',
      merge: true,
      value: { fill: '#333333', strokeWidth: 2 }
    });

    expect(res.success).toBe(true);
    expect(target.style.fill).toBe('#333333');
    expect(target.style.strokeWidth).toBe(2);
    expect(target.style.stroke).toBe('#222222');

    // 逆向补丁为带 merge: true 的旧值字典
    expect(res.inversePatch).toEqual({
      op: 'set',
      path: 'style',
      merge: true,
      value: { fill: '#111111', strokeWidth: 1 }
    });

    // 逆向回滚
    applyPatch(target, res.inversePatch);
    expect(target.style.fill).toBe('#111111');
    expect(target.style.strokeWidth).toBe(1);
  });

  it('unset: 移除属性并生成对偶 set 恢复补丁', () => {
    const target: Record<string, unknown> = { theme: 'dark', version: 1 };
    const res = applyPatch(target, {
      op: 'unset',
      path: 'theme'
    });

    expect(res.success).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(target, 'theme')).toBe(false);
    expect(res.inversePatch).toEqual({
      op: 'set',
      path: 'theme',
      value: 'dark'
    });

    // 逆向回滚
    applyPatch(target, res.inversePatch);
    expect(target.theme).toBe('dark');
  });

  it('splice: 数组插入/删除与对偶逆向复原', () => {
    const list = [1, 2, 5];
    const target = { items: list };

    // 在下标 2 处插入 3, 4
    const res = applyPatch(target, {
      op: 'splice',
      path: 'items',
      index: 2,
      deleteCount: 0,
      items: [3, 4]
    });

    expect(res.success).toBe(true);
    expect(target.items).toEqual([1, 2, 3, 4, 5]);

    // 逆向补丁应为在下标 2 处删除 2 个元素
    expect(res.inversePatch).toEqual({
      op: 'splice',
      path: 'items',
      index: 2,
      deleteCount: 2,
      items: [],
      deletedItems: [3, 4]
    });

    // 执行逆向补丁
    applyPatch(target, res.inversePatch);
    expect(target.items).toEqual([1, 2, 5]);
  });

  it('text: 流式 Delta 字符级插入与删除，自动生成对偶反向 Delta', () => {
    const target = { content: 'Hello World' };

    // 插入 " Great" -> "Hello Great World"
    const insertRes = applyPatch(target, {
      op: 'text',
      path: 'content',
      deltas: [{ retain: 5 }, { insert: ' Great' }]
    });

    expect(insertRes.success).toBe(true);
    expect(target.content).toBe('Hello Great World');
    expect(insertRes.inversePatch).toEqual({
      op: 'text',
      path: 'content',
      deltas: [{ retain: 5 }, { delete: 6 }]
    });

    // 逆向回滚
    applyPatch(target, insertRes.inversePatch);
    expect(target.content).toBe('Hello World');

    // 删除 " World" -> "Hello"
    const deleteRes = applyPatch(target, {
      op: 'text',
      path: 'content',
      deltas: [{ retain: 5 }, { delete: 6 }]
    });

    expect(deleteRes.success).toBe(true);
    expect(target.content).toBe('Hello');
    expect(deleteRes.inversePatch).toEqual({
      op: 'text',
      path: 'content',
      deltas: [{ retain: 5 }, { insert: ' World' }]
    });

    // 逆向回滚
    applyPatch(target, deleteRes.inversePatch);
    expect(target.content).toBe('Hello World');
  });

  it('applyPatches: 批量执行中途出错时倒序原子回滚', () => {
    const target = {
      x: 10,
      y: 20
    };

    const patches = [
      { op: 'set' as const, path: 'x', value: 100 },
      { op: 'set' as const, path: 'y', value: 200 },
      // 无法定位的非法路径触发失败
      { op: 'splice' as const, path: 'non_existent_arr', index: 0, deleteCount: 1 }
    ];

    const res = applyPatches(target, patches);
    expect(res.success).toBe(false);
    expect(res.failedIndex).toBe(2);

    // 验证回滚是否将 x 和 y 还原为初始值
    expect(target.x).toBe(10);
    expect(target.y).toBe(20);
  });
});
