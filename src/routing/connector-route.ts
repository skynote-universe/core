/**
 * @file connector-route.ts
 * @description 连线端点解析与路由求解 (纯函数)
 *
 * 设计考量 (Why):
 * 1. 路由属于平台中立的几何计算：放在内核由引擎统一求解并缓存，任何渲染后端 (Leafer / SVG 导出)、
 *    空间索引与业务插件共享同一份结果，不再各自重复寻路。
 * 2. 包围盒取真实路由点集：正交/避障路由拐出两端节点范围时，视锥裁剪与拾取依旧准确。
 */

import type { Point } from '../types/canvas';
import type { NodeEntity } from '../types/node';
import type { ConnectorEntity, ConnectorEndpoint } from '../types/connector';
import type { ComputedRoute } from '../types/runtime';
import { nodeLocalToWorld } from '../utils/geometry';
import type { ConnectorRouterRegistry } from '../registry/connector-router-registry';

/**
 * 求解端点世界坐标：优先自由坐标，其次按 anchorId 求解吸附点 (0~1 视为相对比例，否则为绝对偏移)，兜底节点中心
 * 锚点随节点一起绕中心旋转
 * @returns 端点绑定的节点不存在且无自由坐标 (悬空连线) 时返回 null
 */
export function resolveConnectorEndpoint(
  endpoint: Readonly<ConnectorEndpoint>,
  node: Readonly<NodeEntity> | undefined
): Point | null {
  if (endpoint.position) {
    return { x: endpoint.position.x, y: endpoint.position.y };
  }
  if (!node) return null;

  const anchor = endpoint.anchorId ? node.anchors?.find((a) => a.id === endpoint.anchorId) : undefined;
  if (anchor) {
    const relX = anchor.x >= 0 && anchor.x <= 1 ? node.width * anchor.x : anchor.x;
    const relY = anchor.y >= 0 && anchor.y <= 1 ? node.height * anchor.y : anchor.y;
    return nodeLocalToWorld(node, relX, relY);
  }
  return { x: node.x + node.width / 2, y: node.y + node.height / 2 };
}

/**
 * 求解连线路由：调用连线类型对应的路由器 (未注册时回退直线)，并计算包围盒与总长度
 * @returns 任一端点无法定位时返回 null
 */
export function computeConnectorRoute(
  connector: Readonly<ConnectorEntity>,
  resolveNode: (nodeId: string) => Readonly<NodeEntity> | undefined,
  routers: ConnectorRouterRegistry
): ComputedRoute | null {
  const start = resolveConnectorEndpoint(
    connector.from,
    connector.from.nodeId ? resolveNode(connector.from.nodeId) : undefined
  );
  const end = resolveConnectorEndpoint(
    connector.to,
    connector.to.nodeId ? resolveNode(connector.to.nodeId) : undefined
  );
  if (!start || !end) return null;

  const result = routers.get(connector.connectorType).route({
    startPoint: start,
    endPoint: end,
    controlPoints: connector.controlPoints,
    style: connector.style,
    connector
  });
  const points = result.points.length >= 2 ? result.points.map((p) => ({ x: p.x, y: p.y })) : [start, end];

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

  return {
    points,
    pathData: result.pathData,
    totalLength,
    bounds: { left, top, right, bottom, width: right - left, height: bottom - top }
  };
}
