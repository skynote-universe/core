import { describe, expect, it, vi } from 'vitest';
import type { NodeEntity } from '../src/types/node';
import { computeSubtreeFootprint } from '../src/layout/subtree-footprint';
import { deriveLayoutPatches } from '../src/layout/layout-derivation';
import { LayoutRegistry } from '../src/registry/layout-registry';
import { EntityStore } from '../src/state/entity-store';
import { SelectionGeometry } from '../src/layout/selection-geometry';

function node(id: string, extra: Partial<NodeEntity> = {}): NodeEntity {
  return {
    id,
    type: 'node',
    nodeType: 'shape',
    x: 0,
    y: 0,
    width: 40,
    height: 20,
    rotation: 0,
    zIndex: 'a1',
    locked: false,
    ...extra
  };
}

describe('布局成员的复合占位', () => {
  it('在根局部坐标合并多层旋转，忽略根本身位姿并保持输入不变', () => {
    const root = node('root', { x: 100, y: 200, rotation: 37 });
    const child = node('child', { parentId: 'root', x: -50, y: -60, width: 20, height: 10, rotation: 90 });
    const grandchild = node('grandchild', { parentId: 'child', x: 10, y: 20, width: 30, height: 10 });
    const children = new Map([
      ['root', [child]],
      ['child', [grandchild]]
    ]);
    const before = structuredClone([root, child, grandchild]);
    const b = computeSubtreeFootprint(root, (id) => children.get(id) ?? []);
    expect(b).toEqual({ left: -65, top: -65, right: 40, bottom: 20 });
    expect([root, child, grandchild]).toEqual(before);
    expect(Object.isFrozen(b)).toBe(true);
    expect(computeSubtreeFootprint(node('empty', { width: 40.2, height: 20.7 }), () => [])).toEqual({
      left: 0,
      top: 0,
      right: 41,
      bottom: 21
    });
  });

  it('12000层子树迭代测量，每个父节点的成员只读取一次', () => {
    const count = 12000;
    const nodes = Array.from({ length: count + 1 }, (_, index) =>
      node(String(index), { width: 1, height: 1, ...(index ? { x: 1, y: 1, parentId: String(index - 1) } : {}) })
    );
    let reads = 0;
    const b = computeSubtreeFootprint(nodes[0], (id) => {
      reads++;
      const index = Number(id) + 1;
      return index < nodes.length ? [nodes[index]] : [];
    });
    expect(b).toEqual({ left: 0, top: 0, right: count + 1, bottom: count + 1 });
    expect(reads).toBe(count + 1);
  });

  it.each([false, true])('占位按需计算并在单棵布局中缓存，消费=%s', (consume) => {
    const layouts = new LayoutRegistry();
    layouts.register({ id: 'compound', label: '复合布局', footprint: 'subtree', arrange: () => new Map() });
    layouts.register({
      id: 'consumer',
      label: '外部布局',
      arrange: (tree) => {
        if (consume) {
          const first = tree.getFootprint!('member');
          expect(first).toEqual({ left: -60, top: -50, right: 40, bottom: 20 });
          expect(tree.getFootprint!('member')).toBe(first);
          expect(tree.getFootprint!('ordinary')).toBeUndefined();
          expect(tree.getFootprint!('missing')).toBeUndefined();
        }
        return new Map();
      }
    });
    const root = node('root', { layout: { type: 'consumer' } });
    const member = node('member', { parentId: 'root', layout: { type: 'compound' }, layoutItem: {} });
    const ordinary = node('ordinary', { parentId: 'root', layoutItem: {} });
    const leaf = node('leaf', { parentId: 'member', x: -60, y: -50 });
    const children = new Map([
      ['root', [member, ordinary]],
      ['member', [leaf]]
    ]);
    const childrenOf = vi.fn((id: string) => children.get(id) ?? []);
    deriveLayoutPatches(root, { layouts, childrenOf });
    expect(childrenOf.mock.calls.filter(([id]) => id === 'member')).toHaveLength(consume ? 1 : 0);
    expect(childrenOf.mock.calls.filter(([id]) => id === 'leaf')).toHaveLength(consume ? 1 : 0);
  });

  it('运行时局部范围独立于世界旋转，尺寸变更后缓存失效', () => {
    const entities = new EntityStore();
    const root = node('root', { x: 200, y: 300, rotation: 37 });
    const child = node('child', { parentId: 'root', x: -60, y: -50 });
    entities.syncNode(root.id, root);
    entities.syncNode(child.id, child);
    const geometry = new SelectionGeometry(entities, new LayoutRegistry());
    const initial = geometry.getSubtreeLocalBounds('root');
    expect(initial).toEqual({ left: -60, top: -50, right: 40, bottom: 20 });
    expect(geometry.getSubtreeLocalBounds('root')).toBe(initial);
    entities.syncNode(child.id, { ...child, width: 400 });
    expect(geometry.getSubtreeLocalBounds('root')).toEqual({ left: -60, top: -50, right: 340, bottom: 20 });
    expect(geometry.getSubtreeLocalBounds('missing')).toBeUndefined();
  });
});
