import type { NodeEntity } from '../types/node';
import type { Point, RectBounds } from '../types/geometry';

export const NODE_ALIGNMENT_LABELS = {
  left: '左对齐',
  'center-x': '水平居中',
  right: '右对齐',
  top: '顶对齐',
  'center-y': '垂直居中',
  bottom: '底对齐'
} as const;
export type NodeAlignment = keyof typeof NODE_ALIGNMENT_LABELS;
export type NodeDistributionAxis = 'horizontal' | 'vertical';
export interface NodeAutoArrangeOptions {
  /** 行列间距，默认20；写入前取非负整数。 */
  readonly gap?: number;
  /**
   * 排列风格：
   * - 'auto' (默认): 尺寸接近时保持网格行齐平；尺寸极其悬殊 (如含脑图) 时智能紧凑平衡，消除空白；
   * - 'compact': 强制紧凑瀑布流 (Greedy Balancing)，多列高度自适应平衡，消除大面积空洞；
   * - 'grid': 强制刚性二维网格，严格保持横竖行列对齐。
   */
  readonly mode?: 'auto' | 'compact' | 'grid';
}
export interface NodeArrangementInfo {
  readonly count: number;
  readonly blockedBy?: 'locked' | 'layout';
}
export interface NodeArrangementItem {
  readonly id: string;
  readonly bounds: RectBounds;
}
export interface NodeArrangementMove {
  readonly id: string;
  readonly delta: Point;
}

/** 共享祖先只解析一次，忽略已选祖先的后代；布局成员和锁定祖先统一影响可用性。 */
export function resolveArrangementTargets(
  nodeIds: Iterable<string>,
  getNode: (id: string) => Readonly<NodeEntity> | undefined
): { nodes: readonly Readonly<NodeEntity>[]; info: NodeArrangementInfo } {
  const selected = new Set<string>();
  for (const id of nodeIds) if (getNode(id)) selected.add(id);
  const resolved = new Map<string, { selectedRoot?: string; locked: boolean; inLayout: boolean; managed: boolean }>();
  for (const id of selected) {
    const path: Readonly<NodeEntity>[] = [];
    let current = getNode(id);
    while (current && !resolved.has(current.id)) {
      path.push(current);
      current = current.parentId === undefined ? undefined : getNode(current.parentId);
    }
    let parent = current ? resolved.get(current.id) : undefined;
    for (let i = path.length - 1; i >= 0; i--) {
      const node = path[i];
      const managed = node.layoutItem !== undefined && !!parent?.inLayout;
      parent = {
        selectedRoot: parent?.selectedRoot ?? (selected.has(node.id) ? node.id : undefined),
        locked: node.locked || !!parent?.locked,
        inLayout: !!node.layout || managed,
        managed
      };
      resolved.set(node.id, parent);
    }
  }
  const nodes: Readonly<NodeEntity>[] = [];
  let blockedBy: NodeArrangementInfo['blockedBy'];
  for (const id of selected) {
    const state = resolved.get(id)!;
    if (state.selectedRoot !== id) continue;
    nodes.push(getNode(id)!);
    if (state.locked) blockedBy = 'locked';
    else if (state.managed && !blockedBy) blockedBy = 'layout';
  }
  return { nodes, info: { count: nodes.length, ...(blockedBy && { blockedBy }) } };
}

/** 按世界轴对齐轴对称包围盒，不改变节点旋转、尺寸及选区。 */
export function planNodeAlignment(
  items: readonly NodeArrangementItem[],
  alignment: NodeAlignment
): NodeArrangementMove[] {
  if (items.length < 2) return [];
  const horizontal = alignment === 'left' || alignment === 'right' || alignment === 'center-x';
  const low = horizontal ? 'left' : 'top';
  const high = horizontal ? 'right' : 'bottom';
  let min = Infinity,
    max = -Infinity;
  for (const { bounds } of items) {
    min = Math.min(min, bounds[low]);
    max = Math.max(max, bounds[high]);
  }
  const position = (bounds: RectBounds) =>
    alignment === 'left' || alignment === 'top'
      ? bounds[low]
      : alignment === 'right' || alignment === 'bottom'
        ? bounds[high]
        : (bounds[low] + bounds[high]) / 2;
  const target =
    alignment === 'left' || alignment === 'top'
      ? min
      : alignment === 'right' || alignment === 'bottom'
        ? max
        : (min + max) / 2;
  return items.map(({ id, bounds }) => ({
    id,
    delta: horizontal ? { x: target - position(bounds), y: 0 } : { x: 0, y: target - position(bounds) }
  }));
}

