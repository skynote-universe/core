/**
 * @file patch-roundtrip.test.ts
 * @description 补丁往返性质测试：随机补丁序列正向执行后倒序回放逆向补丁，文档必须逐字节复原
 *
 * 用固定种子的伪随机数保证可复现；失败时输出种子与补丁序列即可定位。
 */

import { describe, it, expect } from 'vitest';
import { applyPatches } from '../src/operation/patch-applier';
import { OperationCoordinator } from '../src/operation/coordinator';
import { clonePlainData } from '../src/utils/clone';
import type { CanvasPatch } from '../src/types/operation';

/** mulberry32：极小的可复现伪随机数生成器 */
function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Fixture {
  nodes: Record<string, { x: number; label: string; style: Record<string, unknown>; tags: string[] }>;
}

const KEYS = ['fill', 'stroke', 'opacity', 'radius'];
const IDS = ['a', 'b', 'c', 'd'];

function pick<T>(random: () => number, list: readonly T[]): T {
  return list[Math.floor(random() * list.length)];
}

function createFixture(): Fixture {
  return {
    nodes: {
      a: { x: 0, label: 'hello', style: { fill: '#000' }, tags: ['t1'] },
      b: { x: 10, label: 'world', style: {}, tags: [] }
    }
  };
}

function randomPatch(random: () => number, doc: Fixture): CanvasPatch {
  const ids = Object.keys(doc.nodes);
  const existingId = ids.length > 0 ? pick(random, ids) : undefined;
  const roll = random();

  if (!existingId || roll < 0.15) {
    const id = pick(random, IDS);
    return { op: 'set', path: ['nodes', id], value: { x: Math.round(random() * 100), label: 'new', style: {}, tags: [] } };
  }
  if (roll < 0.25) {
    return { op: 'unset', path: ['nodes', existingId] };
  }
  if (roll < 0.45) {
    return { op: 'set', path: ['nodes', existingId, 'x'], value: Math.round(random() * 100) };
  }
  if (roll < 0.65) {
    const value: Record<string, unknown> = {};
    const count = 1 + Math.floor(random() * 3);
    for (let i = 0; i < count; i++) value[pick(random, KEYS)] = Math.round(random() * 10);
    return { op: 'set', path: ['nodes', existingId, 'style'], merge: true, value };
  }
  if (roll < 0.75) {
    return { op: 'unset', path: ['nodes', existingId, 'style', pick(random, KEYS)] };
  }
  if (roll < 0.88) {
    const tags = doc.nodes[existingId].tags;
    const index = Math.floor(random() * (tags.length + 1));
    const deleteCount = Math.floor(random() * (tags.length - index + 1));
    return { op: 'splice', path: ['nodes', existingId, 'tags'], index, deleteCount, items: ['x', 'y'].slice(0, Math.floor(random() * 3)) };
  }
  const label = doc.nodes[existingId].label;
  const retain = Math.floor(random() * (label.length + 1));
  const del = Math.floor(random() * (label.length - retain + 1));
  return { op: 'text', path: ['nodes', existingId, 'label'], deltas: [{ retain }, { delete: del }, { insert: 'ab' }] };
}

describe('补丁往返性质', () => {
  it('500 组随机补丁序列：正向执行后倒序回放逆向补丁，文档完全复原', () => {
    for (let seed = 1; seed <= 500; seed++) {
      const random = createRandom(seed);
      const doc = createFixture();
      // 按值比较而非 JSON 字符串：删除后恢复的键会排到对象末尾，实体集合的键序不承载语义（层叠由 zIndex 决定）
      const snapshots: Fixture[] = [];
      const inverses: CanvasPatch[][] = [];

      for (let step = 0; step < 12; step++) {
        snapshots.push(clonePlainData(doc));
        const patch = randomPatch(random, doc);
        const result = applyPatches(doc, [patch]);
        expect(result.success, `seed=${seed} step=${step} ${JSON.stringify(patch)}`).toBe(true);
        inverses.push(result.inversePatches);
      }

      for (let step = inverses.length - 1; step >= 0; step--) {
        const result = applyPatches(doc, [...inverses[step]].reverse());
        expect(result.success).toBe(true);
        expect(doc, `seed=${seed} undo step=${step}`).toEqual(snapshots[step]);
      }
    }
  });

  it('逆向补丁与文档零共享引用：回放后再修改文档不影响已生成的逆向补丁', () => {
    const doc = createFixture();
    const result = applyPatches(doc, [{ op: 'unset', path: ['nodes', 'a'] }]);
    const inverseSnapshot = clonePlainData(result.inversePatches);

    applyPatches(doc, result.inversePatches);
    doc.nodes.a.style.fill = 'mutated';
    doc.nodes.a.tags.push('mutated');

    expect(result.inversePatches).toEqual(inverseSnapshot);
  });

  it('500 组随机补丁以同一 groupId 连续提交：折叠压缩后撤销回到初态、重做回到终态', () => {
    for (let seed = 1; seed <= 500; seed++) {
      const random = createRandom(seed * 7919);
      const doc = createFixture();
      const initial = clonePlainData(doc);
      const coordinator = new OperationCoordinator(doc);

      for (let step = 0; step < 16; step++) {
        const record = coordinator.commitOperation({ groupId: 'group', patches: [randomPatch(random, doc)] });
        expect(record, `seed=${seed} step=${step}`).not.toBeNull();
      }
      const final = clonePlainData(doc);

      expect(coordinator.undo()).toBe(true);
      expect(doc, `seed=${seed} undo`).toEqual(initial);
      expect(coordinator.redo()).toBe(true);
      expect(doc, `seed=${seed} redo`).toEqual(final);
    }
  });
});

