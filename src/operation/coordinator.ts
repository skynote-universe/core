/**
 * @file coordinator.ts
 * @description 画布操作协调器与撤销/重做历史栈引擎
 *
 * 设计考量 (Why):
 * 1. 状态流转红线 (AGENTS.md)：所有对画布文档的修改必须通过 commitOperation 统一提交。
 * 2. 撤销栈协同隔离：严格遵守 origin === 'local' 才准入撤销栈，远端协同同步来的 patch 绝不污染本地用户的 Undo 历史。
 * 3. 连续操作智能折叠 (Squashing)：支持连续拖拽/微调共用同一个 groupId，自动将其合并为单个历史步长，杜绝一次拖拽产生数百步撤销；
 *    合并时再对同一路径的整值覆盖做压缩（正向留最后一次、逆向留最早一次），一次拖拽无论多长都只保留常数条补丁。
 * 4. 扁平数组历史栈，定长截断防内存泄漏，事件通知精简直接。
 * 5. 历史不可变：提交入口深拷贝补丁，调用方事后修改自己持有的补丁对象不会篡改撤销栈与广播出去的记录。
 * 6. 冲突即丢弃：撤销/重做若因远端并发改动而无法执行（如目标实体已被删除），该条目整体作废并通知历史栈变化，
 *    不做部分回放，保证每一步撤销都是完整的原子事务。
 * 7. 事务内派生：可注册派生函数，在本地事务执行后基于新状态补充派生补丁 (如文本排版得出的尺寸)，
 *    与原补丁合并为同一条记录，撤销时一并回退；远端事务不派生，以发送方结果为准，避免各端测量差异导致分歧。
 */

import type {
  CanvasOperationRecord,
  CommitOperationOptions,
  CanvasHistoryEntry,
  CanvasPatch
} from '../types/operation';
import { applyPatches } from './patch-applier';
import { getValueByPath, normalizePatchPath } from './patch-path';
import { OverwriteCompactor } from './overwrite-compactor';
import { isEqual } from '../utils/equality';
import { generateId } from '../utils/id';
import { clonePlainData } from '../utils/clone';

/**
 * 派生补丁函数：接收已应用原补丁的文档与本次原补丁，返回需要追加到同一事务的补丁
 * 仅对本地事务调用；撤销/重做直接回放记录，不再派生
 */
export type PatchDerivation<TDoc> = (doc: TDoc, patches: readonly CanvasPatch[]) => CanvasPatch[];

/** 操作提交事件回调 */
export type OperationListener<TDoc = unknown> = (record: CanvasOperationRecord, doc: TDoc) => void;

/** 历史栈状态变更回调 */
export type HistoryChangeListener = (state: { canUndo: boolean; canRedo: boolean }) => void;

/** 协调器配置项 */
export interface OperationCoordinatorOptions {
  /** 历史栈最大记录数 (默认 100) */
  maxHistorySize?: number;
}

export class OperationCoordinator<TDoc extends object = Record<string, unknown>> {
  private readonly targetDoc: TDoc;
  private readonly maxHistorySize: number;

  private readonly undoStack: CanvasHistoryEntry[] = [];
  private readonly redoStack: CanvasHistoryEntry[] = [];

  private readonly operationListeners = new Set<OperationListener<TDoc>>();
  private readonly historyListeners = new Set<HistoryChangeListener>();

  /** 标记当前是否正处于 undo/redo 执行期间，防止循环入栈 */
  private isApplyingHistory = false;

  /** 事务内派生的各段，按序执行 (如文字自动尺寸 → 布局排版)：后段读到前段应用后的文档 */
  private derivations: readonly PatchDerivation<TDoc>[] = [];
  /** 栈顶分组条目的增量压缩状态：同组后续操作只处理新增补丁 */
  private groupCompaction: { entryId: string; forward: OverwriteCompactor; inverse: OverwriteCompactor } | null = null;
  /** 进行中的批处理：期间的可撤销本地事务以同一分组并入一个撤销条目 */
  private activeBatch: { groupId: string; label: string | undefined } | null = null;

  constructor(targetDoc: TDoc, options?: OperationCoordinatorOptions) {
    this.targetDoc = targetDoc;
    this.maxHistorySize = options?.maxHistorySize ?? 100;
  }

  /** 设置事务内派生的各段 (按序执行，每段收到本事务至此的全部补丁) */
  setPatchDerivations(derivations: readonly PatchDerivation<TDoc>[]): void {
    this.derivations = derivations;
  }

  /** 是否可撤销 */
  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  /** 是否可重做 */
  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /**
   * 批处理：fn 内提交的可撤销本地事务合并为一步撤销，嵌套调用并入最外层
   * 每次提交仍即时生效并广播，后续语义操作能读到前序结果 (如先建节点再连线)；
   * fn 抛错时撤回本批已记录的改动再抛出，不留下半个批次
   */
  batch<T>(fn: () => T, label?: string): T {
    if (this.activeBatch) return fn();
    const batch = { groupId: generateId('batch'), label };
    this.activeBatch = batch;
    try {
      return fn();
    } catch (err) {
      if (this.undoStack.at(-1)?.groupId === batch.groupId && this.undo()) {
        // 回滚不是用户的撤销，不应留下可重做的条目
        this.redoStack.pop();
        this.notifyHistoryChanged();
      }
      throw err;
    } finally {
      this.activeBatch = null;
    }
  }

