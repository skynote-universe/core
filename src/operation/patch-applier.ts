/**
 * @file patch-applier.ts
 * @description 现代化正交原子补丁执行引擎与逆向对偶推导器
 * 
 * 设计考量 (Why):
 * 1. 正交原子设计：精简为 'set' | 'unset' | 'splice' | 'text' 四大基础动词，彻底消除 add/replace 二义性。
 * 2. 严格对偶逆向推导：
 *    - set (直接覆盖) -> 若原属性不存在，逆向自动推导为 unset；若存在，推导为 set 旧值。
 *    - set (merge: true) -> 逆向自动推导为旧字段快照的 merge: true set。
 *    - unset -> 逆向自动推导为 set 旧值。
 *    - splice -> 数组切片在相同位置置换插入与删除。
 *    - text -> 针对字符串执行流式 Delta，自动捕获被删文本生成对偶反向 Delta。
 * 3. 极速纯内存执行：微秒级变更，批量中途异常时倒序原子回滚。
 */

import type {
  CanvasPatch,
  SetPatch,
  UnsetPatch,
  SplicePatch,
  TextPatch,
  TextDeltaOp
} from '../types/operation';
import { resolvePathForWrite, getValueByPath } from './patch-path';

/** 补丁应用单步执行结果 */
export interface PatchApplyResult {
  readonly success: boolean;
  /** 自动生成的逆向补丁 */
  readonly inversePatch: CanvasPatch;
  readonly error?: string;
}

/** 批量补丁应用结果 */
export interface BatchPatchApplyResult {
  readonly success: boolean;
  readonly inversePatches: CanvasPatch[];
  readonly failedIndex?: number;
  readonly error?: string;
}

/** 内部浅克隆，防止旧值快照被后续直接引用篡改 */
function cloneValue<T>(val: T): T {
  if (val === null || typeof val !== 'object') {
    return val;
  }
  if (Array.isArray(val)) {
    return [...val] as unknown as T;
  }
  return { ...val };
}

/**
 * 1. 执行 set 补丁 (直接赋值或字典浅合并)
 */
function applySetPatch(root: unknown, patch: SetPatch): PatchApplyResult {
  const loc = resolvePathForWrite(root, patch.path, true);
  if (!loc) {
    return {
      success: false,
      inversePatch: patch,
      error: `无法定位路径: ${JSON.stringify(patch.path)}`
    };
  }

  const { parent, key, currentValue, exists } = loc;
  const parentObj = parent as Record<string | number, unknown>;

  // A. 字典增量浅合并分支 (merge: true)
  if (patch.merge) {
    let targetDict: Record<string, unknown>;
    if (!exists || currentValue === null || typeof currentValue !== 'object') {
      targetDict = {};
      parentObj[key] = targetDict;
    } else {
      targetDict = currentValue as Record<string, unknown>;
    }

    const inverseOldValues: Record<string, unknown> = {};
    const patchKeys = Object.keys(patch.value as object);

    for (let i = 0; i < patchKeys.length; i++) {
      const pKey = patchKeys[i];
      if (Object.prototype.hasOwnProperty.call(targetDict, pKey)) {
        inverseOldValues[pKey] = cloneValue(targetDict[pKey]);
      }
    }

    Object.assign(targetDict, patch.value);

    const inversePatch: SetPatch = {
      op: 'set',
      path: patch.path,
      value: patch.oldValue !== undefined ? patch.oldValue : inverseOldValues,
      merge: true
    };

    return { success: true, inversePatch };
  }

  // B. 直接覆盖赋值分支
  let inversePatch: CanvasPatch;
  if (!exists) {
    // 原先无此属性，逆向补丁为 unset
    inversePatch = {
      op: 'unset',
      path: patch.path
    };
  } else {
    // 原先已有值，逆向补丁为 set 原值
    inversePatch = {
      op: 'set',
      path: patch.path,
      value: patch.oldValue !== undefined ? patch.oldValue : cloneValue(currentValue),
      oldValue: cloneValue(patch.value)
    };
  }

  parentObj[key] = patch.value;
  return { success: true, inversePatch };
}

/**
 * 2. 执行 unset 补丁 (移除属性)
 */
function applyUnsetPatch(root: unknown, patch: UnsetPatch): PatchApplyResult {
  const loc = resolvePathForWrite(root, patch.path, false);
  if (!loc || !loc.exists) {
    // 属性原本就不存在，幂等成功，逆向补丁为空 unset
    return {
      success: true,
      inversePatch: {
        op: 'unset',
        path: patch.path
      }
    };
  }

  const { parent, key, currentValue } = loc;
  const parentObj = parent as Record<string | number, unknown>;
  const deletedVal = currentValue;

  delete parentObj[key];

  // 逆向补丁为 set 恢复该属性
  const inversePatch: SetPatch = {
    op: 'set',
    path: patch.path,
    value: patch.oldValue !== undefined ? patch.oldValue : cloneValue(deletedVal)
  };

  return { success: true, inversePatch };
}

