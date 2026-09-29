/**
 * @file coordinator.ts
 * @description 画布操作协调器与撤销/重做历史栈引擎
 * 
 * 设计考量 (Why):
 * 1. 状态流转红线 (AGENTS.md)：所有对画布文档的修改必须通过 commitOperation 统一提交。
 * 2. 撤销栈协同隔离：严格遵守 origin === 'local' 才准入撤销栈，远端协同同步来的 patch 绝不污染本地用户的 Undo 历史。
 * 3. 连续操作智能折叠 (Squashing)：支持连续拖拽/微调共用同一个 groupId，自动将其合并为单个历史步长，杜绝一次拖拽产生数百步撤销；
 *    合并时再对同一路径的整值覆盖做压缩（正向留最后一次、逆向留最早一次），一次拖拽无论多长都只保留常数条补丁。
 * 4. 极致性能与零套娃：纯扁平数组历史栈，定长截断防内存泄漏，事件通知精简直接。
 * 5. 历史不可变：提交入口深拷贝补丁，调用方事后修改自己持有的补丁对象不会篡改撤销栈与广播出去的记录。
 * 6. 冲突即丢弃：撤销/重做若因远端并发改动而无法执行（如目标实体已被删除），该条目整体作废并通知历史栈变化，
 *    不做部分回放，保证每一步撤销都是完整的原子事务。
 */

import type {
  CanvasOperationRecord,
  CommitOperationOptions,
  CanvasHistoryEntry,
  CanvasPatch
} from '../types/operation';
import { applyPatches } from './patch-applier';
import { getValueByPath, normalizePatchPath } from './patch-path';
import { isEqual } from '../utils/equality';
import { generateId } from '../utils/id';
import { clonePlainData } from '../utils/clone';

/** 整值覆盖补丁：非 merge 的 set 与 unset，执行结果只取决于自身，与该路径此前的值无关 */
function isOverwritePatch(patch: CanvasPatch): boolean {
  return (patch.op === 'set' && !patch.merge) || patch.op === 'unset';
}