  /**
   * 提交原子事务操作
   * 所有对文档状态的增删改查必须经由此通道
   */
  commitOperation(options: CommitOperationOptions): CanvasOperationRecord | null {
    if (options.patches.length === 0) {
      return null;
    }

    const origin = options.origin ?? 'local';
    const source = options.source ?? 'user';
    const label = this.activeBatch?.label ?? options.label ?? '修改画布';
    const undoable = options.undoable ?? true;

    // 先决条件守卫校验
    if (options.guard) {
      const actual = getValueByPath(this.targetDoc, options.guard.path);
      if (!isEqual(actual, options.guard.expected)) {
        console.error(
          `[SkyNote:OperationCoordinator] 事务前置守卫校验失败: 路径 ${JSON.stringify(options.guard.path)} 期望值 ${JSON.stringify(options.guard.expected)}, 实际值 ${JSON.stringify(actual)}`
        );
        return null;
      }
    }

    const patches = clonePlainData(options.patches);
    const applyResult = applyPatches(this.targetDoc, patches);
    if (!applyResult.success) {
      console.error('[SkyNote:OperationCoordinator] 补丁事务执行失败，已自动回滚:', applyResult.error);
      return null;
    }

    // 优先使用显式传入的逆向补丁，未传入时使用应用器推导出的对偶补丁
    let finalPatches = patches;
    let finalInversePatches = options.inversePatches
      ? clonePlainData(options.inversePatches)
      : applyResult.inversePatches;

    if (origin === 'local') {
      // 回滚用的是应用器推导的对偶补丁 (与显式传入的逆向补丁无关)，失败时整体撤回已应用的各段
      let appliedInverse = applyResult.inversePatches;
      for (const derivation of this.derivations) {
        const derived = clonePlainData(derivation(this.targetDoc, finalPatches));
        if (derived.length === 0) continue;
        const derivedResult = applyPatches(this.targetDoc, derived);
        if (!derivedResult.success) {
          applyPatches(this.targetDoc, [...appliedInverse].reverse());
          console.error('[SkyNote:OperationCoordinator] 派生补丁执行失败，整个事务已回滚:', derivedResult.error);
          return null;
        }
        appliedInverse = [...appliedInverse, ...derivedResult.inversePatches];
        finalPatches = [...finalPatches, ...derived];
        finalInversePatches = [...finalInversePatches, ...derivedResult.inversePatches];
      }
    }

    const record: CanvasOperationRecord = {
      id: generateId('op'),
      label,
      timestamp: Date.now(),
      origin,
      source,
      undoable,
      groupId: this.activeBatch?.groupId ?? options.groupId,
      patches: finalPatches,
      inversePatches: finalInversePatches,
      payload: options.payload
    };

    // 历史栈管理：仅当处于用户本地操作、标记为可撤销、且非回放中时，记录到历史栈
    if (undoable && origin === 'local' && !this.isApplyingHistory) {
      this.recordToHistory(record);
    }

    // 通知事务监听者
    this.notifyOperationCommitted(record);

    return record;
  }

  /** 撤销上一步操作；冲突时该条目作废 */
  undo(): boolean {
    return this.replay('undo');
  }

  /** 重做上一步撤销的操作；冲突时该条目作废 */
  redo(): boolean {
    return this.replay('redo');
  }

  /**
   * 清空历史栈
   */
  clearHistory(): void {
    if (this.undoStack.length === 0 && this.redoStack.length === 0) {
      return;
    }
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.groupCompaction = null;
    this.notifyHistoryChanged();
  }

  /** 订阅事务提交通知 */
  onOperation(listener: OperationListener<TDoc>): () => void {
    this.operationListeners.add(listener);
    return () => {
      this.operationListeners.delete(listener);
    };
  }

  /** 订阅历史栈状态变化 */
  onHistoryChange(listener: HistoryChangeListener): () => void {
    this.historyListeners.add(listener);
    // 立即通知当前初始状态
    listener({ canUndo: this.canUndo, canRedo: this.canRedo });
    return () => {
      this.historyListeners.delete(listener);
    };
  }

  /** 撤销栈 (旧 → 新)，供调试与界面展示 */
  get undoEntries(): readonly CanvasHistoryEntry[] {
    return this.undoStack;
  }