/**
 * 3. 执行 splice 补丁 (数组切片)
 */
function applySplicePatch(root: unknown, patch: SplicePatch): PatchApplyResult {
  const targetArray = getValueByPath(root, patch.path);
  if (!Array.isArray(targetArray)) {
    return {
      success: false,
      inversePatch: patch,
      error: `目标不是数组: ${JSON.stringify(patch.path)}`
    };
  }

  const itemsToInsert = patch.items ?? [];
  const deleted = targetArray.splice(patch.index, patch.deleteCount, ...itemsToInsert);
  const deletedItems = patch.deletedItems !== undefined ? patch.deletedItems : deleted;

  // 对偶逆向操作：在相同位置，删除新插入数量，并插回原被删列表
  const inversePatch: SplicePatch = {
    op: 'splice',
    path: patch.path,
    index: patch.index,
    deleteCount: itemsToInsert.length,
    items: deletedItems,
    deletedItems: itemsToInsert
  };

  return { success: true, inversePatch };
}

/**
 * 4. 执行 text 补丁 (文本差量 Delta 流式更新)
 */
function applyTextPatch(root: unknown, patch: TextPatch): PatchApplyResult {
  const loc = resolvePathForWrite(root, patch.path, false);
  if (!loc) {
    return {
      success: false,
      inversePatch: patch,
      error: `无法定位文本路径: ${JSON.stringify(patch.path)}`
    };
  }

  const { parent, key, currentValue } = loc;
  const originalText = typeof currentValue === 'string' ? currentValue : '';
  const parentObj = parent as Record<string | number, unknown>;

  // 如果已有外部传入的 inverseDeltas，直接消费，否则自动推导
  const inverseDeltas: TextDeltaOp[] = [];
  let resultText = '';
  let readIndex = 0;

  for (let i = 0; i < patch.deltas.length; i++) {
    const op = patch.deltas[i];

    if ('retain' in op) {
      const retainLen = op.retain;
      resultText += originalText.slice(readIndex, readIndex + retainLen);
      inverseDeltas.push({ retain: retainLen });
      readIndex += retainLen;
    } else if ('insert' in op) {
      resultText += op.insert;
      // 逆向 Delta: 在该位置删除刚插入的长度
      inverseDeltas.push({ delete: op.insert.length });
    } else if ('delete' in op) {
      const deleteLen = op.delete;
      const deletedChars = originalText.slice(readIndex, readIndex + deleteLen);
      // 逆向 Delta: 重新插回被删除的字符序列
      inverseDeltas.push({ insert: deletedChars });
      readIndex += deleteLen;
    }
  }

  // 拼接剩余未处理的原始文本
  if (readIndex < originalText.length) {
    resultText += originalText.slice(readIndex);
  }

  parentObj[key] = resultText;

  const inversePatch: TextPatch = {
    op: 'text',
    path: patch.path,
    deltas: patch.inverseDeltas ?? inverseDeltas
  };

  return { success: true, inversePatch };
}

/**
 * 执行单个原子补丁
 */
export function applyPatch(root: unknown, patch: CanvasPatch): PatchApplyResult {
  switch (patch.op) {
    case 'set':
      return applySetPatch(root, patch);
    case 'unset':
      return applyUnsetPatch(root, patch);
    case 'splice':
      return applySplicePatch(root, patch);
    case 'text':
      return applyTextPatch(root, patch);
    default: {
      const exhaustiveCheck: never = patch;
      return {
        success: false,
        inversePatch: patch,
        error: `未知补丁操作: ${(exhaustiveCheck as { op: string }).op}`
      };
    }
  }
}

/**
 * 批量应用一组原子补丁
 * 若中途出错，自动倒序回滚
 */
export function applyPatches(root: unknown, patches: readonly CanvasPatch[]): BatchPatchApplyResult {
  const inversePatches: CanvasPatch[] = [];

  for (let i = 0; i < patches.length; i++) {
    const patch = patches[i];
    const result = applyPatch(root, patch);

    if (!result.success) {
      for (let j = inversePatches.length - 1; j >= 0; j--) {
        applyPatch(root, inversePatches[j]);
      }

      return {
        success: false,
        inversePatches: [],
        failedIndex: i,
        error: result.error
      };
    }

    inversePatches.push(result.inversePatch);
  }

  return {
    success: true,
    inversePatches
  };
}