/** 两条路径是否互为祖先/后代或完全相同 */
function arePathsRelated(a: readonly (string | number)[], b: readonly (string | number)[]): boolean {
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * 压缩同一路径上的连续整值覆盖
 * 两次覆盖之间若有祖先/后代路径的补丁介入（如先改 style.fill 再整体覆盖 style），保守地不做压缩
 * @param keep 'last' 用于正向补丁 (最终值生效)；'first' 用于逆向补丁 (倒序回放时最早的旧值最后生效)
 */
function compactOverwrites(patches: readonly CanvasPatch[], keep: 'first' | 'last'): CanvasPatch[] {
  const segmentsList = patches.map((patch) => normalizePatchPath(patch.path));
  const dropped = new Set<number>();
  /** 路径键 -> 当前可被合并的覆盖补丁下标 */
  const candidates = new Map<string, number>();

  for (let i = 0; i < patches.length; i++) {
    const segments = segmentsList[i];
    const key = segments.join('\u0000');
    const previous = isOverwritePatch(patches[i]) ? candidates.get(key) : undefined;

    // 任何补丁都会让与之相关、但路径不完全相同的候选失效
    for (const [candidateKey, index] of candidates) {
      if (candidateKey !== key && arePathsRelated(segmentsList[index], segments)) {
        candidates.delete(candidateKey);
      }
    }

    if (previous === undefined) {
      if (isOverwritePatch(patches[i])) candidates.set(key, i);
      else candidates.delete(key);
      continue;
    }

    if (keep === 'last') {
      dropped.add(previous);
      candidates.set(key, i);
    } else {
      dropped.add(i);
    }
  }

  return dropped.size === 0 ? [...patches] : patches.filter((_, i) => !dropped.has(i));
}

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

  constructor(targetDoc: TDoc, options?: OperationCoordinatorOptions) {
    this.targetDoc = targetDoc;
    this.maxHistorySize = options?.maxHistorySize ?? 100;
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
   * 提交原子事务操作
   * 所有对文档状态的增删改查必须经由此通道
   */
  commitOperation(options: CommitOperationOptions): CanvasOperationRecord | null {
    if (options.patches.length === 0) {
      return null;
    }

    const origin = options.origin ?? 'local';
    const source = options.source ?? 'user';
    const label = options.label ?? '修改画布';
    const undoable = options.undoable ?? true;

    // 先决条件守卫校验
    if (options.guard) {
      const actual = getValueByPath(this.targetDoc, options.guard.path);
      if (!isEqual(actual, options.guard.expected)) {
        console.error(
          `[OperationCoordinator] 事务前置守卫校验失败: 路径 ${JSON.stringify(options.guard.path)} 期望值 ${JSON.stringify(options.guard.expected)}, 实际值 ${JSON.stringify(actual)}`
        );
        return null;
      }
    }

    const patches = clonePlainData(options.patches);
    const applyResult = applyPatches(this.targetDoc, patches);
    if (!applyResult.success) {
      console.error('[OperationCoordinator] 补丁事务执行失败，已自动回滚:', applyResult.error);
      return null;
    }

    // 优先使用显式传入的逆向补丁，未传入时使用应用器推导出的对偶补丁
    const finalInversePatches = options.inversePatches
      ? clonePlainData(options.inversePatches)
      : applyResult.inversePatches;

    const record: CanvasOperationRecord = {
      id: generateId('op'),
      label,
      timestamp: Date.now(),
      origin,
      source,
      undoable,
      groupId: options.groupId,
      patches,
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

  /**
   * 撤销上一步操作
   */
  undo(): boolean {
    if (!this.canUndo || this.isApplyingHistory) {
      return false;
    }

    const entry = this.undoStack.pop();
    if (!entry) {
      return false;
    }

    this.isApplyingHistory = true;
    try {
      // 倒序应用逆向补丁
      const reversedInverse = [...entry.inversePatches].reverse();
      const result = applyPatches(this.targetDoc, reversedInverse);

      if (!result.success) {
        console.error('[OperationCoordinator] 撤销冲突，已作废该历史条目:', result.error);
        this.notifyHistoryChanged();
        return false;
      }

      // 撤销成功，将原操作推入 redo 栈
      this.redoStack.push(entry);

      // 广播虚拟操作记录供外部感知
      const undoRecord: CanvasOperationRecord = {
        id: generateId('op_undo'),
        label: `撤销: ${entry.label}`,
        timestamp: Date.now(),
        origin: 'local',
        source: 'system',
        undoable: false,
        patches: reversedInverse,
        inversePatches: entry.patches
      };

      this.notifyOperationCommitted(undoRecord);
      this.notifyHistoryChanged();
      return true;
    } finally {
      this.isApplyingHistory = false;
    }
  }

  /**
   * 重做上一步撤销的操作
   */
  redo(): boolean {
    if (!this.canRedo || this.isApplyingHistory) {
      return false;
    }

    const entry = this.redoStack.pop();
    if (!entry) {
      return false;
    }

    this.isApplyingHistory = true;
    try {
      // 重新执行正向补丁
      const result = applyPatches(this.targetDoc, entry.patches);

      if (!result.success) {
        console.error('[OperationCoordinator] 重做冲突，已作废该历史条目:', result.error);
        this.notifyHistoryChanged();
        return false;
      }

      // 重新推回 undo 栈
      this.undoStack.push(entry);

      const redoRecord: CanvasOperationRecord = {
        id: generateId('op_redo'),
        label: `重做: ${entry.label}`,
        timestamp: Date.now(),
        origin: 'local',
        source: 'system',
        undoable: false,
        patches: entry.patches,
        inversePatches: entry.inversePatches
      };

      this.notifyOperationCommitted(redoRecord);
      this.notifyHistoryChanged();
      return true;
    } finally {
      this.isApplyingHistory = false;
    }
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

  /** 获取当前撤销栈快照（调试与持久化用途） */
  getUndoEntries(): readonly CanvasHistoryEntry[] {
    return this.undoStack;
  }

  /** 获取当前重做栈快照 */
  getRedoEntries(): readonly CanvasHistoryEntry[] {
    return this.redoStack;
  }

  /**
   * 记录到撤销栈，支持同 groupId 的连续操作智能折叠
   */
  private recordToHistory(record: CanvasOperationRecord): void {
    const lastEntry = this.undoStack.length > 0 ? this.undoStack[this.undoStack.length - 1] : null;

    // 连续操作折叠逻辑：同一 groupId 的连续操作合并为单一条目
    if (record.groupId && lastEntry && lastEntry.groupId === record.groupId) {
      const mergedEntry: CanvasHistoryEntry = {
        id: lastEntry.id,
        label: record.label || lastEntry.label,
        timestamp: record.timestamp,
        groupId: record.groupId,
        // 正向补丁依次累积，逆向补丁保持自然时间序（undo 时整体倒序执行）
        patches: compactOverwrites([...lastEntry.patches, ...record.patches], 'last'),
        inversePatches: compactOverwrites([...lastEntry.inversePatches, ...record.inversePatches], 'first')
      };

      this.undoStack[this.undoStack.length - 1] = mergedEntry;
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
        console.error('[OperationCoordinator] 事务监听回调异常:', err);
      }
    }
  }

  private notifyHistoryChanged(): void {
    const state = { canUndo: this.canUndo, canRedo: this.canRedo };
    for (const listener of this.historyListeners) {
      try {
        listener(state);
      } catch (err) {
        console.error('[OperationCoordinator] 历史栈监听回调异常:', err);
      }
    }
  }
}
