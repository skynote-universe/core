/**
 * @file commit-guards.ts
 * @description 文档事务提交前的结构性守卫 (纯函数)
 *
 * 设计考量 (Why):
 * 1. 零 Base64 红线落地：文档只允许通过 assetId 引用媒体。data: 内联数据会让撤销栈深拷贝与协同广播内存雪崩；
 *    blob: 地址只在当前页面会话有效，持久化后必然失效。两者在提交入口一律拒绝，本地、插件与远端补丁同等对待。
 * 2. 容器无环：parentId 形成环会让层级排序、级联移动与级联删除全部失控，必须在写入前拦截，
 *    且要把同一事务内的多处 parentId 变更合并考虑 (如先后交换两个节点的父子关系)。
 * 3. 层级索引合法：zIndex 必须是合法的分数索引，否则后续生成相邻键时会抛错、排序也失去意义。
 */

import type { CanvasDocument } from '../types/canvas';
import type { CanvasPatch } from '../types/operation';
import { normalizePatchPath } from '../operation/patch-path';
import { isValidFractionalIndex } from '../utils/fractional-index';

const INLINE_MEDIA_URL = /^(?:data|blob):/i;

/**
 * 查找值中内联的媒体地址，返回其所在路径描述；不存在返回 null
 */
export function findInlineMediaUrl(value: unknown, path = ''): string | null {
  if (typeof value === 'string') {
    return INLINE_MEDIA_URL.test(value) ? path || '(根值)' : null;
  }
  if (value === null || typeof value !== 'object') return null;

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const found = findInlineMediaUrl(value[i], `${path}[${i}]`);
      if (found) return found;
    }
    return null;
  }

  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    const found = findInlineMediaUrl(record[key], path ? `${path}.${key}` : key);
    if (found) return found;
  }
  return null;
}

/** 从补丁中提取节点 parentId 的拟变更：返回 nodeId -> 新 parentId (undefined 表示移出容器) */
function collectParentChanges(patches: readonly CanvasPatch[]): Map<string, string | undefined> {
  const changes = new Map<string, string | undefined>();
  const takeFromNodes = (nodes: unknown): void => {
    if (nodes === null || typeof nodes !== 'object') return;
    for (const [id, node] of Object.entries(nodes as Record<string, { parentId?: string }>)) {
      changes.set(id, node?.parentId);
    }
  };

  for (let i = 0; i < patches.length; i++) {
    const patch = patches[i];
    const segments = normalizePatchPath(patch.path);
    if (segments[0] !== 'content') continue;

    if (segments.length === 1 && patch.op === 'set') {
      takeFromNodes((patch.value as { nodes?: unknown } | undefined)?.nodes);
    } else if (segments.length === 2 && segments[1] === 'nodes' && patch.op === 'set') {
      takeFromNodes(patch.value);
    } else if (segments[1] === 'nodes' && segments.length >= 3) {
      const id = String(segments[2]);
      if (segments.length === 3 && patch.op === 'set') {
        const value = patch.value as { parentId?: string } | undefined;
        if (!patch.merge || (value && 'parentId' in value)) changes.set(id, value?.parentId);
      } else if (segments.length === 4 && segments[3] === 'parentId') {
        changes.set(id, patch.op === 'set' ? (patch.value as string | undefined) : undefined);
      }
    }
  }
  return changes;
}

/**
 * 检查本次事务是否会让容器层级成环，返回首个成环节点的描述；无环返回 null
 */
export function findParentCycle(doc: CanvasDocument, patches: readonly CanvasPatch[]): string | null {
  const changes = collectParentChanges(patches);
  if (changes.size === 0) return null;

  const parentOf = (id: string): string | undefined =>
    changes.has(id) ? changes.get(id) : Object.hasOwn(doc.content.nodes, id) ? doc.content.nodes[id].parentId : undefined;

  for (const [id, parentId] of changes) {
    const visited = new Set<string>([id]);
    let current = parentId;
    while (current !== undefined) {
      if (visited.has(current)) {
        return `节点 ${id} 的容器链 ${[...visited, current].join(' → ')} 形成环`;
      }
      visited.add(current);
      current = parentOf(current);
    }
  }
  return null;
}

/**
 * 检查补丁写入的节点/连线 zIndex 是否均为合法分数索引，返回首个非法值的描述；全部合法返回 null
 */
export function findInvalidZIndex(patches: readonly CanvasPatch[]): string | null {
  const checkEntity = (kind: string, id: string, entity: unknown, requirePresent: boolean): string | null => {
    if (entity === null || typeof entity !== 'object') return null;
    const record = entity as { zIndex?: unknown };
    if (!requirePresent && !('zIndex' in record)) return null;
    return isValidFractionalIndex(record.zIndex) ? null : `${kind} ${id} 的 zIndex ${JSON.stringify(record.zIndex)} 不是合法的分数索引`;
  };
  const checkCollection = (kind: string, collection: unknown): string | null => {
    if (collection === null || typeof collection !== 'object') return null;
    for (const [id, entity] of Object.entries(collection as Record<string, unknown>)) {
      const found = checkEntity(kind, id, entity, true);
      if (found) return found;
    }
    return null;
  };

  for (let i = 0; i < patches.length; i++) {
    const patch = patches[i];
    if (patch.op !== 'set') continue;
    const segments = normalizePatchPath(patch.path);
    if (segments[0] !== 'content') continue;

    let found: string | null = null;
    if (segments.length === 1) {
      const content = patch.value as { nodes?: unknown; connectors?: unknown } | undefined;
      found = checkCollection('节点', content?.nodes) ?? checkCollection('连线', content?.connectors);
    } else if (segments[1] !== 'nodes' && segments[1] !== 'connectors') {
      continue;
    } else {
      const kind = segments[1] === 'nodes' ? '节点' : '连线';
      if (segments.length === 2) {
        found = checkCollection(kind, patch.value);
      } else if (segments.length === 3) {
        found = checkEntity(kind, String(segments[2]), patch.value, !patch.merge);
      } else if (segments.length === 4 && segments[3] === 'zIndex') {
        found = isValidFractionalIndex(patch.value)
          ? null
          : `${kind} ${String(segments[2])} 的 zIndex ${JSON.stringify(patch.value)} 不是合法的分数索引`;
      }
    }
    if (found) return found;
  }
  return null;
}
