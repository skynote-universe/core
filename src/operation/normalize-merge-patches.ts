import type { CanvasPatch } from '../types/operation';
import { normalizePatchPath } from './patch-path';

/** 浅合并中的 undefined 表示删除，但 JSON 会丢弃该键；执行前拆成明确操作，让广播与历史保持相同语义。 */
export function normalizeMergePatches(patches: CanvasPatch[]): CanvasPatch[] {
  let normalized: CanvasPatch[] | undefined;
  for (let i = 0; i < patches.length; i++) {
    const patch = patches[i];
    if (patch.op === 'set' && patch.merge && patch.value !== null && typeof patch.value === 'object') {
      const source = patch.value as Record<string, unknown>;
      let removed: string[] | undefined;
      for (const key in source) {
        if (!Object.hasOwn(source, key) || source[key] !== undefined) continue;
        (removed ??= []).push(key);
      }
      if (removed) {
        const value = { ...source };
        for (const key of removed) delete value[key];
        normalized ??= patches.slice(0, i);
        // 即使只删除字段，也保留空 merge：目标原本缺失或为标量时仍需创建字典，逆向才能准确恢复。
        normalized.push({ ...patch, value });
        const path = normalizePatchPath(patch.path);
        for (const key of removed) normalized.push({ op: 'unset', path: [...path, key] });
        continue;
      }
    }
    normalized?.push(patch);
  }
  return normalized ?? patches;
}
