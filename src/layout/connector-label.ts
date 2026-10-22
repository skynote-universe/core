/**
 * @file connector-label.ts
 * @description 连线上的文字：沿路由按比例定位、居中排版 (纯函数)
 *
 * 设计考量 (Why):
 * 1. 文字的排版随路由一起求解 (引擎在路由失效时重算)：拾取、包围盒、渲染与画布内编辑读同一份结果，
 *    点在文字上即点中连线，视锥裁剪不会切掉伸出线外的文字。
 * 2. 位置存沿线长度的比例 (0 起点 ~ 1 终点)：两端节点移动、路由改变后文字仍在线上相同的相对位置。
 * 3. 文字不超过最大宽度时不限宽：编辑中随输入伸展，不在半途折行；超过时按最大宽度折行。
 */

import type { Point, RectBounds } from '../types/geometry';
import type { ConnectorTextBlock } from '../types/connector';
import type { NodeTextStyle } from '../types/text';
import type { TextPrimitive } from '../protocols/primitives.protocol';
import type { FontMeasurer } from '../protocols/font-measurer.protocol';
import type { TextEditingTarget } from '../state/session-store';
import { layoutText } from './rich-text-layout';
import { editingTextBounds, editingTextPrimitive } from './rich-text-edit';
import { expandBounds } from '../utils/geometry';
import { scaleTextBlockPixels } from './text-layout';

/** 连线文字的默认样式 (文字块自身的样式覆盖它) */
export const CONNECTOR_LABEL_STYLE: Readonly<NodeTextStyle> = Object.freeze({
  fontSize: 14,
  lineHeight: 1.4,
  textAlign: 'center'
});
/** 文字超过该宽度时折行 (世界坐标) */
const LABEL_MAX_WIDTH = 240;
/** 底色比文字四周多出的留白：遮住文字下面的线 */
export const CONNECTOR_LABEL_PADDING = 4;

/** 复用文字像素规则；沿线比例保持不变，单位倍率恢复默认继承和未设置的偏移。 */
export function scaleConnectorTextBlocks(blocks: readonly ConnectorTextBlock[], scale: number): ConnectorTextBlock[] {
  if (scale === 1) return [...blocks];
  return blocks.map((block) => ({
    ...block,
    ...scaleTextBlockPixels({ ...block, explicitWidth: block.explicitWidth ?? LABEL_MAX_WIDTH }, scale, {
      ...CONNECTOR_LABEL_STYLE,
      ...block.style
    }),
    ...(block.offsetX !== undefined ? { offsetX: Math.round(block.offsetX * scale) } : {}),
    ...(block.offsetY !== undefined ? { offsetY: Math.round(block.offsetY * scale) } : {})
  }));
}

/** 一段连线文字的排版结果 */
export interface ConnectorLabelLayout {
  readonly blockId: string;
  /** 文字图元 (世界坐标)，颜色未设置时由渲染端取主题文字色 */
  readonly primitive: TextPrimitive;
  /** 含留白的底色范围 (世界坐标)：拾取与遮线 */
  readonly bounds: RectBounds;
}

/** 折线上按长度比例 t (0~1) 的点 */
export function pointAlongPolyline(points: readonly Point[], t: number): Point {
  let total = 0;
  for (let i = 1; i < points.length; i++)
    total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  let remaining = Math.max(0, Math.min(1, t)) * total;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (remaining <= length && length > 0) {
      const k = remaining / length;
      return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
    }
    remaining -= length;
  }
  return { ...points[points.length - 1] };
}

/** 点投影到折线上最近处的长度比例 (0~1) */
export function projectOntoPolyline(points: readonly Point[], p: Point): number {
  let total = 0;
  let best = Infinity;
  let bestAt = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSq = dx * dx + dy * dy;
    const k = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq));
    const distance = Math.hypot(p.x - (a.x + dx * k), p.y - (a.y + dy * k));
    const length = Math.sqrt(lengthSq);
    if (distance < best) {
      best = distance;
      bestAt = total + length * k;
    }
    total += length;
  }
  return total === 0 ? 0.5 : bestAt / total;
}

/** 连线全部文字的排版：文字中心落在线上 position 处 (加偏移) */
export function layoutConnectorLabels(
  blocks: readonly ConnectorTextBlock[],
  points: readonly Point[],
  fonts: FontMeasurer
): ConnectorLabelLayout[] {
  return blocks.map((block) => {
    const style = { ...CONNECTOR_LABEL_STYLE, ...block.style };
    let layout = layoutText(block.runs, style, {}, fonts);
    const maxWidth = block.explicitWidth ?? LABEL_MAX_WIDTH;
    const wraps = layout.width > maxWidth;
    if (wraps) layout = layoutText(block.runs, style, { width: maxWidth }, fonts);
    const center = pointAlongPolyline(points, block.position);
    const x = center.x + (block.offsetX ?? 0) - layout.width / 2;
    const y = center.y + (block.offsetY ?? 0) - layout.height / 2;
    const pad = CONNECTOR_LABEL_PADDING;
    return {
      blockId: block.id,
      primitive: {
        kind: 'text',
        id: block.id,
        x,
        y,
        ...(wraps && { width: maxWidth }),
        runs: block.runs,
        style
      },
      bounds: { left: x - pad, top: y - pad, right: x + layout.width + pad, bottom: y + layout.height + pad }
    };
  });
}

/**
 * 连线文字当前显示的图元与底色范围：正在编辑的那段换成编辑视图 (插入输入法组合文字、随输入伸展)，
 * 渲染与选中范围框共用，拼音输入中范围框与底色同步变化
 * @param editing 正在编辑的本连线文字；不是本连线时传 null
 */
export function displayedConnectorLabel(
  label: ConnectorLabelLayout,
  editing: TextEditingTarget | null,
  fonts: FontMeasurer | null
): { primitive: TextPrimitive; bounds: RectBounds } {
  if (editing?.blockId !== label.blockId) return label;
  const primitive = editingTextPrimitive(label.primitive, editing);
  if (!fonts) return { primitive, bounds: label.bounds };
  const layout = layoutText(primitive.runs, primitive.style, { width: primitive.width }, fonts);
  return { primitive, bounds: expandBounds(editingTextBounds(primitive, layout), CONNECTOR_LABEL_PADDING) };
}
