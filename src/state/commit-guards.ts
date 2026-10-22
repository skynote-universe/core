/**
 * @file commit-guards.ts
 * @description 文档事务提交前的结构性守卫 (纯函数)
 *
 * 设计考量 (Why):
 * 1. 零 Base64 红线落地：文档只允许通过 assetId 引用媒体。data: 内联数据会让撤销栈深拷贝与协同广播内存暴涨；
 *    blob: 地址只在当前页面会话有效，持久化后必然失效。两者在提交入口一律拒绝，本地、插件与远端补丁同等对待。
 * 2. 容器无环：parentId 形成环会让层级排序、级联移动与级联删除全部失控，必须在写入前拦截，
 *    且要把同一事务内的多处 parentId 变更合并考虑 (如先后交换两个节点的父子关系)。
 * 3. 层级索引合法：zIndex 必须是合法的分数索引，否则后续生成相邻键时会抛错、排序也失去意义。
 */

import type { CanvasDocument } from '../types/canvas';
import type { CanvasPatch } from '../types/operation';
import { normalizePatchPath } from '../operation/patch-path';
import { isValidFractionalIndex } from '../utils/fractional-index';
import { DERIVED_CONNECTOR_PREFIX } from '../protocols/connector-source.protocol';

/**
 * 只匹配真实的内联媒体地址，避免误伤以 "Data:" 开头的普通文字：
 * data:<type>/<subtype>[;参数],<数据> 与 blob:<来源>/<id> (来源为 http(s)、file 或 null)
 */
const INLINE_MEDIA_URL = /^(?:data:[\w.+-]+\/[\w.+-]+(?:;[^,]*)?,|blob:(?:https?:\/\/|file:|null\/))/i;

/** 深度遍历查找内联媒体，只在命中时回溯拼出所在路径 (未命中时零字符串分配) */
function findInlineMediaSegments(value: unknown): (string | number)[] | null {
  if (typeof value === 'string') return INLINE_MEDIA_URL.test(value) ? [] : null;
  if (value === null || typeof value !== 'object') return null;

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const found = findInlineMediaSegments(value[i]);
      if (found) {
        found.unshift(i);
        return found;
      }
    }
    return null;
  }

  const record = value as Record<string, unknown>;
  for (const key in record) {
    if (!Object.hasOwn(record, key)) continue;
    const found = findInlineMediaSegments(record[key]);
    if (found) {
      found.unshift(key);
      return found;
    }
  }
  return null;
}

/**
 * 提交前的全部结构性守卫 (零 Base64、容器无环、层级索引合法)，返回首个违规描述；合法返回 null
 * @param doc 补丁应用前的文档 (成环判定需要现有的父子关系)
 */
export function findCommitViolation(doc: CanvasDocument, patches: readonly CanvasPatch[]): string | null {
  // JSON 会丢弃 set undefined 的 value，导致合法文档对应的历史无法恢复；删除必须使用 unset。
  if (patches.some((patch) => patch.op === 'set' && patch.value === undefined))
    return 'set 补丁的 value 不能为 undefined，删除字段请使用 unset';
  const inlineMedia = findInlineMediaInPatches(patches);
  if (inlineMedia) return `${inlineMedia} 内联了 data:/blob: 媒体地址，媒体必须通过 assetId 引用`;
  return findParentCycle(doc, patches) ?? findInvalidZIndex(doc, patches) ?? findReservedConnectorId(patches);
}

/** 派生连线的 id 前缀保留给内核 (ADR-130)：文档中的连线用了它会与派生连线撞 id */
function findReservedConnectorId(patches: readonly CanvasPatch[]): string | null {
  const check = (ids: Iterable<string>): string | null => {
    for (const id of ids) {
      if (id.startsWith(DERIVED_CONNECTOR_PREFIX)) return `连线 id ${id} 使用了保留前缀 ${DERIVED_CONNECTOR_PREFIX}`;
    }
    return null;
  };
  const keysOf = (value: unknown): string[] => (value && typeof value === 'object' ? Object.keys(value) : []);
  for (const patch of patches) {
    if (patch.op !== 'set') continue;
    const segments = normalizePatchPath(patch.path);
    if (segments[0] !== 'content') continue;
    let found: string | null = null;
    if (segments.length === 1) found = check(keysOf((patch.value as { connectors?: unknown } | undefined)?.connectors));
    else if (segments[1] !== 'connectors') continue;
    else if (segments.length === 2) found = check(keysOf(patch.value));
    else found = check([String(segments[2])]);
    if (found) return found;
  }
  return null;
}

