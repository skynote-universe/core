/** 世界矩阵按几何代次惰性验证，覆盖共享祖先复杂度及结构失效。 */
import { describe, expect, it } from 'vitest';
import { EntityStore } from '../src/state/entity-store';
import type { NodeEntity } from '../src/types/node';

function node(id: string, patch: Partial<NodeEntity> = {}): NodeEntity {
  return {
    id,
    type: 'node',
    nodeType: 'rect',
    x: 1,
    y: 0,
    width: 10,
    height: 10,
    rotation: 0,
    zIndex: 'a0',
    locked: false,
    ...patch
  };
}

describe('世界矩阵缓存代次', () => {
  it.each([100, 200, 400])('%i 层全节点读取与重复读取的祖先查询为线性', (depth) => {
    const store = new EntityStore();
    let reads = 0;
    for (let i = 0; i < depth; i++) {
      const entity = node(`n${i}`, i ? { parentId: `n${i - 1}` } : {});
      // 纯索引夹具计实体属性读取，不计机器耗时，也不依赖私有缓存实现。
      store.syncNode(
        entity.id,
        new Proxy(entity, {
          get(target, key, receiver) {
            if (key === 'parentId') reads++;
            return Reflect.get(target, key, receiver);
          }
        })
      );
    }
    reads = 0;
    for (let i = 0; i < depth; i++) expect(store.getWorldTransform(`n${i}`)!.e).toBe(i + 1);
    expect(reads).toBeLessThan(depth * 5);
    reads = 0;
    for (let i = depth - 1; i >= 0; i--) store.getWorldTransform(`n${i}`);
    expect(reads).toBe(0);
    store.syncNode('unrelated', node('unrelated'));
    reads = 0;
    for (let i = depth - 1; i >= 0; i--) expect(store.getWorldTransform(`n${i}`)!.e).toBe(i + 1);
    expect(reads).toBeLessThan(depth * 5);
  });

  it('12000 层冷读取与祖先移动不占调用栈', () => {
    const store = new EntityStore();
    const root = node('n0');
    store.syncNode(root.id, root);
    for (let i = 1; i < 12000; i++) store.syncNode(`n${i}`, node(`n${i}`, { parentId: `n${i - 1}` }));
    expect(store.getWorldTransform('n11999')!.e).toBe(12000);
    root.x = 11;
    store.bumpNodeVersion(root.id, 'geom');
    expect(store.getWorldTransform('n11999')!.e).toBe(12010);
  });

  it('样式不失效，几何变化惰性刷新且保留无关矩阵引用', () => {
    const store = new EntityStore();
    const root = node('root');
    store.syncNode('root', root);
    store.syncNode('leaf', node('leaf', { parentId: 'root' }));
    store.syncNode('other', node('other', { x: 200 }));
    const leaf = store.getWorldTransform('leaf');
    const other = store.getWorldTransform('other');
    store.bumpNodeVersion('root', 'data');
    expect(store.getWorldTransform('leaf')).toBe(leaf);
    root.x = 20;
    store.bumpNodeVersion('root', 'geom');
    expect(store.getWorldTransform('leaf')!.e).toBe(21);
    expect(store.getWorldTransform('other')).toBe(other);
  });

  it('改挂、父节点删除及同 id 恢复均刷新后代，孤儿支持父节点晚加入', () => {
    const store = new EntityStore();
    const leaf = node('leaf', { parentId: 'missing' });
    store.syncNode('leaf', leaf);
    expect(store.getWorldTransform('leaf')!.e).toBe(1);
    store.syncNode('missing', node('missing', { x: 10 }));
    expect(store.getWorldTransform('leaf')!.e).toBe(11);
    store.syncNode('next', node('next', { x: 30 }));
    leaf.parentId = 'next';
    store.reindexNodeParent('leaf');
    expect(store.getWorldTransform('leaf')!.e).toBe(31);
    store.syncNode('next', undefined);
    expect(store.getWorldTransform('leaf')!.e).toBe(1);
    store.syncNode('next', node('next', { x: 50 }));
    expect(store.getWorldTransform('leaf')!.e).toBe(51);
    store.syncNode('next', node('next', { x: 70 }));
    expect(store.getWorldTransform('leaf')!.e).toBe(71);
    store.clear();
    store.syncNode('leaf', node('leaf', { x: 90 }));
    expect(store.getWorldTransform('leaf')!.e).toBe(90);
    expect(store.getWorldTransform('next')).toBeUndefined();
  });
});
