/**
 * @file container-drop.ts
 * @description 节点拖拽入/出容器的公共落点探测、高亮与事务改挂辅助函数
 */

import type { CanvasPluginContext } from '../protocols/plugin.protocol';
import type { NodeEntity } from '../types/node';
import type { Point } from '../types/geometry';
import { applyMatrix } from '../utils/geometry';

const DROP_TARGET_STROKE_PX = 2;

export interface ContainerDropTargetOptions {
  /** 除节点类型 acceptsChildren 外，额外判定节点可接收子成员（如已安装布局） */
  readonly canAccept?: (node: Readonly<NodeEntity>) => boolean;
}

export interface CommitContainerDropOptions {
  readonly groupId: string;
  readonly moved?: Point;
  /** 判断节点是否为当前已安装布局成员（用于拖出布局时清理 layoutItem） */
  readonly isLayoutMember?: (nodeId: string) => boolean;
  /** 拖出普通（非堆叠）布局成员时是否需要同步补齐位移 */
  readonly shouldApplyMovedOnLeave?: (nodeId: string) => boolean;
}

/** 探测指针下方最上层的可接收容器并绘制外框高亮，返回目标容器 id */
export function updateContainerDropTarget(
  ctx: CanvasPluginContext,
  sessionId: string,
  draggedIds: readonly string[],
  point: Point,
  options?: ContainerDropTargetOptions
): string | undefined {
  const dragged = new Set(draggedIds);
  const target = ctx.hitTestNode(
    point,
    (node) =>
      (!!ctx.nodeTypes.get(node.nodeType)?.acceptsChildren || !!options?.canAccept?.(node)) &&
      !dragged.has(node.id) &&
      !ctx.entities.getAncestorIds(node.id).some((id) => dragged.has(id))
  );
  if (!target) {
    ctx.host.overlay.clear(sessionId);
    return undefined;
  }
  const toWorld = ctx.entities.getWorldTransform(target.id);
  if (!toWorld) {
    ctx.host.overlay.clear(sessionId);
    return undefined;
  }
  const { theme, viewport } = ctx.session;
  const corners = [
    applyMatrix(toWorld, 0, 0),
    applyMatrix(toWorld, target.width, 0),
    applyMatrix(toWorld, target.width, target.height),
    applyMatrix(toWorld, 0, target.height)
  ];
  ctx.host.overlay.setPrimitives(
    sessionId,
    [
      {
        kind: 'polygon',
        points: corners.flatMap((p) => [p.x, p.y]),
        stroke: theme.accent,
        strokeWidth: DROP_TARGET_STROKE_PX / viewport.zoom
      }
    ],
    { transient: true }
  );
  return target.id;
}

/** 提交节点拖入或移出容器的改挂事务；若目标容器启用了已安装布局则同步补齐 layoutItem */
export function commitContainerDrop(
  ctx: CanvasPluginContext,
  candidateIds: readonly string[],
  targetId: string | undefined,
  options: CommitContainerDropOptions
): void {
  const ids = candidateIds.filter((id) => {
    const node = ctx.entities.getNode(id)?.entity;
    if (!node || node.locked || node.parentId === targetId) return false;
    // 原父节点不接收拖入（如组合 Group）时不把子节点拖出
    const parent = node.parentId === undefined ? undefined : ctx.entities.getNode(node.parentId)?.entity;
    return !parent || !!ctx.nodeTypes.get(parent.nodeType)?.acceptsChildren;
  });
  if (ids.length === 0) return;

  const targetNode = targetId === undefined ? undefined : ctx.document.getNode(targetId);
  const joinsInstalledLayout = !!targetNode?.layout && ctx.layouts.get(targetNode.layout.type) !== undefined;
  if (targetId === undefined || !joinsInstalledLayout) {
    const label = targetId ? '移入容器' : '移出容器';
    const isMember =
      options.isLayoutMember ??
      ((id: string) => {
        const parentId = ctx.document.getNode(id)?.parentId;
        const parentLayout = parentId === undefined ? undefined : ctx.document.getNode(parentId)?.layout;
        return !!parentLayout && ctx.layouts.get(parentLayout.type) !== undefined;
      });
    const leavingLayoutIds = ids.filter(isMember);
    const unmovedLayoutIds = options.shouldApplyMovedOnLeave
      ? leavingLayoutIds.filter(options.shouldApplyMovedOnLeave)
      : [];
    ctx.document.reparentNodes(ids, targetId, { groupId: options.groupId, label });
    if (leavingLayoutIds.length > 0) {
      // 自带布局的节点只去掉空的成员标记，保留它给自己布局的根设置
      ctx.document.updateNodes(
        leavingLayoutIds,
        (node) => (node.layout && Object.keys(node.layoutItem ?? {}).length > 0 ? {} : { layoutItem: undefined }),
        { groupId: options.groupId, label }
      );
      if (options.moved && unmovedLayoutIds.length > 0 && (options.moved.x !== 0 || options.moved.y !== 0)) {
        ctx.document.moveEntities({ nodeIds: unmovedLayoutIds }, options.moved, {
          groupId: options.groupId,
          label
        });
      }
    }
    return;
  }

  ctx.document.reparentNodes(ids, targetId, { groupId: options.groupId, label: '加入布局' });
  const joining = ids.filter((id) => !ctx.document.getNode(id)?.layoutItem);
  if (joining.length > 0) {
    ctx.document.updateNodes(joining, { layoutItem: {} }, { groupId: options.groupId, label: '加入布局' });
  }
}
