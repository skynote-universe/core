import type { LayoutVisibilityReader } from './layout-visibility';
import type { EntityReader } from '../state/entity-store';
import type { LayoutReader } from '../protocols/layout.protocol';
import type { Point, RectBounds } from '../types/geometry';
import { computeNodeWorldBounds, unionBounds } from '../utils/geometry';
import { computeSubtreeFootprint } from './subtree-footprint';

export interface SelectionGeometryReader {
  getSubtreeLocalBounds(rootId: string): Readonly<RectBounds> | undefined;
  getSubtreeBounds(rootId: string): Readonly<RectBounds> | undefined;
  canSelectSubtree(id: string): boolean;
  hitTestSubtree(point: Point, tolerance?: number): string | undefined;
}

/** 几何范围与会话选中语义分离，布局插件只声明是否开放整体选中。 */
export class SelectionGeometry implements SelectionGeometryReader {
  private revision = -1;
  private visibilityRevision = -1;
  private readonly bounds = new Map<string, Readonly<RectBounds>>();
  private readonly localBounds = new Map<string, Readonly<RectBounds>>();
  constructor(
    private readonly entities: EntityReader,
    private readonly layouts: LayoutReader,
    private readonly visibility?: LayoutVisibilityReader
  ) {}

  private syncRevision(): void {
    if (
      this.revision !== this.entities.geometryRevision ||
      this.visibilityRevision !== (this.visibility?.revision ?? 0)
    ) {
      this.visibilityRevision = this.visibility?.revision ?? 0;
      this.bounds.clear();
      this.localBounds.clear();
      this.revision = this.entities.geometryRevision;
    }
  }

  getSubtreeLocalBounds(rootId: string): Readonly<RectBounds> | undefined {
    this.syncRevision();
    const cached = this.localBounds.get(rootId);
    if (cached) return cached;
    const root = this.entities.getNode(rootId)?.entity;
    if (!root || this.visibility?.isNodeVisible(rootId) === false) return undefined;
    const bounds = computeSubtreeFootprint(root, (id) =>
      [...this.entities.getChildIds(id)]
        .filter((childId) => this.visibility?.isNodeVisible(childId) !== false)
        .map((childId) => this.entities.getNode(childId)!.entity)
    );
    this.localBounds.set(rootId, bounds);
    return bounds;
  }

  getSubtreeBounds(rootId: string): Readonly<RectBounds> | undefined {
    this.syncRevision();
    const cached = this.bounds.get(rootId);
    if (cached) return cached;
    let bounds: RectBounds | undefined;
    const pending = [rootId];
    for (let index = 0; index < pending.length; index++) {
      const id = pending[index];
      const node = this.entities.getNode(id)?.entity;
      if (!node || this.visibility?.isNodeVisible(id) === false) continue;
      const own = computeNodeWorldBounds(node, this.entities.getWorldTransform(id)!);
      bounds = bounds ? unionBounds(bounds, own) : own;
      for (const childId of this.entities.getChildIds(id)) pending.push(childId);
    }
    if (bounds) this.bounds.set(rootId, Object.freeze(bounds));
    return bounds;
  }

  canSelectSubtree(id: string): boolean {
    const node = this.entities.getNode(id)?.entity;
    return (
      this.visibility?.isNodeVisible(id) !== false &&
      !!node?.layout &&
      !!this.layouts.get(node.layout.type)?.selectableSubtree
    );
  }

  /** 只检索布局根；重叠整体优先最内层，真实节点/连线命中由调用者先处理。 */
  hitTestSubtree(point: Point, tolerance = 0): string | undefined {
    let target: string | undefined;
    let smallest = Infinity;
    for (const id of this.entities.getLayoutRootIds()) {
      if (!this.canSelectSubtree(id)) continue;
      const b = this.getSubtreeBounds(id)!;
      if (
        point.x < b.left - tolerance ||
        point.x > b.right + tolerance ||
        point.y < b.top - tolerance ||
        point.y > b.bottom + tolerance
      )
        continue;
      const area = (b.right - b.left) * (b.bottom - b.top);
      if (area < smallest) {
        target = id;
        smallest = area;
      }
    }
    return target;
  }
}
