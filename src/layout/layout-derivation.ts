/**
 * @file layout-derivation.ts
 * @description 布局排版的事务内派生 (ADR-130)：找出本次事务影响到的布局树，重新排版并只为位置变化的成员生成补丁
 *
 * 设计考量 (Why):
 * 1. 排在文字自动尺寸之后：读到的是文字撑开后的尺寸，打字、插入、删除、改挂都在同一事务内重新排版，一步撤销。
 * 2. 远端事务不派生：协同对方收到的补丁已含排好的位置，各端结果一致。
 * 3. 只在触及布局树时才扫描子节点：普通编辑 (含拖动非成员节点) 零额外开销。
 * 4. 成员位置与朝向由布局决定 (arrange 给出的位姿，未给朝向即不旋转)：直接写成员的 x / y / rotation
 *    都会被排回；根自身的位置与旋转归用户，移动根不触发排版。
 */

import type { CanvasDocument } from '../types/canvas';
import type { NodeEntity } from '../types/node';
import type { Point } from '../types/geometry';
import type { CanvasPatch } from '../types/operation';
import type { LayoutMember } from '../protocols/layout.protocol';
import type { LayoutRegistry } from '../registry/layout-registry';
import { normalizePatchPath } from '../operation/patch-path';
import { sortSiblingsByLayer } from './layer-order';
import { buildLayoutTree, collectAffectedLayoutRoots } from './layout-tree';

export interface LayoutDerivationContext {
  readonly layouts: LayoutRegistry;
  /** 事务前的父节点：被删除或改挂的成员要让原来所在的树重新排版 */
  previousParentId(nodeId: string): string | undefined;
}

/** 任何节点上的这些字段变化都可能改变所在树的排版 */
const TRIGGER_FIELDS: ReadonlySet<string | number> = new Set([
  'width',
  'height',
  'parentId',
  'zIndex',
  'layout',
  'layoutItem'
]);
/** 成员的位置与朝向由布局决定，被直接改写时要排回去 */
const MEMBER_PLACEMENT_FIELDS: ReadonlySet<string | number> = new Set(['x', 'y', 'rotation']);
/** 小于此差值的位置变化不写补丁，避免浮点误差产生空转的提交 */
const POSITION_EPSILON = 1e-6;

/** 补丁触及的节点字段；整个节点被设置或删除时为 null */
function touchedFields(
  patch: CanvasPatch,
  segments: readonly (string | number)[]
): readonly (string | number)[] | null {
  if (segments.length > 3) return [segments[3]];
  if (patch.op === 'set' && patch.merge) return Object.keys(patch.value as object);
  return null;
}

/** 父节点 → 按层叠顺序排列的子节点 */
function indexChildren(nodes: Readonly<Record<string, NodeEntity>>): Map<string, Readonly<NodeEntity>[]> {
  const children = new Map<string, NodeEntity[]>();
  for (const node of Object.values(nodes)) {
    if (node.parentId === undefined) continue;
    const list = children.get(node.parentId);
    if (list) list.push(node);
    else children.set(node.parentId, [node]);
  }
  for (const [parentId, list] of children) children.set(parentId, sortSiblingsByLayer(list) as NodeEntity[]);
  return children;
}

export function deriveLayoutPatches(
  doc: Readonly<CanvasDocument>,
  patches: readonly CanvasPatch[],
  context: LayoutDerivationContext
): CanvasPatch[] {
  const { nodes } = doc.content;
  const getNode = (id: string): Readonly<NodeEntity> | undefined => (Object.hasOwn(nodes, id) ? nodes[id] : undefined);
  const roots = new Set<string>();

  for (const patch of patches) {
    const segments = normalizePatchPath(patch.path);
    if (segments[0] !== 'content') continue;
    // 整体替换内容或节点集合 (导入、恢复)：全部布局树重新排版
    if (segments.length <= 2) {
      if (segments.length === 1 || segments[1] === 'nodes') {
        for (const node of Object.values(nodes)) if (node.layout) roots.add(node.id);
      }
      continue;
    }
    if (segments[1] !== 'nodes') continue;
    const id = String(segments[2]);
    const fields = touchedFields(patch, segments);
    const node = getNode(id);
    const isMember = node !== undefined && !node.layout && node.layoutItem !== undefined;
    if (fields && !fields.some((f) => TRIGGER_FIELDS.has(f) || (isMember && MEMBER_PLACEMENT_FIELDS.has(f)))) continue;
    collectAffectedLayoutRoots(id, getNode, roots);
    const previousParentId = context.previousParentId(id);
    if (previousParentId !== undefined) collectAffectedLayoutRoots(previousParentId, getNode, roots);
  }
  if (roots.size === 0) return [];

  const children = indexChildren(nodes);
  const childrenOf = (parentId: string): readonly Readonly<NodeEntity>[] => children.get(parentId) ?? [];
  const derived: CanvasPatch[] = [];

  for (const rootId of roots) {
    const root = nodes[rootId];
    const definition = context.layouts.get(root.layout!.type);
    // 未注册的布局不排版：成员停在已保存的位置
    if (!definition) continue;
    const tree = buildLayoutTree(root, childrenOf, definition);
    const targets = definition.arrange(tree);

    // 成员在根局部坐标中的位置：布局给出的目标，未给出时按当前相对位置累加
    const placed = new Map<string, Point>([[rootId, { x: 0, y: 0 }]]);
    const placeOf = (member: LayoutMember): Point => {
      let point = placed.get(member.node.id);
      if (!point) {
        const parentPoint = placeOf(member.parent!);
        point = targets.get(member.node.id) ?? { x: parentPoint.x + member.node.x, y: parentPoint.y + member.node.y };
        placed.set(member.node.id, point);
      }
      return point;
    };

    const visit = (member: LayoutMember): void => {
      for (const child of member.children) {
        const target = placeOf(child);
        const parentPoint = placeOf(member);
        const x = target.x - parentPoint.x;
        const y = target.y - parentPoint.y;
        const path = ['content', 'nodes', child.node.id];
        if (Math.abs(x - child.node.x) > POSITION_EPSILON) derived.push({ op: 'set', path: [...path, 'x'], value: x });
        if (Math.abs(y - child.node.y) > POSITION_EPSILON) derived.push({ op: 'set', path: [...path, 'y'], value: y });
        const rotation = targets.get(child.node.id)?.rotation ?? 0;
        if (Math.abs(rotation - child.node.rotation) > POSITION_EPSILON) {
          derived.push({ op: 'set', path: [...path, 'rotation'], value: rotation });
        }
        visit(child);
      }
    };
    visit(tree.root);
  }
  return derived;
}
