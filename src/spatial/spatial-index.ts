/**
 * @file spatial-index.ts
 * @description 空间拓扑索引标准接口与通用定义
 *
 * 设计考量 (Why):
 * 1. 依赖倒置原则 (DIP)：上层 (SkyNoteEngine、渲染器、选框) 仅面向 SpatialIndex 抽象接口编程，
 *    与底层具体算法解耦。
 * 2. 随意热插拔：底层支持在 R-Tree (默认自适应层次包围盒) 与 SpatialGrid (网格哈希) 之间无缝切换，
 *    未来甚至可平替为 WebAssembly 或 Web Worker 离屏加速索引，上层调用零修改。
 */

/** 批量装载条目：[实体 id, 包围盒] */
export type SpatialIndexEntry = readonly [string, RectBounds];

/**
 * 空间拓扑索引标准抽象接口
 */
export interface SpatialIndex {
  /**
   * 插入或更新节点空间包围盒
   */
  update(nodeId: string, bounds: RectBounds): void;

  /**
   * 批量插入或更新 (初次加载、大批量粘贴或全量同步)
   * 实现可据此选择整体重建，例如 R-Tree 的 STR 批量装载
   */
  load(entries: Iterable<SpatialIndexEntry>): void;

  /**
   * 移除指定节点
   */
  remove(nodeId: string): boolean;

  /**
   * 获取指定节点的当前包围盒
   */
  getBounds(nodeId: string): RectBounds | undefined;

  /**
   * 视锥与区域相交检索 (供渲染器 Culling 与框选使用)
   */
  search(queryBounds: RectBounds): readonly string[];

  /**
   * 点选碰撞拾取
   */
  hitTest(point: Point): readonly string[];

  /**
   * 清空全部索引数据
   */
  clear(): void;

  /**
   * 当前被索引的节点总数
   */
  readonly size: number;
}
import type { Point, RectBounds } from '../types/geometry';