  /**
   * 回放一个历史条目：撤销倒序应用逆向补丁，重做顺序应用正向补丁，成功后移入另一个栈并广播系统记录
   * 回放期间提交的事务不入栈，防止循环记录
   */
  private replay(direction: 'undo' | 'redo'): boolean {
    const [from, to] = direction === 'undo' ? [this.undoStack, this.redoStack] : [this.redoStack, this.undoStack];
    if (from.length === 0 || this.isApplyingHistory) return false;
    const entry = from.pop()!;
    const patches = direction === 'undo' ? [...entry.inversePatches].reverse() : entry.patches;

    this.isApplyingHistory = true;
    try {
      const result = applyPatches(this.targetDoc, patches);
      if (!result.success) {
        console.error(
          `[SkyNote:OperationCoordinator] ${direction === 'undo' ? '撤销' : '重做'}冲突，已作废该历史条目:`,
          result.error
        );
        this.notifyHistoryChanged();
        return false;
      }
      to.push(entry);
      this.notifyOperationCommitted({
        id: generateId(`op_${direction}`),
        label: `${direction === 'undo' ? '撤销' : '重做'}: ${entry.label}`,
        timestamp: Date.now(),
        origin: 'local',
        source: 'system',
        undoable: false,
        patches,
        inversePatches: direction === 'undo' ? entry.patches : entry.inversePatches
      });
      this.notifyHistoryChanged();
      return true;
    } finally {
      this.isApplyingHistory = false;
    }
  }

  /**
   * 记录到撤销栈，支持同 groupId 的连续操作智能折叠
   */
  private recordToHistory(record: CanvasOperationRecord): void {
    const lastEntry = this.undoStack.length > 0 ? this.undoStack[this.undoStack.length - 1] : null;

    // 连续操作折叠逻辑：同一 groupId 的连续操作合并为单一条目
    if (record.groupId && lastEntry && lastEntry.groupId === record.groupId) {
      let state = this.groupCompaction;
      if (!state || state.entryId !== lastEntry.id) {
        state = {
          entryId: lastEntry.id,
          forward: new OverwriteCompactor('last'),
          inverse: new OverwriteCompactor('first')
        };
        state.forward.push(lastEntry.patches);
        state.inverse.push(lastEntry.inversePatches);
        this.groupCompaction = state;
      }
      state.forward.push(record.patches);
      state.inverse.push(record.inversePatches);

      const mergedEntry: CanvasHistoryEntry = {
        id: lastEntry.id,
        label: record.label || lastEntry.label,
        timestamp: record.timestamp,
        groupId: record.groupId,
        // 正向补丁依次累积，逆向补丁保持自然时间序（undo 时整体倒序执行）
        patches: state.forward.toArray(),
        inversePatches: state.inverse.toArray()
      };

      // 同组改动回到了组开始前的状态 (如新建空文字后什么都没输入就移除)：不留下撤销后毫无变化的空步骤
      if (isNetNoOp(mergedEntry)) {
        this.undoStack.pop();
        this.groupCompaction = null;
      } else {
        this.undoStack[this.undoStack.length - 1] = mergedEntry;
      }
    } else {
      const entry: CanvasHistoryEntry = {
        id: record.id,
        label: record.label,
        timestamp: record.timestamp,
        groupId: record.groupId,
        patches: record.patches,
        inversePatches: record.inversePatches
      };

      this.undoStack.push(entry);

      // 超出最大容量限制时丢弃最老的条目
      if (this.undoStack.length > this.maxHistorySize) {
        this.undoStack.shift();
      }
    }

    // 产生新的本地有效操作时，清空重做栈
    this.redoStack.length = 0;
    this.notifyHistoryChanged();
  }

  private notifyOperationCommitted(record: CanvasOperationRecord): void {
    for (const listener of this.operationListeners) {
      try {
        listener(record, this.targetDoc);
      } catch (err) {
        console.error('[SkyNote:OperationCoordinator] 事务监听回调异常:', err);
      }
    }
  }

  private notifyHistoryChanged(): void {
    const state = { canUndo: this.canUndo, canRedo: this.canRedo };
    for (const listener of this.historyListeners) {
      try {
        listener(state);
      } catch (err) {
        console.error('[SkyNote:OperationCoordinator] 历史栈监听回调异常:', err);
      }
    }
  }
}

/**
 * 合并后的条目是否没有净效果：每个路径最终的正向值都等于逆向补丁记下的原值
 * 只判断整体覆盖与删除 (set / unset)；含合并写入或数组切片时保守视为有效果
 */
function isNetNoOp(entry: CanvasHistoryEntry): boolean {
  const original = new Map<string, CanvasPatch>();
  for (const patch of entry.inversePatches) {
    if ((patch.op !== 'set' && patch.op !== 'unset') || (patch.op === 'set' && patch.merge)) return false;
    original.set(JSON.stringify(normalizePatchPath(patch.path)), patch);
  }
  return entry.patches.every((patch) => {
    if ((patch.op !== 'set' && patch.op !== 'unset') || (patch.op === 'set' && patch.merge)) return false;
    const before = original.get(JSON.stringify(normalizePatchPath(patch.path)));
    if (!before) return false;
    if (patch.op === 'unset') return before.op === 'unset';
    return before.op === 'set' && isEqual(patch.value, before.value);
  });
}
