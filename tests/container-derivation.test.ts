/**
 * @file container-derivation.test.ts
 * @description 深层容器调度的查询复杂度与非递归依赖展开回归
 */

import { describe, expect, it } from 'vitest';
import { deriveContainerPatches } from '../src/layout/container-derivation';
import { LayoutRegistry } from '../src/registry/layout-registry';
import { createEmptyCanvasDocument } from '../src/state/document-store';
import type { CanvasPatch } from '../src/types/operation';

function nestedGroups(depth: number, memberChain: boolean) {
  const doc = createEmptyCanvasDocument();
  const nodes = doc.content.nodes;
  const children = new Map<string, Set<string>>();
  for (let i = 0; i <= depth; i++) {
    const id = `n${i}`;
    const parentId = i ? `n${i - 1}` : undefined;
    nodes[id] = {
      id,
      type: 'node',
      nodeType: i === depth ? 'rect' : 'group',
      x: 0,
      y: 0,
      width: i === depth ? 21 : 20,
      height: 20,
      rotation: 0,
      zIndex: 'a0',
      locked: false,
      ...(parentId ? { parentId } : {}),
      ...(memberChain ? { layoutItem: {} } : {})
    };
    if (parentId) children.set(parentId, new Set([id]));
  }
  let reads = 0;
  doc.content.nodes = new Proxy(nodes, {
    get(target, key) {
      reads++;
      return Reflect.get(target, key);
    }
  });
  return {
    doc,
    context: {
      layouts: new LayoutRegistry(),
      previousParentId: (id: string) => nodes[id]?.parentId,
      previousChildIds: (id: string) => children.get(id) ?? new Set<string>()
    },
    patch: { op: 'set', path: ['content', 'nodes', `n${depth}`, 'width'], value: 21 } as CanvasPatch,
    reads: () => reads
  };
}

describe('容器派生依赖调度', () => {
  it.each([false, true])('祖先查询随深度线性增长，layoutItem 链=%s', (memberChain) => {
    for (const depth of [100, 200, 400, 800]) {
      const fixture = nestedGroups(depth, memberChain);
      const patches = deriveContainerPatches(fixture.doc, [fixture.patch], fixture.context);
      expect(patches).toHaveLength(depth);
      expect(patches).toContainEqual({ op: 'set', path: ['content', 'nodes', 'n0', 'width'], value: 21 });
      // 计查询次数而非机器耗时，避免负载抖动掩盖平方级遍历回归。
      expect(fixture.reads()).toBeLessThan(depth * 8);
    }
  });

  it('重复几何补丁共享祖先信息', () => {
    const fixture = nestedGroups(800, true);
    const patches = deriveContainerPatches(
      fixture.doc,
      Array.from({ length: 1000 }, () => fixture.patch),
      fixture.context
    );
    expect(patches).toHaveLength(800);
    expect(fixture.reads()).toBeLessThan((800 + 1000) * 8);
  });

  it('12000 层组合迭代展开，最外层仍收到派生尺寸', () => {
    const fixture = nestedGroups(12000, false);
    const patches = deriveContainerPatches(fixture.doc, [fixture.patch], fixture.context);
    expect(patches).toHaveLength(12000);
    expect(patches.at(-1)).toEqual({ op: 'set', path: ['content', 'nodes', 'n0', 'width'], value: 21 });
    expect(fixture.reads()).toBeLessThan(12000 * 8);
  });
});
