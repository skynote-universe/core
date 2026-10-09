/**
 * @file layout-tree.ts
 * @description 布局成员树 (ADR-130) 的纯函数：成员判定与建树；内核排版与插件 (如分支线来源) 共用同一份建树逻辑
 *
 * 设计考量 (Why):
 * 1. 成员判定只看文档字段：带 layoutItem 且父节点是成员或布局根。不带 layoutItem 的子节点是宿主节点的
 *    普通内容 (如画框主题里的便签)，不参与排版。
 * 2. 嵌套的布局根在外层树里是叶子：它的成员归内层布局，两棵树互不干涉。
 */

import type { NodeEntity } from '../types/node';
import type { LayoutDefinition, LayoutMember, LayoutTree } from '../protocols/layout.protocol';

const EMPTY_ITEM: Readonly<Record<string, unknown>> = Object.freeze({});

type NodeLookup = (id: string) => Readonly<NodeEntity> | undefined;

/**
 * 节点所在布局树的根：自身是布局根时即为自身；否则沿 layoutItem 成员链向上找到最近的布局根
 * @returns 不在任何布局树中时为 undefined
 */
export function findLayoutRootId(nodeId: string, getNode: NodeLookup): string | undefined {
  // 提交守卫保证容器无环
  for (let node = getNode(nodeId); node; node = node.parentId === undefined ? undefined : getNode(node.parentId)) {
    if (node.layout) return node.id;
    if (!node.layoutItem) return undefined;
  }
  return undefined;
}

/**
 * 成员 (非根) 所在树的根：节点带 layoutItem 且父节点在某棵布局树中
 * 嵌套的布局根既是内层树的根，也是外层树的成员，这里返回的是外层
 */
export function findMemberRootId(nodeId: string, getNode: NodeLookup): string | undefined {
  const node = getNode(nodeId);
  if (!node?.layoutItem || node.parentId === undefined) return undefined;
  return findLayoutRootId(node.parentId, getNode);
}

/** 节点变化可能影响的布局根：所在树，以及它作为嵌套根时所在的外层树 (尺寸变化会影响外层排版) */
export function collectAffectedLayoutRoots(nodeId: string, getNode: NodeLookup, roots: Set<string>): void {
  const rootId = findLayoutRootId(nodeId, getNode);
  if (rootId !== undefined) roots.add(rootId);
  const outerId = findMemberRootId(nodeId, getNode);
  if (outerId !== undefined) roots.add(outerId);
}

interface MutableMember extends LayoutMember {
  readonly children: LayoutMember[];
}

/**
 * 构建布局树的只读视图
 * @param childrenOf 按层叠顺序排列的直接子节点
 * @param definition 用于解析根的 layout.options；未注册的布局保留原值
 */
export function buildLayoutTree(
  root: Readonly<NodeEntity>,
  childrenOf: (parentId: string) => readonly Readonly<NodeEntity>[],
  definition: LayoutDefinition | undefined
): LayoutTree {
  const members = new Map<string, LayoutMember>();
  const build = (node: Readonly<NodeEntity>, parent: LayoutMember | undefined, depth: number): LayoutMember => {
    const member: MutableMember = {
      node,
      parent,
      children: [],
      depth,
      item: node.layoutItem ?? EMPTY_ITEM
    };
    members.set(node.id, member);
    if (depth === 0 || !node.layout) {
      for (const child of childrenOf(node.id)) {
        if (child.layoutItem) member.children.push(build(child, member, depth + 1));
      }
    }
    return member;
  };
  const rootMember = build(root, undefined, 0);
  const rawOptions = root.layout?.options;
  return {
    root: rootMember,
    options: definition?.parseOptions ? definition.parseOptions(rawOptions) : (rawOptions ?? {}),
    get: (nodeId) => members.get(nodeId)
  };
}
