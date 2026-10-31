/**
 * @file container-derivation.ts
 * @description 事务内按容器依赖自底向上派生，统一处理 Group 与布局的交错嵌套 (ADR-145)
 */

import type { CanvasDocument } from '../types/canvas';
import type { NodeEntity } from '../types/node';
import type { CanvasPatch } from '../types/operation';
import type { LayoutRegistry } from '../registry/layout-registry';
import { normalizePatchPath } from '../operation/patch-path';
import { deriveGroupBoundsPatches, GROUP_NODE_TYPE } from './group-bounds-derivation';
import { deriveLayoutPatches } from './layout-derivation';
import { computeSubtreeFootprint } from './subtree-footprint';
import { computeNodeLocalMatrix } from '../utils/geometry';

export interface ContainerDerivationContext {
  readonly layouts: LayoutRegistry;
  previousParentId(nodeId: string): string | undefined;
  previousChildIds(parentId: string): ReadonlySet<string>;
  isHeld?(nodeId: string): boolean;
}

const GEOMETRY_FIELDS = new Set<string | number>(['x', 'y', 'width', 'height', 'rotation', 'parentId']);
const LAYOUT_FIELDS = new Set<string | number>(['width', 'height', 'parentId', 'zIndex', 'layout', 'layoutItem']);

interface ContainerAncestry {
  depth: number;
  groupId?: string;
  parentGroupId?: string;
  layoutRootId?: string;
  memberRootId?: string;
  footprintRootId?: string;
  parentFootprintRootId?: string;
}

