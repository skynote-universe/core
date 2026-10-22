/** 可提交的补丁必须保留JSON语义，最终文档合法不能掩盖不可恢复的历史。 */
import { describe, expect, it } from 'vitest';
import { DocumentStore, createEmptyCanvasDocument } from '../src/state/document-store';
import { parseCanvasHistory } from '../src/serialization/history-schema';
import { OperationCoordinator } from '../src/operation/coordinator';
import { applyPatches } from '../src/operation/patch-applier';

function setup(): DocumentStore {
  const doc = createEmptyCanvasDocument();
  doc.content.nodes.a = {
    id: 'a',
    type: 'node',
    nodeType: 'frame',
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    rotation: 0,
    zIndex: 'a0',
    locked: false
  };
  return new DocumentStore(doc);
}

function expectRecoverable(store: DocumentStore, before: ReturnType<DocumentStore['getView']>): void {
  const after = structuredClone(store.getView());
  for (const undone of [false, true]) {
    if (undone) expect(store.undo()).toBe(true);
    const target = new DocumentStore();
    expect(
      target.restoreRecovery(
        JSON.parse(JSON.stringify(store.getView())),
        JSON.parse(JSON.stringify(store.getHistorySnapshot()))
      )
    ).toEqual({ ok: true });
    expect(target.getView()).toEqual(undone ? before : after);
    expect(undone ? target.redo() : target.undo()).toBe(true);
    expect(target.getView()).toEqual(undone ? after : before);
  }
}

