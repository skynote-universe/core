/** 成环守卫只遍历本事务最终父关系的祖先并集，不跨事务缓存。 */
import { describe, expect, it } from 'vitest';
import { findParentCycle } from '../src/state/commit-guards';
import { createEmptyCanvasDocument } from '../src/state/document-store';
import type { CanvasPatch } from '../src/types/operation';

describe('成环守卫共享祖先', () => {
  it.each([100, 200, 400])('%i 层批量改挂的节点读取为线性', (depth) => {
    const doc = createEmptyCanvasDocument();
    for (let i = 0; i < depth; i++)
      doc.content.nodes[`n${i}`] = {
        id: `n${i}`,
        type: 'node',
        nodeType: 'frame',
        x: 0,
        y: 0,
        width: 100,
        height: 100,
        rotation: 0,
        zIndex: 'a0',
        locked: false,
        ...(i ? { parentId: `n${i - 1}` } : {})
      };
    const patches: CanvasPatch[] = [];
    for (let i = 0; i < depth; i++) {
      const id = `leaf${i}`;
      doc.content.nodes[id] = {
        id,
        type: 'node',
        nodeType: 'shape',
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        rotation: 0,
        zIndex: 'a0',
        locked: false
      };
      patches.push({ op: 'set', path: ['content', 'nodes', id, 'parentId'], value: `n${depth - 1}` });
    }
    let reads = 0;
    doc.content.nodes = new Proxy(doc.content.nodes, {
      get(target, key) {
        reads++;
        return Reflect.get(target, key);
      }
    });
    expect(findParentCycle(doc, patches)).toBeNull();
    expect(reads).toBe(depth);
  });

  it('已验证共享祖先不能掩盖另一分支的自环和多节点环', () => {
    const doc = createEmptyCanvasDocument();
    for (const cycle of [
      [{ op: 'set', path: ['content', 'nodes', 'b', 'parentId'], value: 'b' }],
      [
        { op: 'set', path: ['content', 'nodes', 'b', 'parentId'], value: 'c' },
        { op: 'set', path: ['content', 'nodes', 'c', 'parentId'], value: 'b' }
      ]
    ] satisfies CanvasPatch[][])
      expect(
        findParentCycle(doc, [{ op: 'set', path: ['content', 'nodes', 'a', 'parentId'], value: 'root' }, ...cycle])
      ).toMatch(/形成环/);
  });

  it('同一批次只按最终父关系判环，后续批次必须重新验证', () => {
    const doc = createEmptyCanvasDocument();
    const cycle: CanvasPatch[] = [
      { op: 'set', path: ['content', 'nodes', 'a', 'parentId'], value: 'b' },
      { op: 'set', path: ['content', 'nodes', 'b', 'parentId'], value: 'a' }
    ];
    expect(findParentCycle(doc, [...cycle, { op: 'unset', path: ['content', 'nodes', 'b', 'parentId'] }])).toBeNull();
    expect(findParentCycle(doc, cycle)).toMatch(/形成环/);
    expect(findParentCycle(doc, [])).toBeNull();
  });

  it('12000 层整体导入的父关系不递归，末端成环仍拒绝', () => {
    const doc = createEmptyCanvasDocument();
    const nodes: Record<string, { parentId?: string }> = {};
    for (let i = 0; i < 12000; i++) nodes[`n${i}`] = i ? { parentId: `n${i - 1}` } : {};
    expect(findParentCycle(doc, [{ op: 'set', path: ['content', 'nodes'], value: nodes }])).toBeNull();
    nodes.n0.parentId = 'n11999';
    expect(findParentCycle(doc, [{ op: 'set', path: ['content', 'nodes'], value: nodes }])).toMatch(/形成环/);
  });
});
