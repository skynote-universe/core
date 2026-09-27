/**
 * @file index.ts
 * @description 空间拓扑索引模块导出入口
 */

import type { SpatialIndex } from './spatial-index';
import { RTreeSpatialIndex, type RTreeOptions } from './r-tree';
import { SpatialGridIndex, type SpatialGridIndexOptions } from './spatial-grid-index';

export * from './spatial-index';
export * from './r-tree';
export * from './spatial-grid-index';

/**
 * 空间拓扑索引工厂函数
 * 默认采用 R-Tree 层次包围盒算法，自适应任意悬殊尺寸与超大画框 Frame
 */
export function createSpatialIndex(
  type: 'rtree' | 'grid' = 'rtree',
  options?: RTreeOptions | SpatialGridIndexOptions
): SpatialIndex {
  if (type === 'grid') {
    return new SpatialGridIndex(options as SpatialGridIndexOptions);
  }
  return new RTreeSpatialIndex(options as RTreeOptions);
}
