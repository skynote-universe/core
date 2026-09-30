/**
 * @file text-layout.ts
 * @description 文本驱动的节点自动尺寸排版 (纯函数)
 *
 * 设计考量 (Why):
 * 1. 事务内派生：文本或宽度变化后重新测量，得到的宽高补丁并入同一事务，撤销文字修改时尺寸一并回退；
 *    不在变更监听中另行提交，杜绝级联指令。
 * 2. 只处理受影响节点：从本次补丁中定位 textBlocks / textStyle / width 等排版相关变更，开销与画布规模无关。
 * 3. 样式与策略的解析顺序：插槽默认样式 < 节点 textStyle < 文本块 style；尺寸策略取
 *    文本块 sizing > 插槽 sizing > 由节点 sizingPolicy 推断的默认值。
 */

import type { CanvasDocument } from '../types/canvas';
import type { NodeEntity } from '../types/node';
import type { NodeTextStyle, TextBlock, TextSizingMode } from '../types/text';
import { getPlainText } from '../types/text';
import type { TextPrimitive } from '../protocols/primitives.protocol';
import type { TextPadding } from '../types/style';
import type { CanvasPatch } from '../types/operation';
import type {
  NodeFitContext,
  NodeTextSlotDefinition,
  NodeTypeDefinition,
  TextBlockMetrics
} from '../protocols/node-type.protocol';
import type { TextMeasurer } from '../protocols/text-measurer.protocol';
import type { NodeTypeRegistry } from '../registry/node-type-registry';
import { normalizePatchPath } from '../operation/patch-path';

/**
 * 这些字段变化后需要重新派生尺寸：文本与宽度改变排版结果 (宽度影响折行)；
 * 高度由内容决定的节点被写入高度 (如缩放控制柄) 时也要在同一事务内纠正，否则会停在写入值上，
 * 与下一次按内容派生的高度交替出现 (拖动时外框闪烁)
 */
const LAYOUT_TRIGGER_FIELDS: ReadonlySet<string | number> = new Set([
  'textBlocks',
  'textStyle',
  'width',
  'height',
  'nodeType'
]);
/** 尺寸比较容差：浮点测量抖动不产生无意义的尺寸补丁 */
const SIZE_EPSILON = 0.5;

