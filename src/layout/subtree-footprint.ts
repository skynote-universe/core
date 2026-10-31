import type { NodeEntity } from '../types/node';
import type { Matrix2D, RectBounds } from '../types/geometry';
import { computeNodeLocalMatrix, computeNodeWorldBounds, multiplyMatrix, unionBounds } from '../utils/geometry';

/** 合并子树几何并向外取整；缺省忽略根位姿，传入根矩阵可直接测量父容器坐标中的范围。 */
export function computeSubtreeFootprint(
  root: Readonly<NodeEntity>,
  childrenOf: (id: string) => readonly Readonly<NodeEntity>[],
  rootMatrix?: Matrix2D
): Readonly<RectBounds> {
  let bounds: RectBounds = rootMatrix
    ? computeNodeWorldBounds(root, rootMatrix)
    : { left: 0, top: 0, right: root.width, bottom: root.height };
  const pending: { node: Readonly<NodeEntity>; matrix: Matrix2D }[] = childrenOf(root.id).map((node) => ({
    node,
    matrix: rootMatrix ? multiplyMatrix(rootMatrix, computeNodeLocalMatrix(node)) : computeNodeLocalMatrix(node)
  }));
  for (let index = 0; index < pending.length; index++) {
    const { node, matrix } = pending[index];
    bounds = unionBounds(bounds, computeNodeWorldBounds(node, matrix));
    for (const child of childrenOf(node.id))
      pending.push({ node: child, matrix: multiplyMatrix(matrix, computeNodeLocalMatrix(child)) });
  }
  return Object.freeze({
    left: Math.floor(bounds.left),
    top: Math.floor(bounds.top),
    right: Math.ceil(bounds.right),
    bottom: Math.ceil(bounds.bottom)
  });
}
