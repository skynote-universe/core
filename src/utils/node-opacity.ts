/**
 * @file node-opacity.ts
 * @description 按节点类型声明判断零透明度是否隐藏整个节点
 */

import type { NodeTypeDefinition } from '../protocols/node-type.protocol';
import type { NodeEntity } from '../types/node';

export function isNodeHiddenByOpacity(
  node: Readonly<NodeEntity>,
  definition: Pick<NodeTypeDefinition, 'opacityBehavior'> | undefined
): boolean {
  return node.style?.opacity === 0 && definition?.opacityBehavior !== 'renderer-defined';
}