export interface ResolvedPadding {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** 文本内边距展开为四边 (单值或 [上, 右, 下, 左]，与 CSS 简写规则一致) */
export function resolveTextPadding(padding: TextPadding | undefined): ResolvedPadding {
  if (padding === undefined) return { top: 0, right: 0, bottom: 0, left: 0 };
  if (typeof padding === 'number') return { top: padding, right: padding, bottom: padding, left: padding };
  const [top, right = top, bottom = top, left = right] = padding;
  return { top, right, bottom, left };
}

/**
 * 文本块 → 文本图元的唯一映射
 * 节点 compose() 绘制文字与测量器测量文字必须共用此函数，保证测得的尺寸与实际绘制一致
 * @param box 图元位置；width 缺省表示不折行 (auto-width)，height 缺省为内容自然高度 (测量时必须缺省)
 */
export function createTextBlockPrimitive(
  block: Readonly<TextBlock>,
  style: Readonly<NodeTextStyle>,
  box: { x: number; y: number; width?: number; height?: number }
): TextPrimitive {
  return {
    kind: 'text',
    id: block.id,
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
    text: getPlainText(block as TextBlock),
    fill: style.color,
    fontSize: style.fontSize,
    fontFamily: style.fontFamily,
    fontWeight: style.fontWeight,
    fontStyle: style.fontStyle,
    lineHeight: style.lineHeight,
    letterSpacing: style.letterSpacing,
    textAlign: style.textAlign,
    verticalAlign: style.verticalAlign,
    textBaseline: style.textBaseline,
    textOverflow: style.textOverflow,
    textDecoration: style.textDecoration,
    textWrap: style.textWrap
  };
}

function findTextSlot(
  block: Readonly<TextBlock>,
  definition: NodeTypeDefinition | undefined
): NodeTextSlotDefinition | undefined {
  return block.slot !== undefined ? definition?.slots?.find((slot) => slot.slot === block.slot) : undefined;
}

/**
 * 文本块的最终样式：插槽默认样式 < 节点 textStyle < 文本块 style
 * 节点 compose() 绘制与测量器测量必须用同一份解析结果，否则量出的尺寸与画面不一致
 */
export function resolveTextBlockStyle(
  node: Readonly<NodeEntity>,
  block: Readonly<TextBlock>,
  definition: NodeTypeDefinition | undefined
): NodeTextStyle {
  return { ...findTextSlot(block, definition)?.defaultStyle, ...node.textStyle, ...block.style };
}

/** 节点类型 fitContent() 的测量上下文：样式解析与测量走排版派生的同一路径，适应结果与派生尺寸一致 */
export function createFitContext(
  node: Readonly<NodeEntity>,
  definition: NodeTypeDefinition,
  measurer: TextMeasurer | null
): NodeFitContext {
  return {
    measureText: (block, maxWidth) =>
      measurer &&
      measurer.measure({
        block,
        style: resolveTextBlockStyle(node, block, definition),
        sizing: maxWidth === undefined ? 'auto-width' : 'auto-height',
        maxWidth
      })
  };
}

/**
 * 从一次提交的补丁中找出需要重新排版的节点
 * 整体替换 content / nodes (导入、全量同步) 不在此列：持久化文档中的尺寸即排版结果
 */
export function collectTextLayoutTargets(patches: readonly CanvasPatch[]): Set<string> {
  const targets = new Set<string>();
  for (let i = 0; i < patches.length; i++) {
    const patch = patches[i];
    const segments = normalizePatchPath(patch.path);
    if (segments[0] !== 'content' || segments[1] !== 'nodes' || segments.length < 3) continue;
    const id = String(segments[2]);

    if (segments.length === 3) {
      if (patch.op !== 'set') continue;
      if (!patch.merge || Object.keys(patch.value as object).some((key) => LAYOUT_TRIGGER_FIELDS.has(key))) {
        targets.add(id);
      }
    } else if (LAYOUT_TRIGGER_FIELDS.has(segments[3])) {
      targets.add(id);
    }
  }
  return targets;
}

/**
 * 计算节点在当前文本内容下应有的尺寸
 * @returns 节点类型不参与自动尺寸 (fixed 且无 computeBounds) 时返回 null
 */
export function computeTextLayout(
  node: Readonly<NodeEntity>,
  definition: NodeTypeDefinition | undefined,
  measurer: TextMeasurer
): { width: number; height: number } | null {
  const policy = definition?.sizingPolicy ?? 'fixed';
  if (policy === 'fixed' && !definition?.computeBounds) return null;

  const blocks = node.textBlocks ?? [];
  const defaultSizing: TextSizingMode = policy === 'content-driven' ? 'auto-width' : 'auto-height';
  const metrics = new Map<string, TextBlockMetrics>();
  let contentWidth = 0;
  let contentHeight = 0;

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const slot = findTextSlot(block, definition);
    const style = resolveTextBlockStyle(node, block, definition);
    const sizing = block.sizing ?? slot?.sizing ?? defaultSizing;
    const padding = resolveTextPadding(style.padding);
    const maxWidth =
      sizing === 'auto-width'
        ? undefined
        : Math.max(0, (block.explicitWidth ?? node.width) - padding.left - padding.right);

    const measured = measurer.measure({ block, style, sizing, maxWidth });
    metrics.set(block.slot ?? block.id, measured);

    if (slot?.expandsContainer === false) continue;
    contentWidth = Math.max(contentWidth, measured.width + padding.left + padding.right);
    contentHeight += (block.explicitHeight ?? measured.height) + padding.top + padding.bottom;
  }

  if (definition?.computeBounds) {
    return definition.computeBounds(node as NodeEntity, metrics);
  }
  if (blocks.length === 0) return null;
  return policy === 'content-driven'
    ? { width: Math.ceil(contentWidth), height: Math.ceil(contentHeight) }
    : { width: node.width, height: Math.ceil(contentHeight) };
}

/**
 * 为指定节点生成尺寸补丁 (与当前尺寸一致时不生成)
 * 单个节点测量或 computeBounds 抛错时跳过该节点，不阻断文本本身的修改
 */
export function deriveTextLayoutPatches(
  doc: Readonly<CanvasDocument>,
  nodeIds: Iterable<string>,
  measurer: TextMeasurer,
  nodeTypes: NodeTypeRegistry
): CanvasPatch[] {
  const patches: CanvasPatch[] = [];
  for (const id of nodeIds) {
    if (!Object.hasOwn(doc.content.nodes, id)) continue;
    const node = doc.content.nodes[id];

    let size: { width: number; height: number } | null;
    try {
      size = computeTextLayout(node, nodeTypes.get(node.nodeType), measurer);
    } catch (err) {
      console.error(`[TextLayout] 节点 ${id} (${node.nodeType}) 排版失败，保持原尺寸:`, err);
      continue;
    }
    if (!size) continue;

    if (Math.abs(size.width - node.width) > SIZE_EPSILON) {
      patches.push({ op: 'set', path: ['content', 'nodes', id, 'width'], value: size.width });
    }
    if (Math.abs(size.height - node.height) > SIZE_EPSILON) {
      patches.push({ op: 'set', path: ['content', 'nodes', id, 'height'], value: size.height });
    }
  }
  return patches;
}
