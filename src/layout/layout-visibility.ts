import type { EntityReader } from '../state/entity-store';
import type { LayoutReader } from '../protocols/layout.protocol';
import type { NodeEntity } from '../types/node';
import type { ConnectorEntity } from '../types/connector';
import { findLayoutRootId } from './layout-tree';

export interface LayoutVisibilityReader {
  readonly revision: number;
  readonly hasCollapsed: boolean;
  isNodeVisible(id: string): boolean;
  isConnectorVisible(connector: Readonly<ConnectorEntity>): boolean;
}

/** 事务内排版也可使用的纯判断，不读取提交后运行时缓存。 */
export function hidesLayoutChildren(
  node: Readonly<NodeEntity>,
  getNode: (id: string) => Readonly<NodeEntity> | undefined,
  layouts: LayoutReader
): boolean {
  if (!node.layoutState?.collapsed) return false;
  const rootId = findLayoutRootId(node.id, getNode);
  const root = rootId === undefined ? undefined : getNode(rootId);
  return !!root?.layout && !!layouts.get(root.layout.type)?.collapsible;
}

/** 只缓存已提交文档的可见性；不折叠时保持空间检索的常数开销。 */
export class LayoutVisibility implements LayoutVisibilityReader {
  private readonly collapsed = new Set<string>();
  private readonly visible = new Map<string, boolean>();
  revision = 0;
  constructor(
    private readonly entities: EntityReader,
    private readonly layouts: LayoutReader
  ) {}
  get hasCollapsed(): boolean {
    return this.collapsed.size > 0;
  }
  refresh(ids?: Iterable<string>): void {
    if (!ids) this.collapsed.clear();
    for (const id of ids ?? this.entities.getAllNodes().map((node) => node.entity.id)) {
      if (this.getNode(id)?.layoutState?.collapsed) this.collapsed.add(id);
      else this.collapsed.delete(id);
    }
    this.visible.clear();
    this.revision++;
  }
  private readonly getNode = (id: string): Readonly<NodeEntity> | undefined => this.entities.getNode(id)?.entity;
  isNodeVisible(id: string): boolean {
    if (!this.hasCollapsed) return !!this.getNode(id);
    const cached = this.visible.get(id);
    if (cached !== undefined) return cached;
    const path: string[] = [];
    let node = this.getNode(id);
    let result = !!node;
    while (node) {
      const known = this.visible.get(node.id);
      if (known !== undefined) {
        result = known;
        break;
      }
      path.push(node.id);
      const parent = node.parentId === undefined ? undefined : this.getNode(node.parentId);
      if (node.layoutItem && parent && hidesLayoutChildren(parent, this.getNode, this.layouts)) {
        result = false;
        break;
      }
      node = parent;
    }
    for (const key of path) this.visible.set(key, result);
    return result;
  }
  isConnectorVisible(connector: Readonly<ConnectorEntity>): boolean {
    return [connector.from, connector.to].every((end) => !end.nodeId || this.isNodeVisible(end.nodeId));
  }
}
