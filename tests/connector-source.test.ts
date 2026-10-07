/**
 * @file connector-source.test.ts
 * @description ADR-130 派生连线来源：与文档连线一起进入实体索引与变更集、增量重算、写入交给来源、
 *              结构命令跳过派生连线、悬空兜底、来源出错隔离、注册与卸载、保留前缀
 */

import { describe, it, expect, vi } from 'vitest';
import { SkyNoteEngine } from '../src/engine';
import type { NodeEntity } from '../src/types/node';
import type { ConnectorStyle } from '../src/types/connector';
import type { DerivedConnector, DerivedConnectorSource } from '../src/protocols/connector-source.protocol';
import type { CanvasPluginContext, SkyNotePlugin } from '../src/protocols/plugin.protocol';
import type { DocumentChangeSet } from '../src/types/change-set';

function makeNode(id: string, patch: Partial<NodeEntity> = {}): NodeEntity {
  return {
    id,
    type: 'node',
    nodeType: 'rect',
    x: 0,
    y: 0,
    width: 100,
    height: 40,
    rotation: 0,
    zIndex: 'a0',
    locked: false,
    ...patch
  };
}

/** 玩具来源：节点 data.linkTo 指向另一个节点时，派生一条连向它的线；线的样式存在 data.linkStyle */
class LinkSource implements DerivedConnectorSource {
  readonly id = 'test-link';
  readonly derive = vi.fn((keys: Iterable<string> | null) => {
    const { nodes } = this.ctx.document.getView().content;
    const result = new Map<string, DerivedConnector | undefined>();
    for (const id of keys ?? Object.keys(nodes)) {
      const data = Object.hasOwn(nodes, id) ? nodes[id].data : undefined;
      const target = typeof data?.linkTo === 'string' ? data.linkTo : undefined;
      result.set(
        id,
        target === undefined
          ? undefined
          : {
              connectorType: 'straight',
              from: { nodeId: id },
              to: { nodeId: target },
              zIndex: 'a0',
              locked: false,
              style: (data!.linkStyle ?? {}) as ConnectorStyle
            }
      );
    }
    return result;
  });

  constructor(private readonly ctx: CanvasPluginContext) {}

  /** 自身的 data 变化，以及被连节点整体出现或消失 (如撤销删除) 时指向它的节点：依赖关系只有来源自己知道 */
  collect(changes: Parameters<DerivedConnectorSource['collect']>[0]): string[] {
    const { nodes } = this.ctx.document.getView().content;
    const keys = [...changes.nodes].filter(([, change]) => change === 'entity' || change.has('data')).map(([id]) => id);
    for (const [id, change] of changes.nodes) {
      if (change !== 'entity') continue;
      for (const node of Object.values(nodes)) if (node.data?.linkTo === id) keys.push(node.id);
    }
    return keys;
  }

  write(key: string, _current: unknown, partial: { style?: ConnectorStyle }) {
    const data = this.ctx.document.getNode(key)!.data!;
    return partial.style
      ? [
          {
            op: 'set' as const,
            path: ['content', 'nodes', key, 'data'],
            value: { ...data, linkStyle: { ...(data.linkStyle as object), ...partial.style } }
          }
        ]
      : [];
  }
}

function setup() {
  let source!: LinkSource;
  const plugin: SkyNotePlugin = {
    id: 'test/link',
    name: '链接',
    version: '1.0.0',
    install(ctx) {
      source = new LinkSource(ctx);
      ctx.registerConnectorSource(source);
    }
  };
  const engine = new SkyNoteEngine();
  const store = engine.documentStore;
  store.addNode(makeNode('a', { data: { linkTo: 'b' } }));
  store.addNode(makeNode('b', { x: 300 }));
  engine.use(plugin);
  const changes: DocumentChangeSet[] = [];
  store.subscribe((_view, _record, change) => changes.push(change));
  return { engine, store, source: () => source, changes };
}

const ID = '@test-link:a';

describe('派生连线来源', () => {
  it('注册即派生：与文档连线一样进入实体索引、邻接与路由，但不在文档中', () => {
    const { engine, store } = setup();
    expect(engine.entityStore.getConnector(ID)!.entity).toMatchObject({
      id: ID,
      type: 'connector',
      from: { nodeId: 'a' },
      to: { nodeId: 'b' }
    });
    expect([...engine.entityStore.getConnectorIdsOfNode('b')]).toEqual([ID]);
    expect(engine.getConnectorRoute(ID)!.points.length).toBeGreaterThanOrEqual(2);
    expect(store.getView().content.connectors).toEqual({});
  });

  it('增量：只对来源返回的键推导，与来源无关的提交 (如拖动) 不调用 derive；变化并入同一个变更集', () => {
    const { store, source, changes } = setup();
    source().derive.mockClear();
    store.moveEntities({ nodeIds: ['a', 'b'] }, { x: 10, y: 0 });
    expect(source().derive).not.toHaveBeenCalled();
    expect(changes.at(-1)!.connectors.geometry.has(ID)).toBe(true);

    store.updateNode('a', { data: { linkTo: undefined } });
    expect(source().derive).toHaveBeenCalledWith(['a']);
    expect(changes.at(-1)!.connectors.removed.has(ID)).toBe(true);
    store.undo();
    expect(changes.at(-1)!.connectors.added.has(ID)).toBe(true);
  });

  it('写入交给来源转写为文档补丁，一步撤销；只读来源或结构命令 (删除、复制、移动) 都跳过派生连线', () => {
    const { engine, store } = setup();
    store.updateConnector(ID, { style: { stroke: 'red' } });
    expect(store.getNode('a')!.data!.linkStyle).toEqual({ stroke: 'red' });
    expect(engine.entityStore.getConnector(ID)!.entity.style).toEqual({ stroke: 'red' });
    store.undo();
    expect(engine.entityStore.getConnector(ID)!.entity.style).toEqual({});

    expect(store.removeEntities({ connectorIds: [ID] })).toBeNull();
    expect(store.copyEntities({ nodeIds: ['a', 'b'], connectorIds: [ID] })!.connectors).toEqual([]);
    expect(store.moveEntities({ connectorIds: [ID] }, { x: 5 })).toBeNull();
  });

  it('被连的节点删除后派生连线随之消失 (内核兜底重算，不依赖来源的 collect)', () => {
    const { engine, store } = setup();
    store.removeEntities({ nodeIds: ['b'] });
    expect(engine.entityStore.getConnector(ID)).toBeUndefined();
    store.undo();
    expect(engine.entityStore.getConnector(ID)).toBeDefined();
  });

  it('来源出错只影响它自己：提交照常完成；卸载插件时其连线全部移除并广播', () => {
    const { engine, store, source, changes } = setup();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    source().derive.mockImplementationOnce(() => {
      throw new Error('boom');
    });
    expect(store.updateNode('a', { data: { linkTo: 'b', note: 1 } })).not.toBeNull();
    expect(error).toHaveBeenCalled();
    error.mockRestore();

    engine.plugins.remove('test/link');
    expect(engine.entityStore.getConnector(ID)).toBeUndefined();
    expect(changes.at(-1)!.connectors.removed.has(ID)).toBe(true);
  });

  it('文档中的连线不能使用派生连线的保留前缀 @', () => {
    const { store } = setup();
    expect(store.createConnector({ id: '@x', from: { nodeId: 'a' }, to: { nodeId: 'b' } })).toBeNull();
  });
});
