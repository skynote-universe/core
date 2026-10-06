/**
 * @file connector-route.ts
 * @description 连线端点解析与路由求解 (纯函数)
 *
 * 设计考量 (Why):
 * 1. 路由属于平台中立的几何计算：放在内核由引擎统一求解并缓存，任何渲染器 (Leafer / SVG 导出)、
 *    空间索引与业务插件共享同一份结果，不再各自重复寻路。
 * 2. 包围盒取真实路由点集：正交/避障路由拐出两端节点范围时，视锥裁剪与拾取依旧准确。
 * 3. 浮动端依赖另一端：先定出固定端与自由端，浮动端再朝向另一端 (另一端也浮动时朝向其中心) 选出线位置。
 */

import type { Matrix2D, Point } from '../types/geometry';
import type { NodeEntity } from '../types/node';
import type { ConnectorEntity, ConnectorEndpoint, ConnectorStyle } from '../types/connector';
import type { ComputedRoute } from '../types/runtime';
import type { FontMeasurer } from '../protocols/font-measurer.protocol';
import { layoutConnectorLabels } from '../layout/connector-label';
import type { ConnectorRouteEnd, FloatingEndpointMode } from '../protocols/connector-router.protocol';
import { applyMatrix, applyMatrixToVector, computeNodeWorldBounds, invertMatrix } from '../utils/geometry';
import type { ConnectorRouterRegistry } from '../registry/connector-router-registry';
import { outlineAnchors, outlineExit, projectOntoOutline, type OutlinePoint } from './outline';

/** 端点绑定的节点、世界矩阵与轮廓 (节点坐标相对父容器，ADR-114) */
export interface ResolvedEndpointNode {
  readonly node: Readonly<NodeEntity>;
  readonly worldMatrix: Matrix2D;
  /** 局部坐标轮廓 (见 resolveNodeOutline) */
  readonly outline: readonly Point[];
  /** 节点描边宽度 (生效样式)：描边以轮廓为中线，线端外移半个描边宽度，箭头尖端停在描边外沿而不是压在描边中间 */
  readonly strokeWidth: number;
}

/** 路由所需的连线字段：已保存的连线，或拖拽中尚未提交的预览连线 */
export type ConnectorRouteSource = Pick<ConnectorEntity, 'connectorType' | 'from' | 'to' | 'style' | 'controlPoints'> &
  Partial<Pick<ConnectorEntity, 'textBlocks'>>;

/** 连线的生效样式：路由器默认样式 < 连线自身样式 */
export function resolveConnectorStyle(
  connector: Readonly<Pick<ConnectorEntity, 'connectorType' | 'style'>>,
  routers: ConnectorRouterRegistry
): ConnectorStyle {
  return { ...routers.get(connector.connectorType).defaultStyle, ...connector.style };
}

/** 把局部轮廓点换算到世界：法线只受旋转影响，重新归一化以抵消缩放 */
function toWorldEnd(resolved: ResolvedEndpointNode, local: OutlinePoint): ConnectorRouteEnd {
  const { worldMatrix: m, node, strokeWidth } = resolved;
  const normal = applyMatrixToVector(m, local.normal.x, local.normal.y);
  const length = Math.hypot(normal.x, normal.y);
  const point = applyMatrix(m, local.point.x, local.point.y);
  if (length === 0) return { point, bounds: computeNodeWorldBounds(node, m) };
  const direction = { x: normal.x / length, y: normal.y / length };
  const gap = strokeWidth / 2;
  return {
    point: { x: point.x + direction.x * gap, y: point.y + direction.y * gap },
    direction,
    bounds: computeNodeWorldBounds(node, m)
  };
}

/** 固定端：按比例还原局部坐标后投影回当前轮廓 (多边形近似的椭圆缩放后仍贴边) */
function resolveFixedEnd(resolved: ResolvedEndpointNode, anchor: Point): ConnectorRouteEnd {
  const { node, outline } = resolved;
  return toWorldEnd(resolved, projectOntoOutline(outline, { x: anchor.x * node.width, y: anchor.y * node.height }));
}

