/**
 * @file engine.bench.test.ts
 * @description 大画布性能基准：单次提交开销必须与画布总规模无关
 *
 * 运行：pnpm --filter @skynote/core bench（不随 pnpm test 执行，避免机器负载导致单测抖动）
 * 预算按实测值 (约 5~20µs) 放宽约 50 倍：一旦超出，几乎可以断定某处重新引入了 O(N) 全量扫描。
 */

import { describe, it, expect } from 'vitest';
import { SkyNoteEngine } from '../src/engine';
import type { CanvasPatch } from '../src/types/operation';
import type { NodeEntity } from '../src/types/node';

const NODE_COUNT = 50_000;
const ITERATIONS = 200;
const BUDGET_MS_PER_COMMIT = 1;

function createLargeEngine(): SkyNoteEngine {
  const engine = new SkyNoteEngine();
  const patches: CanvasPatch[] = [];
  for (let i = 0; i < NODE_COUNT; i++) {
    const node: NodeEntity = {
      id: `n${i}`,
      type: 'node',
      nodeType: 'rect',
      x: (i % 500) * 30,
      y: Math.floor(i / 500) * 30,
      width: 20,
      height: 20,
      rotation: 0,
      zIndex: 'a0',
      locked: false,
      style: {}
    };
    patches.push({ op: 'set', path: ['content', 'nodes', node.id], value: node });
  }
  engine.documentStore.commit({ patches, undoable: false });
  return engine;
}

function measure(label: string, run: (i: number) => void): number {
  // 预热，排除 JIT 编译抖动
  for (let i = 0; i < 20; i++) run(i);
  const start = performance.now();
  for (let i = 0; i < ITERATIONS; i++) run(i);
  const perCommit = (performance.now() - start) / ITERATIONS;
  console.info(`[bench] ${label}: ${(perCommit * 1000).toFixed(1)}µs / 次`);
  return perCommit;
}

describe(`单次提交开销 (${NODE_COUNT} 节点)`, () => {
  const engine = createLargeEngine();
  const store = engine.documentStore;

  it('拖拽单节点 (groupId 折叠)', () => {
    expect(
      measure('拖拽单节点', () => store.moveNode('n100', { x: 1 }, { groupId: 'drag' }))
    ).toBeLessThan(BUDGET_MS_PER_COMMIT);
  });

  it('修改单节点样式', () => {
    expect(
      measure('修改单节点样式', (i) => store.updateNode('n100', { style: { fill: String(i) } }))
    ).toBeLessThan(BUDGET_MS_PER_COMMIT);
  });
});
