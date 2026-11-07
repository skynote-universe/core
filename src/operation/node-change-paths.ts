import type { CanvasPatch, NodeDataPath, NodeDataPaths } from '../types';
import { normalizePatchPath } from './patch-path';

/** 归并节点相对路径，保留撤销、合并补丁和整体替换的失效边界。null 表示整个节点集合被替换。 */
export function collectNodeDataPaths(patches: readonly CanvasPatch[]): Map<string, NodeDataPaths> | null {
  const result = new Map<string, NodeDataPath[] | null>();
  for (const patch of patches) {
    const path = normalizePatchPath(patch.path);
    if (path[0] !== 'content') continue;
    if (path.length === 1 || (path[1] === 'nodes' && path.length === 2)) return null;
    if (path[1] !== 'nodes') continue;
    const id = String(path[2]);
    const accumulated = result.get(id);
    if (accumulated === null) continue;
    let paths: NodeDataPath[];
    if (path.length === 3) {
      if (patch.op !== 'set' || !patch.merge) {
        result.set(id, null);
        continue;
      }
      paths = Object.keys(patch.value as object).map((key) => [key]);
    } else if (patch.op === 'set' && patch.merge)
      paths = Object.keys(patch.value as object).map((key) => [...path.slice(3), key]);
    else paths = [path.slice(3)];
    // 同一节点的批量修改只追加新路径，避免每条补丁复制此前的全部路径。
    const target = accumulated ?? [];
    for (const changed of paths) target.push(changed);
    if (!accumulated) result.set(id, target);
  }
  return result;
}
