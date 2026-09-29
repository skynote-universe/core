/**
 * @file session-store.test.ts
 * @description 本地会话状态：视口与选区不进入文档与撤销栈、增量翻转通知、失效选区剔除、插件订阅沙盒
 */

import { describe, it, expect, vi } from 'vitest';
import { SkyNoteEngine } from '../src/engine';
import { SessionStore, type SessionChange } from '../src/state/session-store';
import type { SkyNotePlugin, CanvasPluginContext } from '../src/protocols/plugin.protocol';
import type { NodeEntity } from '../src/types/node';

function makeNode(id: string): NodeEntity {
  return {
    id,
    type: 'node',
    nodeType: 'rect',
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    rotation: 0,
    zIndex: 'a0',
    locked: false
  };
}

describe('SessionStore', () => {
  it('视口变化不产生事务、不入撤销栈、不刷新文档更新时间', () => {
    const engine = new SkyNoteEngine({ initialViewport: { zoom: 2 } });
    const operationSpy = vi.fn();
    engine.documentStore.coordinator.onOperation(operationSpy);
    const updatedAt = engine.getView().meta.updatedAt;

    engine.session.setViewport({ x: 100, y: 50 });

    expect(engine.session.viewport).toEqual({ x: 100, y: 50, zoom: 2 });
    expect(operationSpy).not.toHaveBeenCalled();
    expect(engine.documentStore.canUndo).toBe(false);
    expect(engine.getView().meta.updatedAt).toBe(updatedAt);
  });

  it('非法视口参数被拒绝，无变化的更新不广播', () => {
    const session = new SessionStore();
    const listener = vi.fn();
    session.subscribe(listener);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    session.setViewport({ zoom: 0 });
    session.setViewport({ x: Number.NaN });
    session.setViewport({ x: 0, y: 0, zoom: 1 });

    expect(listener).not.toHaveBeenCalled();
    expect(session.viewport).toEqual({ x: 0, y: 0, zoom: 1 });
    vi.restoreAllMocks();
  });

  it('选区变化只广播选中态翻转的 id', () => {
    const session = new SessionStore();
    const changes: SessionChange[] = [];
    session.subscribe((change) => changes.push(change));

    session.setSelection({ nodeIds: ['a', 'b'] });
    session.setSelection({ nodeIds: ['b', 'c'] });
    session.setSelection({ nodeIds: ['c', 'b'] });

    expect(changes).toHaveLength(2);
    expect([...changes[0].toggledNodeIds].sort()).toEqual(['a', 'b']);
    expect([...changes[1].toggledNodeIds].sort()).toEqual(['a', 'c']);
    expect(changes[1].toggledConnectorIds.size).toBe(0);
  });

  it('远端删除实体后，选区自动剔除失效 id', () => {
    const engine = new SkyNoteEngine();
    engine.documentStore.addNode(makeNode('a'));
    engine.documentStore.addNode(makeNode('b'));
    engine.session.setSelection({ nodeIds: ['a', 'b'] });

    engine.documentStore.commit({ origin: 'remote', patches: [{ op: 'unset', path: ['content', 'nodes', 'a'] }] });

    expect([...engine.session.selectedNodeIds]).toEqual(['b']);
  });
});

describe('插件上下文的会话与变更订阅', () => {
  it('插件可读写会话、订阅变更集，卸载后订阅自动解绑', () => {
    const engine = new SkyNoteEngine();
    let context: CanvasPluginContext | undefined;
    const documentChanges: string[][] = [];
    const sessionChanges: SessionChange[] = [];

    const plugin: SkyNotePlugin = {
      id: 'probe',
      name: 'probe',
      version: '0.0.0',
      install(ctx) {
        context = ctx;
        ctx.onDocumentChange((changes) => documentChanges.push([...changes.nodes.added]));
        ctx.onSessionChange((change) => sessionChanges.push(change));
      }
    };
    engine.use(plugin);

    engine.documentStore.addNode(makeNode('a'));
    context!.session.setSelection({ nodeIds: ['a'] });
    expect(documentChanges).toEqual([['a']]);
    expect(sessionChanges).toHaveLength(1);
    expect(engine.session.selectedNodeIds.has('a')).toBe(true);

    engine.plugins.remove('probe');
    engine.documentStore.addNode(makeNode('b'));
    engine.session.setViewport({ zoom: 3 });
    expect(documentChanges).toHaveLength(1);
    expect(sessionChanges).toHaveLength(1);
  });
});
