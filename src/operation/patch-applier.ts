/**
 * @file patch-applier.ts
 * @description 现代化正交原子补丁执行引擎与逆向对偶推导器
 *
 * 设计考量 (Why):
 * 1. 正交原子设计：精简为 'set' | 'unset' | 'splice' | 'text' 四大基础动词，消除 add/replace 二义性。
 * 2. 严格对偶逆向推导：
 *    - set (直接覆盖) -> 若原属性不存在，逆向自动推导为 unset；若存在，推导为 set 旧值。
 *    - set (merge: true) -> 逆向推导为「旧字段快照的 merge set + 新增键的 unset」，确保撤销后不残留新键。
 *    - unset -> 逆向自动推导为 set 旧值。
 *    - splice -> 数组切片在相同位置置换插入与删除。
 *    - text -> 针对字符串执行流式 Delta，自动捕获被删文本生成对偶反向 Delta。
 * 3. 写入即隔离：补丁值写入文档时统一深拷贝，文档与任何补丁（含撤销栈历史）零共享引用；
 *    被覆盖/删除的旧值随即脱离文档，可直接作为逆向补丁的值而无需再拷贝。
 * 4. 严格寻址与越界校验：父级不存在、切片或 Delta 越界一律判定失败，
 *    让迟到的冲突补丁显式失败并整批回滚，而不是静默写出残缺数据。
 */

import type { CanvasPatch, SetPatch, UnsetPatch, SplicePatch, TextPatch, TextDeltaOp } from '../types/operation';
import { resolvePathForWrite, normalizePatchPath } from './patch-path';
import { clonePlainData, DANGEROUS_KEYS } from '../utils/clone';

/** 补丁应用单步执行结果 */
export interface PatchApplyResult {
  readonly success: boolean;
  /**
   * 自动生成的逆向补丁组 (多数操作仅 1 条；merge 需额外 unset 新增键)
   * 组内补丁互不重叠，调用方整体倒序回放即可
   */
  readonly inversePatches: CanvasPatch[];
  readonly error?: string;
}

/** 批量补丁应用结果 */
export interface BatchPatchApplyResult {
  readonly success: boolean;
  readonly inversePatches: CanvasPatch[];
  readonly failedIndex?: number;
  readonly error?: string;
}

function fail(error: string): PatchApplyResult {
  return { success: false, inversePatches: [], error };
}

/**
 * 1. 执行 set 补丁 (直接赋值或字典浅合并)
 */
function applySetPatch(root: unknown, patch: SetPatch): PatchApplyResult {
  const loc = resolvePathForWrite(root, patch.path);
  if (!loc) {
    return fail(`无法定位路径: ${JSON.stringify(patch.path)}`);
  }

  const { parent, key, currentValue, exists } = loc;
  const parentObj = parent as Record<string | number, unknown>;

  // A. 字典增量浅合并分支 (merge: true)
  if (patch.merge) {
    const patchValue = patch.value as Record<string, unknown>;
    const patchKeys = Object.keys(patchValue);
    // 协同/导入数据可能携带 JSON.parse 产生的自有 __proto__ 键，逐键赋值会借此改写原型链
    for (let i = 0; i < patchKeys.length; i++) {
      if (DANGEROUS_KEYS.has(patchKeys[i])) {
        return fail(`合并补丁包含非法键: ${patchKeys[i]}`);
      }
    }

    // 目标原本不是字典：整体替换为新字典，逆向直接恢复原值
    if (!exists || currentValue === null || typeof currentValue !== 'object') {
      parentObj[key] = clonePlainData(patchValue);
      return {
        success: true,
        inversePatches: [
          exists ? { op: 'set', path: patch.path, value: currentValue } : { op: 'unset', path: patch.path }
        ]
      };
    }

    const targetDict = currentValue as Record<string, unknown>;
    const oldValues: Record<string, unknown> = {};
    const addedKeys: string[] = [];

    for (let i = 0; i < patchKeys.length; i++) {
      const pKey = patchKeys[i];
      if (Object.hasOwn(targetDict, pKey)) {
        oldValues[pKey] = targetDict[pKey];
      } else {
        addedKeys.push(pKey);
      }
      targetDict[pKey] = clonePlainData(patchValue[pKey]);
    }

    const inversePatches: CanvasPatch[] = [];
    if (patch.oldValue !== undefined || addedKeys.length < patchKeys.length) {
      inversePatches.push({
        op: 'set',
        path: patch.path,
        value: patch.oldValue !== undefined ? patch.oldValue : oldValues,
        merge: true
      });
    }
    const basePath = normalizePatchPath(patch.path);
    for (let i = 0; i < addedKeys.length; i++) {
      inversePatches.push({ op: 'unset', path: [...basePath, addedKeys[i]] });
    }

    return { success: true, inversePatches };
  }

  // B. 直接覆盖赋值分支
  const inversePatch: CanvasPatch = exists
    ? {
        op: 'set',
        path: patch.path,
        value: patch.oldValue !== undefined ? patch.oldValue : currentValue,
        oldValue: patch.value
      }
    : { op: 'unset', path: patch.path };

  parentObj[key] = clonePlainData(patch.value);
  return { success: true, inversePatches: [inversePatch] };
}

