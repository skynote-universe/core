import { describe, expect, it } from 'vitest';
import { DocumentStore, createEmptyCanvasDocument, parseCanvasHistory } from '../src';

function setup() {
  const store = new DocumentStore();
  store.commit({ patches: [{ op: 'set', path: ['name'], value: 'first' }] });
  store.commit({ patches: [{ op: 'set', path: ['name'], value: 'second' }] });
  store.commit({ patches: [{ op: 'set', path: ['name'], value: 'third' }] });
  store.undo();
  return { doc: structuredClone(store.getView()), history: store.getHistorySnapshot() };
}

describe('不可信历史的独立双向校验', () => {
  it('验证完整撤销和重做分支并返回独立副本，不修改输入', () => {
    const { doc, history } = setup();
    const before = structuredClone({ doc, history });
    const result = parseCanvasHistory(doc, history);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual(history);
      expect(result.value.undo[0]).not.toBe(history.undo[0]);
    }
    expect({ doc, history }).toEqual(before);
  });
  it('正向能执行但逆向不匹配、旧快照和断链均拒绝', () => {
    const { doc, history } = setup();
    const bad = structuredClone(history);
    bad.undo[1].patches[0] = { op: 'set', path: ['name'], value: 'wrong' };
    expect(parseCanvasHistory(doc, bad).ok).toBe(false);
    expect(parseCanvasHistory(createEmptyCanvasDocument(), history).ok).toBe(false);
    const redo = structuredClone(history);
    redo.redo[0].inversePatches[0] = { op: 'set', path: ['name'], value: 'wrong' };
    expect(parseCanvasHistory(doc, redo).ok).toBe(false);
  });
  it('格式、危险路径、重复身份、循环及预算上限不能绕过', () => {
    const { doc, history } = setup();
    for (const value of [
      null,
      {},
      { undo: [], redo: [null] },
      { undo: [history.undo[0], history.undo[0]], redo: [] },
      { undo: Array(2001).fill(history.undo[0]), redo: [] }
    ])
      expect(parseCanvasHistory(doc, value).ok).toBe(false);
    for (const patch of [
      { op: 'set', path: ['__proto__', 'polluted'], value: true },
      { op: 'set', path: ['name'] },
      { op: 'splice', path: ['name'], index: -1, deleteCount: 0 },
      { op: 'text', path: ['name'], deltas: [{ retain: -1 }] },
      { op: 'unknown', path: ['name'] }
    ]) {
      const changed = { undo: [{ ...history.undo[0], patches: [patch] }], redo: [] };
      expect(parseCanvasHistory(doc, changed).ok).toBe(false);
    }
    const cycle = { undo: [], redo: [], cycle: {} as unknown };
    cycle.cycle = cycle;
    expect(parseCanvasHistory(doc, cycle).ok).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
  it('历史中的非法文档状态拒绝，不因最终可还原而跳过结构守卫', () => {
    const { doc, history } = setup();
    const changed = structuredClone(history);
    changed.redo[0].patches[0] = { op: 'set', path: ['name'], value: 'data:image/png;base64,AA==' };
    expect(parseCanvasHistory(doc, changed).ok).toBe(false);
  });
  it('完整恢复经事务同步更新文档和双栈；损坏与维护期间均不改变原状态', () => {
    const { doc, history } = setup();
    const target = new DocumentStore();
    target.commit({ patches: [{ op: 'set', path: ['name'], value: 'target' }] });
    let observed = false;
    const unsubscribe = target.subscribe(() => {
      observed = true;
      expect(target.getHistorySnapshot()).toEqual(history);
    });
    expect(target.restoreRecovery(doc, history).ok).toBe(true);
    expect(observed).toBe(true);
    unsubscribe();
    expect(target.getView().name).toBe('second');
    target.undo();
    expect(target.getView().name).toBe('first');
    target.redo();
    expect(target.getView().name).toBe('second');
    const before = structuredClone({ document: target.getView(), history: target.getHistorySnapshot() });
    expect(target.restoreRecovery(doc, {}).ok).toBe(false);
    const resume = target.suspendWrites();
    expect(target.restoreRecovery(doc, history).ok).toBe(false);
    resume();
    expect({ document: target.getView(), history: target.getHistorySnapshot() }).toEqual(before);
  });
});
