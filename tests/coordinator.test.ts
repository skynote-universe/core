/**
 * @file coordinator.test.ts
 * @description 操作协调器、历史栈、groupId 折叠与 guard 先决条件守卫测试
 */

import { describe, it, expect } from 'vitest';
import { OperationCoordinator } from '../src/operation/coordinator';

describe('OperationCoordinator', () => {
  it('维护冻结覆盖本地、远端事务和历史，嵌套恢复不提前放行', () => {
    const doc = { count: 0 };
    const coordinator = new OperationCoordinator(doc);
    coordinator.commitOperation({ patches: [{ op: 'set', path: 'count', value: 1 }] });
    coordinator.commitOperation({ patches: [{ op: 'set', path: 'count', value: 2 }] });
    coordinator.undo();
    const before = coordinator.getHistorySnapshot();
    const resume = coordinator.suspendWrites();
    const resumeNested = coordinator.suspendWrites();
    for (const origin of ['local', 'remote'] as const)
      expect(coordinator.commitOperation({ origin, patches: [{ op: 'set', path: 'count', value: 9 }] })).toBeNull();
    coordinator.batch(() => coordinator.commitOperation({ patches: [{ op: 'set', path: 'count', value: 9 }] }));
    expect(coordinator.undo()).toBe(false);
    expect(coordinator.redo()).toBe(false);
    coordinator.clearHistory();
    expect(coordinator.getHistorySnapshot()).toEqual(before);
    expect(doc.count).toBe(1);
    resume();
    resume();
    expect(coordinator.redo()).toBe(false);
    resumeNested();
    expect(coordinator.redo()).toBe(true);
    expect(doc.count).toBe(2);
  });

  it('拒绝从批处理或事务派生中途冻结，既有批次仍能回滚', () => {
    const doc = { count: 0 };
    const coordinator = new OperationCoordinator(doc);
    expect(() =>
      coordinator.batch(() => {
        coordinator.commitOperation({ patches: [{ op: 'set', path: 'count', value: 1 }] });
        coordinator.suspendWrites();
      })
    ).toThrow('事务执行期间');
    expect(doc.count).toBe(0);
    coordinator.setPatchDerivations([
      () => {
        expect(() => coordinator.suspendWrites()).toThrow('事务执行期间');
        return [];
      }
    ]);
    expect(coordinator.commitOperation({ patches: [{ op: 'set', path: 'count', value: 2 }] })).not.toBeNull();
  });

  it('公开历史快照覆盖撤销和重做并深拷贝，修改副本不影响历史执行', () => {
    const document = { data: { value: 0 } };
    const coordinator = new OperationCoordinator(document, { maxHistorySize: 2 });
    for (const value of [1, 2, 3])
      coordinator.commitOperation({ patches: [{ op: 'set', path: 'data', value: { value } }] });
    coordinator.undo();
    const snapshot = coordinator.getHistorySnapshot();
    expect(snapshot.undo).toHaveLength(1);
    expect(snapshot.redo).toHaveLength(1);
    const patch = snapshot.redo[0].patches[0];
    if (patch.op !== 'set') throw new Error('测试补丁类型错误');
    (patch.value as { value: number }).value = 99;
    coordinator.redo();
    expect(document.data.value).toBe(3);
    expect(snapshot.redo).toHaveLength(1);
    coordinator.clearHistory();
    expect(coordinator.getHistorySnapshot()).toEqual({ undo: [], redo: [] });
  });

  it('提交操作并记录到撤销栈', () => {
    const doc = { count: 0 };
    const coordinator = new OperationCoordinator(doc);

    expect(coordinator.canUndo).toBe(false);
    expect(coordinator.canRedo).toBe(false);

    coordinator.commitOperation({
      label: '自增',
      patches: [{ op: 'set', path: 'count', value: 1 }]
    });

    expect(doc.count).toBe(1);
    expect(coordinator.canUndo).toBe(true);
    expect(coordinator.canRedo).toBe(false);

    // 撤销
    const undoSuccess = coordinator.undo();
    expect(undoSuccess).toBe(true);
    expect(doc.count).toBe(0);
    expect(coordinator.canUndo).toBe(false);
    expect(coordinator.canRedo).toBe(true);

    // 重做
    const redoSuccess = coordinator.redo();
    expect(redoSuccess).toBe(true);
    expect(doc.count).toBe(1);
    expect(coordinator.canUndo).toBe(true);
    expect(coordinator.canRedo).toBe(false);
  });

  it('连续操作通过 groupId 智能折叠为单步撤销', () => {
    const doc = { x: 0 };
    const coordinator = new OperationCoordinator(doc);
    const groupId = 'drag_session_1';

    // 模拟连续拖拽产生 3 帧移动
    coordinator.commitOperation({
      label: '拖拽移动',
      groupId,
      patches: [{ op: 'set', path: 'x', value: 10 }]
    });
    coordinator.commitOperation({
      label: '拖拽移动',
      groupId,
      patches: [{ op: 'set', path: 'x', value: 20 }]
    });
    coordinator.commitOperation({
      label: '拖拽移动',
      groupId,
      patches: [{ op: 'set', path: 'x', value: 50 }]
    });

    expect(doc.x).toBe(50);
    // 历史栈中只有 1 个折叠后的 entry
    expect(coordinator.undoEntries.length).toBe(1);

    // 单次撤销即可直接倒退回拖拽前的原始状态 0
    coordinator.undo();
    expect(doc.x).toBe(0);

    // 单次重做恢复为 50
    coordinator.redo();
    expect(doc.x).toBe(50);
  });

  it('guard 先决条件守卫：断言通过才允许提交，失败时拒绝提交', () => {
    const doc = { version: 1, text: '旧内容' };
    const coordinator = new OperationCoordinator(doc);

    // 断言失败：期望 version 为 2，实际为 1
    const failRecord = coordinator.commitOperation({
      label: '乐观锁更新',
      guard: { path: 'version', expected: 2 },
      patches: [{ op: 'set', path: 'text', value: '新内容' }]
    });

    expect(failRecord).toBeNull();
    expect(doc.text).toBe('旧内容');

    // 断言成功：期望 version 为 1
    const passRecord = coordinator.commitOperation({
      label: '乐观锁更新成功',
      guard: { path: 'version', expected: 1 },
      patches: [
        { op: 'set', path: 'text', value: '新内容' },
        { op: 'set', path: 'version', value: 2 }
      ]
    });

    expect(passRecord).not.toBeNull();
    expect(doc.text).toBe('新内容');
    expect(doc.version).toBe(2);
  });

  it('协同隔离：origin === "remote" 的操作不写入本地 Undo 栈', () => {
    const doc = { title: '初始标题' };
    const coordinator = new OperationCoordinator(doc);

    // 接收来自协同网络的远端补丁
    coordinator.commitOperation({
      label: '远端协作者修改标题',
      origin: 'remote',
      patches: [{ op: 'set', path: 'title', value: '远端标题' }]
    });

    expect(doc.title).toBe('远端标题');
    // 远端补丁不能被本地用户通过 Ctrl+Z 撤销污染
    expect(coordinator.canUndo).toBe(false);
  });

  it('undoable === false 时不入历史栈', () => {
    const doc = { zoom: 1 };
    const coordinator = new OperationCoordinator(doc);

    coordinator.commitOperation({
      label: '视口缩放',
      undoable: false,
      patches: [{ op: 'set', path: 'zoom', value: 2 }]
    });

    expect(doc.zoom).toBe(2);
    expect(coordinator.canUndo).toBe(false);
  });

  it('超出最大容量时丢弃最老的记录', () => {
    const doc = { num: 0 };
    const coordinator = new OperationCoordinator(doc, { maxHistorySize: 3 });

    for (let i = 1; i <= 5; i++) {
      coordinator.commitOperation({
        label: `步长 ${i}`,
        patches: [{ op: 'set', path: 'num', value: i }]
      });
    }

    expect(coordinator.undoEntries.length).toBe(3);
    const entries = coordinator.undoEntries;
    expect(entries[0].label).toBe('步长 3');
    expect(entries[1].label).toBe('步长 4');
    expect(entries[2].label).toBe('步长 5');
  });

  it('同组折叠时压缩同一路径的整值覆盖：长拖拽只保留常数条补丁，撤销/重做结果不变', () => {
    const doc = { node: { x: 0, y: 0 } };
    const coordinator = new OperationCoordinator(doc);

    for (let i = 1; i <= 300; i++) {
      coordinator.commitOperation({
        groupId: 'drag',
        patches: [
          { op: 'set', path: 'node.x', value: i },
          { op: 'set', path: 'node.y', value: i * 2 }
        ]
      });
    }

    const [entry] = coordinator.undoEntries;
    expect(entry.patches).toHaveLength(2);
    expect(entry.inversePatches).toHaveLength(2);

    coordinator.undo();
    expect(doc.node).toEqual({ x: 0, y: 0 });
    coordinator.redo();
    expect(doc.node).toEqual({ x: 300, y: 600 });
  });

  it('覆盖之间有祖先/后代路径介入时不压缩，保证回放语义', () => {
    const doc: { style: Record<string, unknown> } = { style: { fill: 'a', stroke: 'k' } };
    const coordinator = new OperationCoordinator(doc);
    const steps = [
      { op: 'set', path: 'style.fill', value: 'b' },
      { op: 'set', path: 'style', value: { fill: 'c' } },
      { op: 'set', path: 'style.fill', value: 'd' },
      { op: 'set', path: 'style', merge: true, value: { stroke: 'z' } },
      { op: 'set', path: 'style.fill', value: 'e' }
    ] as const;

    for (const patch of steps) {
      coordinator.commitOperation({ groupId: 'edit', patches: [patch] });
    }
    expect(doc.style).toEqual({ fill: 'e', stroke: 'z' });

    coordinator.undo();
    expect(doc.style).toEqual({ fill: 'a', stroke: 'k' });
    coordinator.redo();
    expect(doc.style).toEqual({ fill: 'e', stroke: 'z' });
  });
});

describe('同组改动的净效果', () => {
  it('同组改动回到组开始前的状态时不留下撤销条目', () => {
    const doc: { label?: string; x: number } = { x: 0 };
    const coordinator = new OperationCoordinator(doc);
    coordinator.commitOperation({ label: '移动', patches: [{ op: 'set', path: ['x'], value: 5 }] });
    coordinator.commitOperation({
      label: '加文字',
      groupId: 'g',
      patches: [{ op: 'set', path: ['label'], value: '' }]
    });
    coordinator.commitOperation({ label: '删空', groupId: 'g', patches: [{ op: 'unset', path: ['label'] }] });
    expect(coordinator.undoEntries.map((entry) => entry.label)).toEqual(['移动']);

    // 有净效果的同组改动照常保留
    coordinator.commitOperation({ label: '拖动', groupId: 'h', patches: [{ op: 'set', path: ['x'], value: 8 }] });
    coordinator.commitOperation({ label: '拖动', groupId: 'h', patches: [{ op: 'set', path: ['x'], value: 9 }] });
    expect(coordinator.undoEntries).toHaveLength(2);
    coordinator.undo();
    expect(doc.x).toBe(5);
  });
});