/** 固定排序后的两端，均分边缘间距；负间距表示等量重叠。 */
export function planNodeDistribution(
  items: readonly NodeArrangementItem[],
  axis: NodeDistributionAxis
): NodeArrangementMove[] {
  if (items.length < 3) return [];
  const horizontal = axis === 'horizontal';
  const low = horizontal ? 'left' : 'top';
  const high = horizontal ? 'right' : 'bottom';
  const sorted = [...items].sort((a, b) => a.bounds[low] - b.bounds[low] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const start = sorted[0].bounds[low];
  const totalSize = sorted.reduce((sum, item) => sum + item.bounds[high] - item.bounds[low], 0);
  const gap = (sorted[sorted.length - 1].bounds[high] - start - totalSize) / (sorted.length - 1);
  let sizes = 0;
  return sorted.map(({ id, bounds }, index) => {
    const delta = index === 0 || index === sorted.length - 1 ? 0 : start + sizes + index * gap - bounds[low];
    sizes += bounds[high] - bounds[low];
    return { id, delta: horizontal ? { x: delta, y: 0 } : { x: 0, y: delta } };
  });
}

/** 自动估算列数，优先采用高度贪心平衡（紧凑瀑布流），消除尺寸异构产生的巨大空白；保持内容尺寸与确定性。 */
export function planNodeAutoArrangement(
  items: readonly NodeArrangementItem[],
  options: NodeAutoArrangeOptions = {}
): NodeArrangementMove[] {
  if (items.length < 2) return [];
  const rawGap = options.gap ?? 20;
  if (!Number.isFinite(rawGap)) return [];
  const gap = Math.max(0, Math.round(rawGap));
  const reqMode = options.mode ?? 'auto';

  const byId = (a: NodeArrangementItem, b: NodeArrangementItem) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const byX = (a: NodeArrangementItem, b: NodeArrangementItem) => a.bounds.left - b.bounds.left || byId(a, b);
  const sorted = [...items].sort((a, b) => a.bounds.top - b.bounds.top || byX(a, b));

  // 旋转父坐标取整可使同一视觉行的顶边有微小误差；先分行再排序，避免容差比较器失去传递性。
  for (let start = 0; start < sorted.length;) {
    const anchor = sorted[start].bounds;
    const tolerance = Math.min(2, (anchor.bottom - anchor.top) / 2);
    let end = start + 1;
    while (end < sorted.length && sorted[end].bounds.top - anchor.top <= tolerance) end++;
    const row = sorted.slice(start, end).sort(byX);
    for (let i = start; i < end; i++) sorted[i] = row[i - start];
    start = end;
  }

  const columns = Math.ceil(Math.sqrt(sorted.length));
  let left = Infinity,
    top = Infinity,
    minH = Infinity,
    maxH = -Infinity;
  for (const { bounds } of sorted) {
    const h = bounds.bottom - bounds.top;
    minH = Math.min(minH, h);
    maxH = Math.max(maxH, h);
    left = Math.min(left, bounds.left);
    top = Math.min(top, bounds.top);
  }

  // 模式决策：尺寸相近时保持严格网格行列对齐；显式指定 compact 或极差悬殊 (如含脑图，极差>=5) 时智能走瀑布流
  const useCompact = reqMode === 'compact' || (reqMode === 'auto' && minH > 0 && maxH / minH >= 5);

  if (!useCompact) {
    const rows = Math.ceil(sorted.length / columns);
    const widths = new Array<number>(columns).fill(0);
    const heights = new Array<number>(rows).fill(0);
    sorted.forEach(({ bounds }, index) => {
      const col = index % columns;
      const row = Math.floor(index / columns);
      widths[col] = Math.max(widths[col], bounds.right - bounds.left);
      heights[row] = Math.max(heights[row], bounds.bottom - bounds.top);
    });
    const xs: number[] = [],
      ys: number[] = [];
    let curX = left,
      curY = top;
    for (const width of widths) {
      xs.push(curX);
      curX += width + gap;
    }
    for (const height of heights) {
      ys.push(curY);
      curY += height + gap;
    }
    return sorted.map(({ id, bounds }, index) => ({
      id,
      delta: { x: xs[index % columns] - bounds.left, y: ys[Math.floor(index / columns)] - bounds.top }
    }));
  }

  // 紧凑模式：两趟贪心模拟，动态平衡各列高度，消除异构大图元下方的空白空洞
  const colHeights = new Array<number>(columns).fill(0);
  const colWidths = new Array<number>(columns).fill(0);
  const assignments = new Array<number>(sorted.length);

  sorted.forEach(({ bounds }, index) => {
    const w = bounds.right - bounds.left;
    const h = bounds.bottom - bounds.top;
    let targetCol = 0;
    let shortest = colHeights[0];
    for (let c = 1; c < columns; c++) {
      if (colHeights[c] < shortest) {
        shortest = colHeights[c];
        targetCol = c;
      }
    }
    assignments[index] = targetCol;
    colWidths[targetCol] = Math.max(colWidths[targetCol], w);
    colHeights[targetCol] += h + gap;
  });

  const colLefts = new Array<number>(columns);
  let curX = left;
  for (let c = 0; c < columns; c++) {
    colLefts[c] = curX;
    curX += colWidths[c] + gap;
  }

  const colTops = new Array<number>(columns).fill(top);
  return sorted.map(({ id, bounds }, index) => {
    const col = assignments[index];
    const targetX = colLefts[col];
    const targetY = colTops[col];
    colTops[col] += bounds.bottom - bounds.top + gap;
    return {
      id,
      delta: { x: targetX - bounds.left, y: targetY - bounds.top }
    };
  });
}