/**
 * 查找值中内联的媒体地址，返回其所在路径描述；不存在返回 null
 */
export function findInlineMediaUrl(value: unknown, basePath: readonly (string | number)[] = []): string | null {
  const found = findInlineMediaSegments(value);
  if (!found) return null;
  const segments = [...basePath, ...found];
  return segments.length > 0 ? segments.join('.') : '(根值)';
}

/**
 * 查找补丁写入值中的内联媒体地址：只扫描 set 的值与 splice 插入项，跳过路径；
 * text 补丁是用户输入的文字差量，不做媒体判定
 */
export function findInlineMediaInPatches(patches: readonly CanvasPatch[]): string | null {
  for (let i = 0; i < patches.length; i++) {
    const patch = patches[i];
    const value = patch.op === 'set' ? patch.value : patch.op === 'splice' ? patch.items : undefined;
    if (value === undefined) continue;
    const found = findInlineMediaUrl(value, normalizePatchPath(patch.path));
    if (found) return found;
  }
  return null;
}

/** 只投影父关系；集合替换清除旧视图，避免已经删除的中间状态参与最终判环。 */
function collectParentChanges(
  doc: CanvasDocument,
  patches: readonly CanvasPatch[]
): { changes: Map<string, string | undefined>; parentOf: (id: string) => string | undefined; error?: string } {
  const changes = new Map<string, string | undefined>();
  let base: CanvasDocument['content']['nodes'] | undefined = doc.content.nodes;
  const parentOf = (id: string): string | undefined =>
    changes.has(id) ? changes.get(id) : base && Object.hasOwn(base, id) ? base[id]?.parentId : undefined;
  const takeFromNodes = (nodes: unknown, merge = false): void => {
    if (!merge) {
      base = undefined;
      changes.clear();
    }
    if (nodes === null || typeof nodes !== 'object') return;
    for (const [id, node] of Object.entries(nodes as Record<string, { parentId?: string }>)) {
      changes.set(id, node?.parentId);
    }
  };

  for (let i = 0; i < patches.length; i++) {
    const patch = patches[i];
    const segments = normalizePatchPath(patch.path);
    if (segments[0] !== 'content') continue;

    if (segments.length === 1) {
      if (patch.op === 'unset') takeFromNodes(undefined);
      else if (patch.op === 'set') {
        const value = patch.value as { nodes?: unknown } | undefined;
        // content 的 merge 是浅合并：只要显式提供 nodes，就替换整个集合。
        if (!patch.merge || (value && Object.hasOwn(value, 'nodes'))) takeFromNodes(value?.nodes);
      }
    } else if (segments.length === 2 && segments[1] === 'nodes') {
      if (patch.op === 'unset') takeFromNodes(undefined);
      else if (patch.op === 'set') takeFromNodes(patch.value, patch.merge);
    } else if (segments[1] === 'nodes' && segments.length >= 3) {
      const id = String(segments[2]);
      if (segments.length === 3 && patch.op === 'unset') changes.set(id, undefined);
      else if (segments.length === 3 && patch.op === 'set') {
        const value = patch.value as { parentId?: string } | undefined;
        if (!patch.merge || (value && 'parentId' in value)) changes.set(id, value?.parentId);
      } else if (segments.length === 4 && segments[3] === 'parentId') {
        // 结构字段不是可编辑文字；不把执行器能处理的 text/splice 误投影成删除父关系。
        if (patch.op !== 'set' && patch.op !== 'unset')
          return { changes, parentOf, error: `节点 ${id} 的 parentId 仅支持 set/unset 补丁` };
        changes.set(id, patch.op === 'set' ? (patch.value as string | undefined) : undefined);
      }
    }
  }
  return { changes, parentOf };
}

/**
 * 检查本次事务是否会让容器层级成环，返回首个成环节点的描述；无环返回 null
 */
