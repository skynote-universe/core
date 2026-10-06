/**
 * @file connector-layer.ts
 * @description 连线的层叠位置 (纯函数)：挂在哪个容器、紧贴哪个节点上方
 *
 * 设计考量 (Why):
 * 1. 连线挂在两端节点的最近公共祖先容器中，紧贴两端在该容器中较高的「代表兄弟」(自身或所在的子容器) 上方：
 *    端点落在节点边框上 (ADR-125)，线与箭头画在两端节点之上才完整可见，不被节点的描边与底色盖住；
 *    比较高一端更上层的节点照常盖住连线。较高一端嵌套在子容器里时同样紧贴该子容器上方，
 *    不被容器底色遮挡，也不被容器裁剪 (与 tldraw、FigJam 一致)。
 * 2. 规则放在内核：渲染器据此排序，拾取据此判断点中的节点是否盖住了连线，看到的与点到的永远一致。
 */

import type { ConnectorEntity } from '../types/connector';
import type { NodeEntity } from '../types/node';
import { resolveNodeAncestryChain } from './layer-order';
import { compareFractionalIndex } from '../utils/fractional-index';

/** 连线的挂载位置 */
export interface ConnectorLayerPlacement {
  /** 挂载容器节点 id，undefined 为根内容层 */
  readonly containerId: string | undefined;
  readonly anchorNode: NodeEntity | null;
}

/**
 * 求解连线的挂载容器与伴生锚点
 * @param chainCache 同一帧内复用祖先链
 */
export function resolveConnectorLayerPlacement(
  connector: Pick<ConnectorEntity, 'from' | 'to'>,
  getNode: (nodeId: string) => NodeEntity | undefined,
  chainCache?: Map<string, NodeEntity[]>
): ConnectorLayerPlacement {
  const getChain = (node: NodeEntity): NodeEntity[] => {
    let chain = chainCache?.get(node.id);
    if (!chain) {
      chain = resolveNodeAncestryChain(node, getNode);
      chainCache?.set(node.id, chain);
    }
    return chain;
  };
  const fromNode = connector.from.nodeId ? getNode(connector.from.nodeId) : undefined;
  const toNode = connector.to.nodeId ? getNode(connector.to.nodeId) : undefined;

  // 只有一端绑定节点 (另一端为自由坐标或悬空) 或自环：挂在该节点所在容器，紧贴其上方
  if (!fromNode || !toNode || fromNode.id === toNode.id) {
    const node = fromNode ?? toNode;
    if (!node) return { containerId: undefined, anchorNode: null };
    const chain = getChain(node);
    return { containerId: chain.length > 1 ? chain[chain.length - 2].id : undefined, anchorNode: node };
  }

  const fromChain = getChain(fromNode);
  const toChain = getChain(toNode);
  let depth = 0;
  while (depth < fromChain.length && depth < toChain.length && fromChain[depth].id === toChain[depth].id) {
    depth += 1;
  }

  // 一端是另一端的祖先 (如画框连向自己的子节点)：挂在该祖先内部，锚定另一端在其中的代表兄弟
  if (depth === fromChain.length || depth === toChain.length) {
    const innerChain = depth === fromChain.length ? toChain : fromChain;
    return { containerId: innerChain[depth - 1].id, anchorNode: innerChain[depth] };
  }

  const fromRep = fromChain[depth];
  const toRep = toChain[depth];
  const fromHigher = compareFractionalIndex(fromRep.zIndex, fromRep.id, toRep.zIndex, toRep.id) >= 0;
  return { containerId: depth > 0 ? fromChain[depth - 1].id : undefined, anchorNode: fromHigher ? fromRep : toRep };
}