export function deriveContainerPatches(
  doc: Readonly<CanvasDocument>,
  patches: readonly CanvasPatch[],
  context: ContainerDerivationContext
): CanvasPatch[] {
  const { nodes } = doc.content;
  const overrides = new Map<string, Readonly<NodeEntity> | undefined>();
  const getNode = (id: string): Readonly<NodeEntity> | undefined =>
    overrides.has(id) ? overrides.get(id) : Object.hasOwn(nodes, id) ? nodes[id] : undefined;
  const affected = new Set<string>();
  const changed = new Set<string>();
  let replaced = false;
  // 派生只改几何或删除空组，祖先关系在调度期间不变；每条祖先链迭代展开一次，避免深层平方遍历和递归栈。
  const ancestry = new Map<string, ContainerAncestry>();
  const ancestryOf = (id: string): ContainerAncestry | undefined => {
    const cached = ancestry.get(id);
    if (cached) return cached;
    const path: Readonly<NodeEntity>[] = [];
    let currentId: string | undefined = id;
    while (currentId !== undefined && !ancestry.has(currentId)) {
      const node = getNode(currentId);
      if (!node) break;
      path.push(node);
      currentId = node.parentId;
    }
    let parent = currentId === undefined ? undefined : ancestry.get(currentId);
    for (let i = path.length - 1; i >= 0; i--) {
      const node = path[i];
      const next: ContainerAncestry = {
        depth: parent ? parent.depth + 1 : 0,
        groupId: node.nodeType === GROUP_NODE_TYPE ? node.id : parent?.groupId,
        parentGroupId: parent?.groupId,
        layoutRootId: node.layout ? node.id : node.layoutItem ? parent?.layoutRootId : undefined,
        memberRootId: node.layoutItem ? parent?.layoutRootId : undefined,
        footprintRootId:
          node.layout && context.layouts.get(node.layout.type)?.footprint === 'subtree'
            ? node.id
            : parent?.footprintRootId,
        parentFootprintRootId: parent?.footprintRootId
      };
      ancestry.set(node.id, next);
      parent = next;
    }
    return ancestry.get(id);
  };
  const collectGroups = (parentId: string | undefined): void => {
    const id = parentId === undefined ? undefined : ancestryOf(parentId)?.groupId;
    if (id !== undefined) affected.add(id);
  };
  const collectLayoutRoots = (id: string): void => {
    const info = ancestryOf(id);
    if (info?.layoutRootId !== undefined) affected.add(info.layoutRootId);
    if (info?.memberRootId !== undefined) affected.add(info.memberRootId);
  };
  const collectFootprintRoots = (id: string, includeSelf: boolean): void => {
    const info = ancestryOf(id);
    const rootId = info?.footprintRootId === id && !includeSelf ? info.parentFootprintRootId : info?.footprintRootId;
    if (rootId !== undefined) affected.add(rootId);
  };
  for (const patch of patches) {
    const path = normalizePatchPath(patch.path);
    if (path[0] !== 'content' || (path.length > 1 && path[1] !== 'nodes')) continue;
    if (path.length <= 2) {
      replaced = true;
      continue;
    }
    const id = String(path[2]);
    changed.add(id);
    const fields =
      path.length > 3 ? [path[3]] : patch.op === 'set' && patch.merge ? Object.keys(patch.value as object) : null;
    const node = getNode(id);
    if (!fields || fields.some((field) => GEOMETRY_FIELDS.has(field) || field === 'layout' || field === 'layoutItem')) {
      collectFootprintRoots(
        id,
        !fields || fields.some((field) => field === 'width' || field === 'height' || field === 'layout')
      );
      const previousParentId = context.previousParentId(id);
      if (previousParentId !== undefined) collectFootprintRoots(previousParentId, true);
    }
    if (!fields || fields.some((field) => GEOMETRY_FIELDS.has(field))) {
      collectGroups(node?.parentId);
      collectGroups(context.previousParentId(id));
    }
    if (
      !fields ||
      fields.some((field) => LAYOUT_FIELDS.has(field)) ||
      (fields.some((field) => GEOMETRY_FIELDS.has(field)) && ancestryOf(id)?.memberRootId !== undefined)
    ) {
      collectLayoutRoots(id);
      const parentId = context.previousParentId(id);
      if (parentId !== undefined) collectLayoutRoots(parentId);
    }
  }
  if (replaced) {
    for (const node of Object.values(nodes)) {
      if (node.layout || node.nodeType === GROUP_NODE_TYPE) affected.add(node.id);
    }
  }
  if (affected.size === 0) return [];

  // 新增、删除和改挂尚未进入运行时索引；只叠加本事务成员变化，普通组内编辑不扫描整个画布。
  const additions = new Map<string, Set<string>>();
  for (const id of replaced ? Object.keys(nodes) : changed) {
    const node = getNode(id);
    if (node?.parentId === undefined) continue;
    if (!replaced && context.previousParentId(id) === node.parentId) continue;
    let ids = additions.get(node.parentId);
    if (!ids) additions.set(node.parentId, (ids = new Set()));
    ids.add(id);
  }
  const childIds = new Map<string, ReadonlySet<string>>();
  const childrenOf = (parentId: string): Readonly<NodeEntity>[] => {
    let ids = childIds.get(parentId);
    if (!ids) {
      ids = new Set([...(replaced ? [] : context.previousChildIds(parentId)), ...(additions.get(parentId) ?? [])]);
      childIds.set(parentId, ids);
    }
    const children: Readonly<NodeEntity>[] = [];
    for (const id of ids) {
      const node = getNode(id);
      if (node?.parentId === parentId) children.push(node);
    }
    return children;
  };

  // Group 尺寸可影响其外层布局，布局尺寸也可影响外层 Group；先收集完整依赖，再各处理一次。
  const queue = [...affected];
  for (let i = 0; i < queue.length; i++) {
    const info = ancestryOf(queue[i]);
    if (!info) continue;
    // 最近的组和外层布局已覆盖直接依赖；队列继续展开传递依赖，不再逐容器扫描所有祖先。
    for (const id of [info.memberRootId, info.parentGroupId, info.parentFootprintRootId]) {
      if (id !== undefined && !affected.has(id)) {
        affected.add(id);
        queue.push(id);
      }
    }
  }
  queue.sort((a, b) => ancestryOf(b)!.depth - ancestryOf(a)!.depth);
  const derived: CanvasPatch[] = [];
  const removed = new Set<string>();
  for (const id of queue) {
    const node = getNode(id);
    if (!node) continue;
    const next =
      node.nodeType === GROUP_NODE_TYPE
        ? deriveGroupBoundsPatches(node, childrenOf(id), (child) =>
            child.layout && context.layouts.get(child.layout.type)?.footprint === 'subtree'
              ? computeSubtreeFootprint(child, childrenOf, computeNodeLocalMatrix(child))
              : undefined
          )
        : node.layout
          ? deriveLayoutPatches(node, { layouts: context.layouts, childrenOf, isHeld: context.isHeld })
          : [];
    for (const patch of next) {
      const path = normalizePatchPath(patch.path);
      const nodeId = String(path[2]);
      if (patch.op === 'unset') {
        overrides.set(nodeId, undefined);
        removed.add(nodeId);
      } else if (patch.op === 'set') {
        overrides.set(nodeId, { ...getNode(nodeId)!, [path[3]]: patch.value });
      }
    }
    for (const patch of next) derived.push(patch);
  }
  if (removed.size > 0) {
    for (const connector of Object.values(doc.content.connectors)) {
      if (
        (connector.from.nodeId !== undefined && removed.has(connector.from.nodeId)) ||
        (connector.to.nodeId !== undefined && removed.has(connector.to.nodeId))
      )
        derived.push({ op: 'unset', path: ['content', 'connectors', connector.id] });
    }
  }
  return derived;
}