export function findParentCycle(doc: CanvasDocument, patches: readonly CanvasPatch[]): string | null {
  const { changes, parentOf, error } = collectParentChanges(doc, patches);
  if (error) return error;
  if (changes.size === 0) return null;

  // 所有补丁先合并为最终父关系；同一事务中已验证的共享祖先链只访问一次。
  const complete = new Set<string>();
  for (const id of changes.keys()) {
    const visited = new Set<string>();
    let current: string | undefined = id;
    while (current !== undefined && !complete.has(current)) {
      if (visited.has(current)) {
        return `节点 ${id} 的容器链 ${[...visited, current].join(' → ')} 形成环`;
      }
      visited.add(current);
      current = parentOf(current);
    }
    for (const nodeId of visited) complete.add(nodeId);
  }
  return null;
}

/**
 * 按最终覆盖视图检查存活节点/连线的层级键；只投影相关字段，删除后重建和集合覆盖不保留中间错误。
 */
export function findInvalidZIndex(doc: CanvasDocument, patches: readonly CanvasPatch[]): string | null {
  type Collection = Record<string, { zIndex?: unknown }>;
  type Projection = { base?: Collection; changes?: Map<string, unknown> };
  const projections: Record<'nodes' | 'connectors', Projection> = {
    nodes: { base: doc.content.nodes },
    connectors: { base: doc.content.connectors }
  };
  const removed = Symbol();
  const takeCollection = (state: Projection, value: unknown, merge = false): void => {
    if (!merge) {
      state.base = undefined;
      state.changes?.clear();
    }
    if (!value || typeof value !== 'object') return;
    for (const [id, entity] of Object.entries(value as Collection))
      (state.changes ??= new Map()).set(id, merge && entity === undefined ? removed : entity?.zIndex);
  };

  // 仅投影被改写的层级键；几何高频补丁不创建覆盖表，也不扫描原有集合。
  for (const patch of patches) {
    const segments = normalizePatchPath(patch.path);
    if (segments[0] !== 'content') continue;
    if (segments.length === 1) {
      if (patch.op === 'unset') {
        takeCollection(projections.nodes, undefined);
        takeCollection(projections.connectors, undefined);
      } else if (patch.op === 'set') {
        const content = patch.value as { nodes?: unknown; connectors?: unknown } | undefined;
        for (const kind of ['nodes', 'connectors'] as const)
          if (!patch.merge || (content && Object.hasOwn(content, kind)))
            takeCollection(projections[kind], content?.[kind]);
      }
      continue;
    }
    if (segments[1] !== 'nodes' && segments[1] !== 'connectors') continue;
    const state = projections[segments[1]];
    if (segments.length === 2) {
      if (patch.op === 'unset') takeCollection(state, undefined);
      else if (patch.op === 'set') takeCollection(state, patch.value, patch.merge);
    } else if (segments.length === 3) {
      const id = String(segments[2]);
      if (patch.op === 'unset') (state.changes ??= new Map()).set(id, removed);
      else if (patch.op === 'set') {
        const value = patch.value as { zIndex?: unknown } | undefined;
        const existed = state.changes?.has(id)
          ? state.changes.get(id) !== removed
          : state.base !== undefined && Object.hasOwn(state.base, id);
        if (!patch.merge || (value && Object.hasOwn(value, 'zIndex')) || !existed)
          (state.changes ??= new Map()).set(id, value?.zIndex);
      }
    } else if (segments.length === 4 && segments[3] === 'zIndex') {
      if (patch.op !== 'set' && patch.op !== 'unset')
        return `实体 ${String(segments[2])} 的 zIndex 仅支持 set/unset 补丁`;
      (state.changes ??= new Map()).set(String(segments[2]), patch.op === 'set' ? patch.value : undefined);
    }
  }
  for (const kind of ['nodes', 'connectors'] as const) {
    for (const [id, key] of projections[kind].changes ?? [])
      if (key !== removed && !isValidFractionalIndex(key))
        return `${kind === 'nodes' ? '节点' : '连线'} ${id} 的 zIndex ${JSON.stringify(key)} 不是合法的分数索引`;
  }
  return null;
}
