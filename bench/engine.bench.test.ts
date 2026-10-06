/**
 * @file engine.bench.test.ts
 * @description 大画布性能基准：单次提交开销必须与画布总规模无关
 *
 * 运行：pnpm --filter @skynote/core bench（不随 pnpm test 执行，避免机器负载导致单测抖动）
 * 预算按实测值 (约 10~100µs，随机器负载波动) 放宽约 10 倍：一旦超出，几乎可以断定某处重新引入了 O(N) 全量扫描。
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
  // 充分预热，让新增的代码路径完成优化编译后再计时，排除 JIT 抖动
  for (let i = 0; i < 300; i++) run(i);
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
      measure('拖拽单节点', () => store.moveEntities({ nodeIds: ['n100'] }, { x: 1 }, { groupId: 'drag' }))
    ).toBeLessThan(BUDGET_MS_PER_COMMIT);
  });

  it('视锥查询：1920×1080 视口在画布中平移 (每次命中约 2300 个节点)', () => {
    const { spatialIndex } = engine;
    let hits = 0;
    const perQuery = measure('视锥查询', (i) => {
      const left = (i % 50) * 100;
      const top = (i % 20) * 100;
      hits = spatialIndex.search({ left, top, right: left + 1920, bottom: top + 1080 }).length;
    });
    expect(hits).toBeGreaterThan(2000);
    // 迁移验收清单：5000 节点下视锥查询不超过 2ms；这里在 5 万节点上要求同样的预算
    expect(perQuery).toBeLessThan(2);
  });

  it('修改单节点样式', () => {
    expect(measure('修改单节点样式', (i) => store.updateNode('n100', { style: { fill: String(i) } }))).toBeLessThan(
      BUDGET_MS_PER_COMMIT
    );
  });

  it('多选拖拽 2000 个节点 (同组折叠 60 帧)', () => {
    const ids = Array.from({ length: 2000 }, (_, i) => `n${i}`);
    const frames: number[] = [];
    for (let f = 0; f < 60; f++) {
      const start = performance.now();
      store.moveEntities({ nodeIds: ids }, { x: 1, y: 1 }, { groupId: 'multi-drag' });
      frames.push(performance.now() - start);
    }
    const median = [...frames].sort((a, b) => a - b)[30];
    console.info(`[bench] 多选拖拽 2000 节点: 中位 ${median.toFixed(1)}ms / 帧`);
    // 实测约 8ms；撤销压缩或空间索引若退化为平方级，此处会达到数百毫秒
    expect(median).toBeLessThan(40);
  });

  it('拖动含 2000 个子节点的容器 (ADR-114：只改容器自身)', () => {
    const engine = new SkyNoteEngine();
    const store = engine.documentStore;
    const patches: CanvasPatch[] = [
      {
        op: 'set',
        path: ['content', 'nodes', 'frame'],
        value: {
          id: 'frame',
          type: 'node',
          nodeType: 'rect',
          x: 0,
          y: 0,
          width: 3000,
          height: 3000,
          rotation: 0,
          zIndex: 'a0',
          locked: false
        }
      }
    ];
    for (let i = 0; i < 2000; i++) {
      const node: NodeEntity = {
        id: `c${i}`,
        type: 'node',
        nodeType: 'rect',
        x: (i % 50) * 60,
        y: Math.floor(i / 50) * 60,
        width: 40,
        height: 40,
        rotation: 0,
        zIndex: 'a0',
        locked: false,
        parentId: 'frame'
      };
      patches.push({ op: 'set', path: ['content', 'nodes', node.id], value: node });
    }
    store.commit({ patches, undoable: false });

    const frames: number[] = [];
    let patchCount = 0;
    for (let f = 0; f < 60; f++) {
      const start = performance.now();
      patchCount = store.moveEntities({ nodeIds: ['frame'] }, { x: 1, y: 1 }, { groupId: 'frame-drag' })!.patches
        .length;
      frames.push(performance.now() - start);
    }
    const median = [...frames].sort((a, b) => a - b)[30];
    console.info(`[bench] 拖动含 2000 子节点的容器: 中位 ${median.toFixed(1)}ms / 帧，每帧 ${patchCount} 条补丁`);
    // 事务、撤销与协同只有容器自身 2 条补丁；分层空间索引只更新容器一个条目，实测约 0.2ms (扁平索引约 4.5ms)
    expect(patchCount).toBe(2);
    expect(median).toBeLessThan(3);
  });
});