/** 浮动端：按路由器的方式朝向 target 选出线位置；射线落空 (target 在节点内部) 时退回中心 */
function resolveFloatingEnd(
  resolved: ResolvedEndpointNode,
  target: Point,
  mode: FloatingEndpointMode
): ConnectorRouteEnd {
  const { node, outline, worldMatrix } = resolved;
  const center = { x: node.width / 2, y: node.height / 2 };
  const local = applyMatrix(invertMatrix(worldMatrix), target.x, target.y);
  if (mode === 'side') {
    const dx = local.x - center.x;
    const dy = local.y - center.y;
    const anchors = outlineAnchors(outline);
    let best = anchors[0];
    let bestDot = -Infinity;
    for (const anchor of anchors) {
      const dot = anchor.normal.x * dx + anchor.normal.y * dy;
      if (dot > bestDot) {
        bestDot = dot;
        best = anchor;
      }
    }
    return toWorldEnd(resolved, best);
  }
  const exit = outlineExit(outline, center, local);
  return exit
    ? toWorldEnd(resolved, exit)
    : { point: applyMatrix(worldMatrix, center.x, center.y), bounds: computeNodeWorldBounds(node, worldMatrix) };
}

/**
 * 解析连线两端：自由端取坐标，固定端取轮廓点与外法线，浮动端朝向另一端选定
 * @returns 任一端绑定的节点不存在 (悬空连线) 时返回 null
 */
export function resolveConnectorEnds(
  connector: Readonly<Pick<ConnectorEntity, 'from' | 'to'>>,
  resolveNode: (nodeId: string) => ResolvedEndpointNode | undefined,
  mode: FloatingEndpointMode
): [ConnectorRouteEnd, ConnectorRouteEnd] | null {
  type Pending = { fixed: ConnectorRouteEnd } | { floating: ResolvedEndpointNode };
  const prepare = (endpoint: Readonly<ConnectorEndpoint>): Pending | null => {
    if (endpoint.nodeId === undefined) return endpoint.position ? { fixed: { point: endpoint.position } } : null;
    const resolved = resolveNode(endpoint.nodeId);
    if (!resolved) return null;
    return endpoint.anchor ? { fixed: resolveFixedEnd(resolved, endpoint.anchor) } : { floating: resolved };
  };
  const start = prepare(connector.from);
  const end = prepare(connector.to);
  if (!start || !end) return null;

  const referenceOf = (pending: Pending): Point => {
    if ('fixed' in pending) return pending.fixed.point;
    const { node, worldMatrix } = pending.floating;
    return applyMatrix(worldMatrix, node.width / 2, node.height / 2);
  };
  const finish = (pending: Pending, other: Pending): ConnectorRouteEnd =>
    'fixed' in pending ? pending.fixed : resolveFloatingEnd(pending.floating, referenceOf(other), mode);
  return [finish(start, end), finish(end, start)];
}

/**
 * 求解连线路由：调用连线类型对应的路由器 (未注册时回退直线)，排版连线文字，并计算包围盒与总长度
 * @param fonts 字体测量器：缺省时不排版文字 (如尚未挂载渲染器)
 * @returns 任一端点无法定位时返回 null
 */
export function computeConnectorRoute(
  connector: Readonly<ConnectorRouteSource>,
  resolveNode: (nodeId: string) => ResolvedEndpointNode | undefined,
  routers: ConnectorRouterRegistry,
  fonts?: FontMeasurer | null
): ComputedRoute | null {
  const router = routers.get(connector.connectorType);
  const ends = resolveConnectorEnds(connector, resolveNode, router.floating ?? 'boundary');
  if (!ends) return null;
  const [start, end] = ends;

  const result = router.route({
    start,
    end,
    controlPoints: connector.controlPoints,
    style: resolveConnectorStyle(connector, routers)
  });
  const points = result.points.length >= 2 ? result.points.map((p) => ({ x: p.x, y: p.y })) : [start.point, end.point];

  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  let totalLength = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    left = Math.min(left, p.x);
    top = Math.min(top, p.y);
    right = Math.max(right, p.x);
    bottom = Math.max(bottom, p.y);
    if (i > 0) totalLength += Math.hypot(p.x - points[i - 1].x, p.y - points[i - 1].y);
  }
  const labels =
    fonts && connector.textBlocks?.length ? layoutConnectorLabels(connector.textBlocks, points, fonts) : [];
  for (const { bounds } of labels) {
    left = Math.min(left, bounds.left);
    top = Math.min(top, bounds.top);
    right = Math.max(right, bounds.right);
    bottom = Math.max(bottom, bounds.bottom);
  }

  return {
    points,
    pathData: result.pathData,
    totalLength,
    bounds: { left, top, right, bottom },
    labels
  };
}