describe('历史补丁JSON契约', () => {
  it.each(['公开更新', '原始merge'] as const)('%s删除样式字段后，undo和redo分支均能JSON恢复', (entry) => {
    const store = setup();
    store.updateNode('a', { style: { fillOpacity: 0.3, strokeWidth: 2 } });
    store.clearHistory();
    const before = structuredClone(store.getView());
    const record =
      entry === '公开更新'
        ? store.updateNode('a', { style: { fill: 'transparent', fillOpacity: undefined } })
        : store.commit({
            patches: [
              {
                op: 'set',
                path: ['content', 'nodes', 'a', 'style'],
                merge: true,
                value: { fill: 'transparent', fillOpacity: undefined }
              }
            ]
          });
    expect(record).not.toBeNull();
    expect(store.getNode('a')!.style).toEqual({ strokeWidth: 2, fill: 'transparent' });
    expect(record!.patches).toContainEqual({ op: 'unset', path: ['content', 'nodes', 'a', 'style', 'fillOpacity'] });
    expect(record!.patches).toEqual(JSON.parse(JSON.stringify(record!.patches)));
    expectRecoverable(store, before);
  });

  it.each([undefined, { retained: true }])('merge目标原为%j时删除键不留下undefined，且原值可恢复', (data) => {
    const store = setup();
    if (data !== undefined) store.updateNode('a', { data });
    store.clearHistory();
    const before = structuredClone(store.getView());
    expect(
      store.commit({
        patches: [{ op: 'set', path: 'content.nodes.a.data', merge: true, value: { removed: undefined } }]
      })
    ).not.toBeNull();
    expect(store.getNode('a')!.data).toEqual(data ?? {});
    expectRecoverable(store, before);
  });

  it.each([null, '旧值'])('通用补丁目标原为%j时可创建字典，JSON正逆回放均保持', (style) => {
    const doc: { style: unknown } = { style };
    const coordinator = new OperationCoordinator(doc);
    const before = structuredClone(doc);
    const record = coordinator.commitOperation({
      patches: [{ op: 'set', path: 'style', value: { opacity: undefined }, merge: true }]
    })!;
    expect(doc).toEqual({ style: {} });
    const replica = structuredClone(before);
    expect(applyPatches(replica, JSON.parse(JSON.stringify(record.patches))).success).toBe(true);
    expect(replica).toEqual(doc);
    expect(applyPatches(replica, JSON.parse(JSON.stringify([...record.inversePatches].reverse()))).success).toBe(true);
    expect(replica).toEqual(before);
  });

  it('同组反复添加和删除后可恢复历史，且保留未编辑字段', () => {
    const store = setup();
    store.updateNode('a', { style: { strokeWidth: 3 } });
    store.clearHistory();
    const before = structuredClone(store.getView());
    for (let i = 0; i < 3; i++) {
      store.updateNode('a', { style: { fillOpacity: 0.3 } }, { groupId: 'fill' });
      store.updateNode('a', { style: { fill: 'transparent', fillOpacity: undefined } }, { groupId: 'fill' });
    }
    expect(store.getNode('a')!.style).toEqual({ strokeWidth: 3, fill: 'transparent' });
    expect(store.getHistorySnapshot().undo).toHaveLength(1);
    expectRecoverable(store, before);
  });

  it('同一事务先创建字典再删除键，执行顺序及失败回滚保持', () => {
    const store = setup();
    const before = structuredClone(store.getView());
    const patches = [
      { op: 'set' as const, path: 'content.nodes.a.style', value: { fillOpacity: 0.3 } },
      { op: 'set' as const, path: 'content.nodes.a.style', value: { fillOpacity: undefined }, merge: true }
    ];
    expect(
      store.commit({ patches: [...patches, { op: 'set', path: 'content.nodes.missing.x', value: 1 }] })
    ).toBeNull();
    expect(store.getView()).toEqual(before);
    expect(store.canUndo).toBe(false);
    expect(store.commit({ patches })).not.toBeNull();
    expect(store.getNode('a')!.style).toEqual({});
    expectRecoverable(store, before);
  });

  it('事务派生的merge删除也广播明确补丁并可JSON回放', () => {
    const doc = { count: 0, style: { opacity: 0.3 } };
    const coordinator = new OperationCoordinator(doc);
    coordinator.setPatchDerivations([() => [{ op: 'set', path: 'style', merge: true, value: { opacity: undefined } }]]);
    const before = structuredClone(doc);
    const record = coordinator.commitOperation({ patches: [{ op: 'set', path: 'count', value: 1 }] })!;
    const replica = structuredClone(before);
    expect(applyPatches(replica, JSON.parse(JSON.stringify(record.patches))).success).toBe(true);
    expect(replica).toEqual(doc);
    expect(coordinator.undo()).toBe(true);
    expect(doc).toEqual(before);
    expect(coordinator.redo()).toBe(true);
    expect(replica).toEqual(doc);
  });

  it('显式逆补丁按实际执行顺序展开，目标缺失时也能撤销并重做', () => {
    const doc: { style?: { opacity?: number } } = { style: {} };
    const coordinator = new OperationCoordinator(doc);
    const record = coordinator.commitOperation({
      patches: [{ op: 'unset', path: 'style' }],
      inversePatches: [{ op: 'set', path: 'style', merge: true, value: { opacity: undefined } }]
    })!;
    expect(record.inversePatches).toEqual(JSON.parse(JSON.stringify(record.inversePatches)));
    expect(coordinator.undo()).toBe(true);
    expect(doc).toEqual({ style: {} });
    expect(coordinator.redo()).toBe(true);
    expect(doc).toEqual({});
  });

  it('远端merge删除按相同语义广播，不污染本地历史或调用方补丁', () => {
    const doc = { style: { opacity: 0.3, strokeWidth: 2 } };
    const coordinator = new OperationCoordinator(doc);
    const patch = { op: 'set' as const, path: 'style', value: { opacity: undefined }, merge: true };
    const before = structuredClone(doc);
    const record = coordinator.commitOperation({ origin: 'remote', patches: [patch] })!;
    expect(Object.hasOwn(patch.value, 'opacity')).toBe(true);
    expect(record.patches).toEqual(JSON.parse(JSON.stringify(record.patches)));
    const replica = structuredClone(before);
    expect(applyPatches(replica, JSON.parse(JSON.stringify(record.patches))).success).toBe(true);
    expect(replica).toEqual(doc);
    expect(doc).toEqual({ style: { strokeWidth: 2 } });
    expect(coordinator.canUndo).toBe(false);
  });

  it('批次异常撤回展开后的删除，原有重做分支保持', () => {
    const store = setup();
    store.updateNode('a', { style: { fillOpacity: 0.3 } });
    store.clearHistory();
    store.updateNode('a', { x: 5 });
    store.undo();
    const before = structuredClone(store.getView());
    const history = store.getHistorySnapshot();
    expect(() =>
      store.batch(() => {
        store.updateNode('a', { style: { fillOpacity: undefined, fill: 'transparent' } });
        store.updateNode('a', { style: { fillOpacity: 0.5 } });
        throw new Error('取消批次');
      })
    ).toThrow('取消批次');
    expect(store.getView()).toEqual(before);
    expect(store.getHistorySnapshot()).toEqual(history);
    expect(store.redo()).toBe(true);
    expect(store.getNode('a')!.x).toBe(5);
  });

  it.each(['zIndex', 'aspectLocked'] as const)('拒绝不可序列化的中间set %s undefined，保留原文档和历史', (key) => {
    const store = setup();
    const before = structuredClone(store.getView());
    expect(
      store.commit({
        patches: [
          { op: 'set', path: ['content', 'nodes', 'a', key], value: undefined },
          { op: 'set', path: ['content', 'nodes', 'a', key], value: key === 'zIndex' ? 'a1' : true }
        ]
      })
    ).toBeNull();
    expect(store.getView()).toEqual(before);
    expect(store.canUndo).toBe(false);
  });

  it('明确unset后补回可保存完整历史，恢复undo和redo均保持', () => {
    const store = setup();
    expect(
      store.commit({
        patches: [
          { op: 'unset', path: ['content', 'nodes', 'a', 'zIndex'] },
          { op: 'set', path: ['content', 'nodes', 'a', 'zIndex'], value: 'a1' }
        ]
      })
    ).not.toBeNull();
    for (const undone of [false, true]) {
      if (undone) store.undo();
      const target = new DocumentStore();
      expect(
        target.restoreRecovery(
          JSON.parse(JSON.stringify(store.getView())),
          JSON.parse(JSON.stringify(store.getHistorySnapshot()))
        ).ok
      ).toBe(true);
      if (undone) {
        target.redo();
        expect(target.getNode('a')!.zIndex).toBe('a1');
      } else {
        target.undo();
        expect(target.getNode('a')!.zIndex).toBe('a0');
      }
      expect(parseCanvasHistory(target.getView(), JSON.parse(JSON.stringify(target.getHistorySnapshot()))).ok).toBe(
        true
      );
    }
  });
});
