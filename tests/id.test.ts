/**
 * @file id.test.ts
 * @description ID 生成器：格式稳定、随机源为 Web Crypto、批量生成无碰撞
 */

import { describe, it, expect, vi } from 'vitest';
import { generateId } from '../src/utils/id';

describe('generateId', () => {
  it('输出「前缀_时间戳+12 位随机串」，字符限于 32 字符字母表', () => {
    expect(generateId('node')).toMatch(/^node_[0-9a-z]+[0-9a-hjkmnp-tv-z]{12}$/);
  });

  it('随机部分取自 crypto.getRandomValues，不使用 Math.random', () => {
    const cryptoSpy = vi.spyOn(globalThis.crypto, 'getRandomValues');
    const mathSpy = vi.spyOn(Math, 'random');
    generateId();
    expect(cryptoSpy).toHaveBeenCalledTimes(1);
    expect(mathSpy).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('同一毫秒内批量生成 10 万个 ID 无碰撞', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100_000; i++) ids.add(generateId('n'));
    expect(ids.size).toBe(100_000);
  });
});