/**
 * 2. 执行 unset 补丁 (移除属性)
 */
function applyUnsetPatch(root: unknown, patch: UnsetPatch): PatchApplyResult {
  const loc = resolvePathForWrite(root, patch.path);
  if (!loc || !loc.exists) {
    // 属性原本就不存在，幂等成功，逆向补丁为空 unset
    return {
      success: true,
      inversePatches: [{ op: 'unset', path: patch.path }]
    };
  }

  const { parent, key, currentValue } = loc;
  if (Array.isArray(parent)) {
    // 数组元素的 delete 会留下空洞，数组增删必须走 splice
    return fail(`unset 不能作用于数组元素: ${JSON.stringify(patch.path)}`);
  }
  delete (parent as Record<string | number, unknown>)[key];

  return {
    success: true,
    inversePatches: [
      {
        op: 'set',
        path: patch.path,
        value: patch.oldValue !== undefined ? patch.oldValue : currentValue
      }
    ]
  };
}

/**
 * 3. 执行 splice 补丁 (数组切片)
 */
function applySplicePatch(root: unknown, patch: SplicePatch): PatchApplyResult {
  const loc = resolvePathForWrite(root, patch.path);
  const targetArray = loc?.exists ? loc.currentValue : undefined;
  if (!Array.isArray(targetArray)) {
    return fail(`目标不是数组: ${JSON.stringify(patch.path)}`);
  }
  if (patch.index < 0 || patch.deleteCount < 0 || patch.index + patch.deleteCount > targetArray.length) {
    return fail(`切片越界: ${JSON.stringify(patch.path)} index=${patch.index} deleteCount=${patch.deleteCount}`);
  }

  const itemsToInsert = patch.items ?? [];
  const deleted = targetArray.splice(patch.index, patch.deleteCount, ...clonePlainData(itemsToInsert));

  // 对偶逆向操作：在相同位置，删除新插入数量，并插回原被删列表
  const inversePatch: SplicePatch = {
    op: 'splice',
    path: patch.path,
    index: patch.index,
    deleteCount: itemsToInsert.length,
    items: patch.deletedItems !== undefined ? patch.deletedItems : deleted,
    deletedItems: itemsToInsert
  };

  return { success: true, inversePatches: [inversePatch] };
}

/**
 * 4. 执行 text 补丁 (文本差量 Delta 流式更新)
 */
function applyTextPatch(root: unknown, patch: TextPatch): PatchApplyResult {
  const loc = resolvePathForWrite(root, patch.path);
  if (!loc || !loc.exists || typeof loc.currentValue !== 'string') {
    return fail(`无法定位文本路径: ${JSON.stringify(patch.path)}`);
  }

  const { parent, key } = loc;
  const originalText = loc.currentValue;

  const inverseDeltas: TextDeltaOp[] = [];
  let resultText = '';
  let readIndex = 0;

  for (let i = 0; i < patch.deltas.length; i++) {
    const op = patch.deltas[i];

    if ('retain' in op) {
      if (readIndex + op.retain > originalText.length) {
        return fail(`文本 Delta 越界: ${JSON.stringify(patch.path)}`);
      }
      resultText += originalText.slice(readIndex, readIndex + op.retain);
      inverseDeltas.push({ retain: op.retain });
      readIndex += op.retain;
    } else if ('insert' in op) {
      resultText += op.insert;
      // 逆向 Delta: 在该位置删除刚插入的长度
      inverseDeltas.push({ delete: op.insert.length });
    } else {
      if (readIndex + op.delete > originalText.length) {
        return fail(`文本 Delta 越界: ${JSON.stringify(patch.path)}`);
      }
      // 逆向 Delta: 重新插回被删除的字符序列
      inverseDeltas.push({ insert: originalText.slice(readIndex, readIndex + op.delete) });
      readIndex += op.delete;
    }
  }

  // 拼接剩余未处理的原始文本
  resultText += originalText.slice(readIndex);
  (parent as Record<string | number, unknown>)[key] = resultText;

  return {
    success: true,
    inversePatches: [{ op: 'text', path: patch.path, deltas: patch.inverseDeltas ?? inverseDeltas }]
  };
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
      return fail(`未知补丁操作: ${(exhaustiveCheck as { op: string }).op}`);
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
    const result = applyPatch(root, patches[i]);

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

    inversePatches.push(...result.inversePatches);
  }

  return {
    success: true,
    inversePatches
  };
}
