import { expect, it } from 'vitest';
import { collectNodeDataPaths } from '../src/operation/node-change-paths';
import type { CanvasPatch } from '../src/types';

it('同一节点一万条字段补丁的路径摘要保持批量预算', () => {
  const patches: CanvasPatch[] = Array.from({ length: 10000 }, (_, index) => ({
    op: 'set',
    path: ['content', 'nodes', 'table', 'textBlocks', index, 'runs'],
    value: []
  }));
  collectNodeDataPaths(patches);
  const times: number[] = [];
  for (let run = 0; run < 5; run++) {
    const start = performance.now();
    const paths = collectNodeDataPaths(patches)!;
    times.push(performance.now() - start);
    expect(paths.get('table')).toHaveLength(10000);
    expect(paths.get('table')![9999]).toEqual(['textBlocks', 9999, 'runs']);
  }
  const median = times.sort((a, b) => a - b)[2];
  console.info('[bench] 一万条同节点路径摘要中位耗时: ' + median.toFixed(2) + 'ms');
  // 原重复复制路径数组实测约136ms；留出机器负载余量，防止重新引入平方开销。
  expect(median).toBeLessThan(40);
});
