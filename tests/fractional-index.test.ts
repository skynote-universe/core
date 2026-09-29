/**
 * @file fractional-index.test.ts
 * @description 分数索引：区间插入、两端追加、批量生成、格式校验与并列决胜
 */

import { describe, it, expect } from 'vitest';
import {
  generateKeyBetween,
  generateNKeysBetween,
  isValidFractionalIndex,
  compareFractionalIndex,
  FIRST_FRACTIONAL_INDEX
} from '../src/utils/fractional-index';

function createRandom(seed: number): () => number {
  let state = seed;
  return () => (state = (state * 16807) % 2147483647) / 2147483647;
}

describe('分数索引', () => {
  it('空序列、两端追加与区间插入均严格保序', () => {
    expect(generateKeyBetween(null, null)).toBe(FIRST_FRACTIONAL_INDEX);
    expect(generateKeyBetween('a0', null)).toBe('a1');
    expect(generateKeyBetween(null, 'a0')).toBe('Zz');
    const between = generateKeyBetween('a0', 'a1');
    expect('a0' < between && between < 'a1').toBe(true);
    expect(() => generateKeyBetween('a1', 'a0')).toThrow();
  });

  it('随机插入 2000 次：任意位置插入后序列始终严格递增且键合法', () => {
    const random = createRandom(11);
    const keys: string[] = [FIRST_FRACTIONAL_INDEX];
    for (let i = 0; i < 2000; i++) {
      const position = Math.floor(random() * (keys.length + 1));
      const key = generateKeyBetween(keys[position - 1] ?? null, keys[position] ?? null);
      expect(isValidFractionalIndex(key)).toBe(true);
      keys.splice(position, 0, key);
    }
    for (let i = 1; i < keys.length; i++) {
      expect(keys[i - 1] < keys[i]).toBe(true);
    }
  });

  it('两端追加键长几乎不增长；同一位置反复插入时键长缓慢增长', () => {
    let top = FIRST_FRACTIONAL_INDEX;
    for (let i = 0; i < 1000; i++) top = generateKeyBetween(top, null);
    expect(top.length).toBeLessThanOrEqual(4);

    let low = 'a0';
    const high = 'a1';
    for (let i = 0; i < 100; i++) low = generateKeyBetween(low, high);
    // 每次插值约增长 1/log2(62) 个字符
    expect(low.length).toBeLessThan(25);
  });

  it('批量生成 n 个递增键，保持多选的相对顺序', () => {
    const keys = generateNKeysBetween('a0', 'a1', 7);
    expect(keys).toHaveLength(7);
    expect(['a0', ...keys, 'a1']).toEqual([...['a0', ...keys, 'a1']].sort());
    expect(generateNKeysBetween(null, 'a0', 3).every((key) => key < 'a0')).toBe(true);
  });

  it('格式校验拒绝非字符串、非法字符、尾随 0 与整数部分残缺', () => {
    for (const bad of [1, '', 'a', 'a0!', 'a10', 'b1']) {
      expect(isValidFractionalIndex(bad)).toBe(false);
    }
    for (const good of ['a0', 'a1V', 'Zz', 'b10']) {
      expect(isValidFractionalIndex(good)).toBe(true);
    }
  });

  it('键相同时按 id 决胜，各客户端排序一致', () => {
    expect(compareFractionalIndex('a1', 'x', 'a2', 'a')).toBeLessThan(0);
    expect(compareFractionalIndex('a1', 'b', 'a1', 'a')).toBeGreaterThan(0);
    expect(compareFractionalIndex('a1', 'a', 'a1', 'a')).toBe(0);
  });
});
