import type { CanvasDocument, CanvasDocumentView } from '../types/canvas';
import type { CanvasHistoryEntry, CanvasHistorySnapshot, CanvasPatch, TextDeltaOp } from '../types/operation';
import { applyPatches } from '../operation/patch-applier';
import { normalizePatchPath } from '../operation/patch-path';
import { clonePlainData, DANGEROUS_KEYS } from '../utils/clone';
import { areStructuredValuesEqual } from '../utils/equality';
import { findCommitViolation } from '../state/commit-guards';
import { parseCanvasDocument, type ParseResult } from './document-schema';

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 历史来自持久化边界；拒绝非纯数据和危险键，而不是净化后悄悄改变补丁语义。 */
function plain(value: unknown, ancestors = new Set<object>(), depth = 0): boolean {
  if (value === undefined || value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || depth > 64 || ancestors.has(value)) return false;
  const proto = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && proto !== Object.prototype && proto !== null) return false;
  ancestors.add(value);
  const valid = Object.entries(value).every(
    ([key, child]) => !DANGEROUS_KEYS.has(key) && plain(child, ancestors, depth + 1)
  );
  ancestors.delete(value);
  return valid;
}

function delta(value: unknown): value is TextDeltaOp {
  if (!object(value)) return false;
  const kinds = ['retain', 'insert', 'delete'].filter((key) => key in value);
  if (kinds.length !== 1) return false;
  const kind = kinds[0];
  return kind === 'insert'
    ? typeof value.insert === 'string' && (value.attributes === undefined || object(value.attributes))
    : Number.isSafeInteger(value[kind]) && (value[kind] as number) >= 0;
}

function patch(value: unknown): value is CanvasPatch {
  if (!object(value)) return false;
  const path = value.path;
  if (!(
    typeof path === 'string' ||
    (Array.isArray(path) && path.every((key) => typeof key === 'string' || (Number.isSafeInteger(key) && key >= 0)))
  ))
    return false;
  const segments = normalizePatchPath(path);
  if (!segments.length || segments.some((key) => typeof key === 'string' && (!key || DANGEROUS_KEYS.has(key))))
    return false;
  if (value.op === 'set')
    return Object.hasOwn(value, 'value') && (value.merge === undefined || typeof value.merge === 'boolean');
  if (value.op === 'unset') return true;
  if (value.op === 'splice')
    return (
      Number.isSafeInteger(value.index) &&
      (value.index as number) >= 0 &&
      Number.isSafeInteger(value.deleteCount) &&
      (value.deleteCount as number) >= 0 &&
      (value.items === undefined || Array.isArray(value.items)) &&
      (value.deletedItems === undefined || Array.isArray(value.deletedItems))
    );
  return (
    value.op === 'text' &&
    Array.isArray(value.deltas) &&
    value.deltas.every(delta) &&
    (value.inverseDeltas === undefined || (Array.isArray(value.inverseDeltas) && value.inverseDeltas.every(delta)))
  );
}

/** 在独立文档副本验证两条历史分支，每一步核对结构守卫和双向等价；不触碰活动文档。 */
export function parseCanvasHistory(document: CanvasDocumentView, value: unknown): ParseResult<CanvasHistorySnapshot> {
  const fail = (error: string): ParseResult<CanvasHistorySnapshot> => ({ ok: false, error });
  if (!object(value) || !Array.isArray(value.undo) || !Array.isArray(value.redo)) return fail('历史栈结构无效');
  if (value.undo.length + value.redo.length > 2000) return fail('历史超过 2000 条校验上限');
  try {
    if (!plain(value)) return fail('历史包含非纯数据、危险键或过深结构');
    if (JSON.stringify(value).length > 8 * 1024 * 1024) return fail('历史超过 8 MiB 校验上限');
    const ids = new Set<string>();
    let patchCount = 0;
    for (const entry of [...value.undo, ...value.redo]) {
      if (
        !object(entry) ||
        typeof entry.id !== 'string' ||
        !entry.id ||
        ids.has(entry.id) ||
        typeof entry.label !== 'string' ||
        typeof entry.timestamp !== 'number' ||
        !Number.isFinite(entry.timestamp) ||
        entry.timestamp < 0 ||
        (entry.groupId !== undefined && typeof entry.groupId !== 'string') ||
        !Array.isArray(entry.patches) ||
        !entry.patches.length ||
        !entry.patches.every(patch) ||
        !Array.isArray(entry.inversePatches) ||
        !entry.inversePatches.length ||
        !entry.inversePatches.every(patch)
      )
        return fail('历史条目或补丁格式无效');
      ids.add(entry.id);
      patchCount += entry.patches.length + entry.inversePatches.length;
      if (patchCount > 20000) return fail('历史超过 20000 条补丁校验上限');
    }
    const base = parseCanvasDocument(document);
    if (!base.ok) return fail(base.error);
    const history = clonePlainData(value) as unknown as CanvasHistorySnapshot;
    let checkedBytes = 0;
    const validate = (doc: CanvasDocument, patches: readonly CanvasPatch[]): string | undefined => {
      const violation = findCommitViolation(doc, patches);
      if (violation) return violation;
      const applied = applyPatches(doc, patches);
      if (!applied.success) return applied.error ?? '历史补丁无法应用';
      checkedBytes += JSON.stringify(doc).length;
      if (checkedBytes > 64 * 1024 * 1024) return '历史重放超过 64 MiB 校验预算';
      const parsed = parseCanvasDocument(doc);
      if (!parsed.ok) return parsed.error;
      // 解析器可能修复引用/丢弃未知字段；恢复历史不允许借此掩盖损坏。
      if (!areStructuredValuesEqual(parsed.value, doc)) return '历史状态需要修复，不能原样恢复';
      return undefined;
    };
    for (const direction of ['undo', 'redo'] as const) {
      const doc = clonePlainData(base.value);
      const entries = history[direction];
      for (let index = entries.length - 1; index >= 0; index--) {
        const entry: CanvasHistoryEntry = entries[index];
        const forward = direction === 'undo' ? [...entry.inversePatches].reverse() : entry.patches;
        const backward = direction === 'undo' ? entry.patches : [...entry.inversePatches].reverse();
        const before = clonePlainData(doc);
        const error = validate(doc, forward);
        if (error) return fail(`${direction}[${index}]：${error}`);
        const roundtrip = clonePlainData(doc);
        const reverseError = validate(roundtrip, backward);
        if (reverseError || !areStructuredValuesEqual(before, roundtrip))
          return fail(`${direction}[${index}]：正逆补丁不匹配`);
      }
    }
    return { ok: true, value: history };
  } catch {
    return fail('历史数据无法安全校验');
  }
}
