/**
 * @file engine.ts
 * @description SkyNote 平台中立核心引擎门面 (SkyNoteEngine)
 *
 * 设计考量 (Why):
 * 1. 组装而非实现：文档 (DocumentStore)、会话 (SessionStore)、注册表、空间索引、输入与插件各自独立，引擎只负责接线。
 * 2. 派生状态统一维护：消费 DocumentChangeSet 增量维护空间索引与连线路由，并剔除选区中已删除的实体；
 *    每次提交只触达变更实体，与画布总规模无关。
 * 3. 平台中立：0 DOM / 0 Canvas 依赖，可运行于浏览器、Web Worker 或 Node.js；宿主能力由渲染器挂载时提供。
 * 4. 拾取归内核 (ADR-116)：节点与连线拾取都在这里，渲染器、插件与导出共享同一套判定。
 */

import type { Point, RectBounds } from './types/geometry';
import type { CanvasDocument, ViewportState } from './types/canvas';
import type { NodeEntity } from './types/node';
import type { ConnectorEndpointSnap, ConnectorEntity } from './types/connector';
import type { CanvasThemeConfig } from './types/theme';
import type { ComputedRoute } from './types/runtime';
import type { DocumentChangeSet } from './types/change-set';
import type { FontMeasurer } from './protocols/font-measurer.protocol';
import type { SkyNotePlugin } from './protocols/plugin.protocol';
import { DETACHED_CANVAS_HOST, type CanvasHost } from './protocols/host.protocol';
import {
  applyMatrix,
  computeNodeWorldBounds,
  distanceToPolyline,
  expandBounds,
  invertMatrix,
  isPointInBounds,
  isPointInPolygon
} from './utils/geometry';
import { compareHierarchicalNodes } from './layout/layer-order';
import { resolveConnectorLayerPlacement } from './layout/connector-layer';
import { compareFractionalIndex } from './utils/fractional-index';
import { resolveNodeStyle } from './protocols/node-type.protocol';
import { isEqual } from './utils/equality';
import {
  computeConnectorRoute,
  resolveConnectorStyle,
  type ConnectorRouteSource,
  type ResolvedEndpointNode
} from './routing/connector-route';
import { outlineAnchors, projectOntoOutline, resolveNodeOutline } from './routing/outline';
import { DocumentStore } from './state/document-store';
import type { EntityReader } from './state/entity-store';
import { SessionStore, type ZoomRange } from './state/session-store';
import { NodeTypeRegistry } from './registry/node-type-registry';
import { ArrowMarkerRegistry } from './registry/arrow-marker-registry';
import { ConnectorRouterRegistry } from './registry/connector-router-registry';
import {
  RTreeSpatialIndex,
  SceneSpatialIndex,
  type NodeSpatialQuery,
  type SpatialIndex,
  type SpatialIndexEntry
} from './spatial';
import { InputScopeManager } from './input/input-scope-manager';
import { PointerDispatcher } from './input/pointer-dispatcher';
import { ClipboardDispatcher } from './input/clipboard-dispatcher';
import { PluginManager } from './plugin/plugin-manager';

export interface SkyNoteEngineOptions {
  /** 初始画布文档 (默认创建空文档) */
  initialDoc?: CanvasDocument;
  /** 初始视口 (宿主可自行持久化上次浏览位置并在此恢复) */
  initialViewport?: Partial<ViewportState>;
  /** 视口缩放范围 (默认 DEFAULT_ZOOM_RANGE) */
  zoomRange?: ZoomRange;
  /** 画布主题 (默认浅色预设)，运行时通过 engine.session.setTheme() 切换 */
  theme?: CanvasThemeConfig;
  /** 字体测量器 (由渲染适配层提供)，缺省时不做文本驱动的自动尺寸 */
  fonts?: FontMeasurer;
  /** 节点空间索引工厂 (默认 R-Tree)：分层索引为每个容器各建一个实例 (ADR-114)；测试借此观测索引调用 */
  createNodeSpatialIndex?: () => SpatialIndex;
}

/** 插件可用的连线派生能力：空间检索、路由、预览路由、端点吸附与吸附点 (只读，不改文档) */
export type ConnectorGeometryApi = Pick<
  SkyNoteEngine,
  | 'connectorSpatialIndex'
  | 'getConnectorRoute'
  | 'previewConnectorRoute'
  | 'snapConnectorEndpoint'
  | 'getConnectorAnchors'
>;

/** 按画面层叠点中的最上层实体 */
export type CanvasHit =
  | { readonly kind: 'node'; readonly node: Readonly<NodeEntity> }
  | { readonly kind: 'connector'; readonly connector: Readonly<ConnectorEntity> };

/** 连线拾取的默认屏幕像素容差 */
const CONNECTOR_HIT_TOLERANCE_PX = 6;
/** 粗筛时按此线宽放宽 (世界坐标)：比它更粗的线在线条中段仍能命中，只是边缘外侧的容差略少 */
const MAX_HIT_STROKE = 16;
/** 连线端点吸附到吸附点或边框的屏幕像素距离 */
const CONNECTOR_SNAP_PX = 8;

export class SkyNoteEngine {
  readonly nodeTypes = new NodeTypeRegistry();
  readonly arrowMarkers = new ArrowMarkerRegistry();
  readonly routers = new ConnectorRouterRegistry();
  readonly documentStore: DocumentStore;
  /** 本地会话状态：视口、选区与主题 */
  readonly session: SessionStore;
  readonly connectorSpatialIndex = new RTreeSpatialIndex();
  readonly inputScopes = new InputScopeManager();
  readonly pointer = new PointerDispatcher();
  readonly clipboard = new ClipboardDispatcher();
  readonly plugins: PluginManager;

  private readonly nodeSpatialIndex: SceneSpatialIndex;
  private currentHost: CanvasHost = DETACHED_CANVAS_HOST;
  private readonly unsubscribeDocument: () => void;
  private readonly unsubscribeRouters: () => void;
  /** 连线路由缓存：连线自身或两端节点几何变化时整体替换 */
  private readonly routes = new Map<string, ComputedRoute>();
  private isDestroyed = false;

  constructor(options?: SkyNoteEngineOptions) {
    this.documentStore = new DocumentStore(options?.initialDoc, {
      nodeTypes: this.nodeTypes,
      fonts: options?.fonts,
      connectorEnds: (id) => {
        const points = this.routes.get(id)?.points;
        return points && [points[0], points[points.length - 1]];
      }
    });
    this.session = new SessionStore({
      viewport: options?.initialViewport,
      theme: options?.theme,
      zoomRange: options?.zoomRange
    });
    this.nodeSpatialIndex = new SceneSpatialIndex(
      this.entityStore,
      options?.createNodeSpatialIndex ?? (() => new RTreeSpatialIndex()),
      (node) => this.nodeTypes.get(node.nodeType)?.extent?.(node as NodeEntity)
    );
    this.plugins = new PluginManager(this);

    this.nodeSpatialIndex.rebuild();
    this.updateConnectorRoutes(this.entityStore.getAllConnectors().map((runtime) => runtime.entity.id));

    // 空间索引、路由与选区都是文档的派生状态：实体删除 (本地、远端或撤销) 后选区不会残留失效 id
    this.unsubscribeDocument = this.documentStore.subscribe((_view, _record, changes) => {
      this.syncDerivedState(changes);
      this.session.pruneSelection(changes.nodes.removed, changes.connectors.removed);
    });
    // 路由器晚于文档注册时，重算对应类型的连线
    this.unsubscribeRouters = this.routers.onChange((routerId) => {
      this.updateConnectorRoutes(
        this.entityStore
          .getAllConnectors()
          .filter((runtime) => runtime.entity.connectorType === routerId)
          .map((runtime) => runtime.entity.id)
      );
    });
  }

  /** 实体运行时索引 (只读) */
  get entityStore(): EntityReader {
    return this.documentStore.entityStore;
  }

  /** 节点空间检索 (世界坐标，分层索引由引擎按变更集维护) */
  get spatialIndex(): NodeSpatialQuery {
    return this.nodeSpatialIndex;
  }

  /** 当前挂载的宿主能力 (渲染器挂载前为空实现) */
  get host(): CanvasHost {
    return this.currentHost;
  }

  use(plugin: SkyNotePlugin): this {
    this.plugins.use(plugin);
    return this;
  }

  /**
   * 挂载宿主 (由渲染器在 mount 时调用)，返回卸载函数
   * 插件经上下文调用宿主能力时读取当前宿主，因此插件可以早于渲染器安装
   */
  attachHost(host: CanvasHost): () => void {
    this.currentHost = host;
    return () => {
      if (this.currentHost === host) this.currentHost = DETACHED_CANVAS_HOST;
    };
  }

  /**
   * 点选最上层节点：空间索引粗筛后按世界矩阵精判 (含自身与祖先旋转)，节点类型声明了轮廓时按轮廓判断；
   * 落在裁剪型祖先 (画框) 之外的部分不可拾取；候选返回顺序与层叠无关，必须显式比较层级
   * @param accept 只在满足条件的节点中拾取 (如拖放时只找可接收子节点且不是被拖节点的容器)
   */
  hitTestNode(point: Point, accept?: (node: Readonly<NodeEntity>) => boolean): Readonly<NodeEntity> | undefined {
    const { entityStore, nodeTypes } = this;
    const chainCache = new Map<string, Readonly<NodeEntity>[]>();
    const getNode = (id: string) => entityStore.getNode(id)?.entity;
    const containsPoint = (node: Readonly<NodeEntity>): boolean => {
      const local = applyMatrix(invertMatrix(entityStore.getWorldTransform(node.id)!), point.x, point.y);
      const definition = nodeTypes.get(node.nodeType);
      const inShape = definition?.outline
        ? isPointInPolygon(local, definition.outline(node as NodeEntity))
        : local.x >= 0 && local.x <= node.width && local.y >= 0 && local.y <= node.height;
      if (inShape) return true;
      if (definition?.extent) {
        const ext = definition.extent(node as NodeEntity);
        return local.x >= ext.left && local.x <= ext.right && local.y >= ext.top && local.y <= ext.bottom;
      }
      return false;
    };
    // 裁剪按容器外框判定 (框外标题不裁剪子节点)
    const isClippedOut = (node: Readonly<NodeEntity>) =>
      entityStore.getAncestorIds(node.id).some((id) => {
        const ancestor = getNode(id)!;
        if (!nodeTypes.get(ancestor.nodeType)?.clipChildren) return false;
        const local = applyMatrix(invertMatrix(entityStore.getWorldTransform(id)!), point.x, point.y);
        return local.x < 0 || local.y < 0 || local.x > ancestor.width || local.y > ancestor.height;
      });

    let top: Readonly<NodeEntity> | undefined;
    const candidateIds = this.nodeSpatialIndex.hitTest(point);
    for (let i = 0; i < candidateIds.length; i++) {
      const node = getNode(candidateIds[i]);
      if (!node || node.style?.opacity === 0 || (accept && !accept(node)) || !containsPoint(node)) continue;
      if (top && compareHierarchicalNodes(node, top, getNode, chainCache) < 0) continue;
      if (isClippedOut(node)) continue;
      top = node;
    }
    return top;
  }

  /**
   * 连线拾取：点在连线文字上，或到路由折线的距离不超过 tolerancePx 屏幕像素即命中
   * 经连线空间索引粗筛后按路由精判，离屏或尚未绘制的连线同样可拾取
   */
  hitTestConnector(point: Point, tolerancePx = CONNECTOR_HIT_TOLERANCE_PX): Readonly<ConnectorEntity> | undefined {
    const tolerance = tolerancePx / this.session.viewport.zoom;
    // 粗线按画出来的宽度命中：容差再加半个线宽 (粗筛按可能的最粗线宽放宽)
    const candidateIds = this.connectorSpatialIndex.search(
      expandBounds({ left: point.x, top: point.y, right: point.x, bottom: point.y }, tolerance + MAX_HIT_STROKE / 2)
    );
    // 连线索引只收录有路由的连线
    for (let i = candidateIds.length - 1; i >= 0; i--) {
      const connector = this.entityStore.getConnector(candidateIds[i])!.entity;
      const route = this.routes.get(connector.id)!;
      if (route.labels.some(({ bounds }) => isPointInBounds(point, bounds))) return connector;
      const width = resolveConnectorStyle(connector, this.routers).strokeWidth ?? 2;
      if (width === 0) continue;
      if (distanceToPolyline(point, route.points) <= tolerance + width / 2) return connector;
    }
    return undefined;
  }

  /**
   * 点中的最上层实体：节点与连线都命中时按画面层叠决定 (与渲染同一条层叠规则，见 resolveConnectorLayerPlacement)，
   * 盖在连线上面的无关节点优先，连线所连的节点与其内部永远在连线下方
   */
  hitTest(point: Point): CanvasHit | null {
    const connector = this.hitTestConnector(point);
    const node = this.hitTestNode(point);
    if (!connector) return node ? { kind: 'node', node } : null;
    if (node && this.isNodeAboveConnector(node, connector)) return { kind: 'node', node };
    return { kind: 'connector', connector };
  }

  /** 节点是否画在连线之上 */
  private isNodeAboveConnector(node: Readonly<NodeEntity>, connector: Readonly<ConnectorEntity>): boolean {
    const getNode = (id: string) => this.entityStore.getNode(id)?.entity as NodeEntity | undefined;
    const { anchorNode } = resolveConnectorLayerPlacement(connector, getNode);
    if (!anchorNode) {
      // 两端都是自由端：连线以自身索引与根层级节点排序
      const root = this.entityStore.getAncestorIds(node.id).at(-1);
      const top = root === undefined ? node : getNode(root)!;
      return compareFractionalIndex(top.zIndex, top.id, connector.zIndex, connector.id) > 0;
    }
    // 连线紧贴锚点上方：锚点本身及其内部都在连线下方
    if (node.id === anchorNode.id || this.entityStore.getAncestorIds(node.id).includes(anchorNode.id)) return false;
    return compareHierarchicalNodes(node, anchorNode, getNode) > 0;
  }

  /** 节点在世界坐标系中的轴对齐包围盒 (含自身与祖先旋转)；节点不存在时返回 undefined */
  getNodeWorldBounds(nodeId: string): RectBounds | undefined {
    const runtimeNode = this.entityStore.getNode(nodeId);
    return runtimeNode && computeNodeWorldBounds(runtimeNode.entity, this.entityStore.getWorldTransform(nodeId)!);
  }

  /**
   * 节点在世界坐标系中的实际占据范围包围盒 (含 extent 框外扩展、自身与祖先旋转)；
   * 常用于选区外框计算、工具栏定位与外部排他判定。节点不存在时返回 undefined
   */
  getNodeOccupiedBounds(nodeId: string): RectBounds | undefined {
    return this.nodeSpatialIndex.getBounds(nodeId);
  }

  /** 连线的当前路由；悬空连线 (两端无法定位) 返回 undefined */
  getConnectorRoute(connectorId: string): ComputedRoute | undefined {
    return this.routes.get(connectorId);
  }

  /** 尚未提交的连线 (如拖拽中的预览) 的路由，与已保存连线走同一套求解 */
  previewConnectorRoute(connector: Readonly<ConnectorRouteSource>): ComputedRoute | null {
    return computeConnectorRoute(connector, this.resolveEndpointNode, this.routers, this.documentStore.fonts);
  }

  /** 节点的连线吸附点 (世界坐标)：轮廓上、右、下、左四点，供连线工具提示 */
  getConnectorAnchors(nodeId: string): Point[] {
    const resolved = this.resolveEndpointNode(nodeId);
    if (!resolved) return [];
    return outlineAnchors(resolved.outline).map(({ point }) => applyMatrix(resolved.worldMatrix, point.x, point.y));
  }

  /**
   * 指针处的连线端点：靠近吸附点 → 固定在吸附点；靠近边框 → 固定在边框上最近的一点；
   * 落在节点内部 → 浮动绑定整个节点；都不是 → 自由端
   * @param accept 只吸附满足条件的节点 (如不连到自身所在的连线之外的东西)
   */
  snapConnectorEndpoint(point: Point, accept?: (node: Readonly<NodeEntity>) => boolean): ConnectorEndpointSnap {
    const tolerance = CONNECTOR_SNAP_PX / this.session.viewport.zoom;
    const candidates = this.nodeSpatialIndex
      .search(expandBounds({ left: point.x, top: point.y, right: point.x, bottom: point.y }, tolerance))
      .map((id) => this.resolveEndpointNode(id)!)
      .filter(({ node }) => node.style?.opacity !== 0 && (!accept || accept(node)));

    const fixedAt = (resolved: ResolvedEndpointNode, local: Point, kind: 'anchor' | 'outline') => {
      const { node, worldMatrix } = resolved;
      return {
        endpoint: {
          nodeId: node.id,
          anchor: { x: node.width ? local.x / node.width : 0, y: node.height ? local.y / node.height : 0 }
        },
        point: applyMatrix(worldMatrix, local.x, local.y),
        kind
      };
    };
    let best: ConnectorEndpointSnap | null = null;
    let bestDistance = tolerance;
    for (const resolved of candidates) {
      for (const { point: local } of outlineAnchors(resolved.outline)) {
        const world = applyMatrix(resolved.worldMatrix, local.x, local.y);
        const distance = Math.hypot(world.x - point.x, world.y - point.y);
        if (distance <= bestDistance) {
          bestDistance = distance;
          best = fixedAt(resolved, local, 'anchor');
        }
      }
    }
    if (best) return best;
    for (const resolved of candidates) {
      const local = applyMatrix(invertMatrix(resolved.worldMatrix), point.x, point.y);
      const projected = projectOntoOutline(resolved.outline, local).point;
      const world = applyMatrix(resolved.worldMatrix, projected.x, projected.y);
      const distance = Math.hypot(world.x - point.x, world.y - point.y);
      if (distance <= bestDistance) {
        bestDistance = distance;
        best = fixedAt(resolved, projected, 'outline');
      }
    }
    if (best) return best;
    const node = this.hitTestNode(point, accept);
    if (node) {
      const m = this.entityStore.getWorldTransform(node.id)!;
      return { endpoint: { nodeId: node.id }, point: applyMatrix(m, node.width / 2, node.height / 2), kind: 'node' };
    }
    return { endpoint: { position: { x: point.x, y: point.y } }, point: { x: point.x, y: point.y }, kind: 'free' };
  }

  /** 销毁引擎并释放全部插件资源 */
  destroy(): void {
    if (this.isDestroyed) return;
    this.isDestroyed = true;
    this.unsubscribeDocument();
    this.unsubscribeRouters();
    this.plugins.destroy();
    this.routes.clear();
    this.pointer.clear();
    this.nodeSpatialIndex.clear();
    this.connectorSpatialIndex.clear();
    this.inputScopes.clear();
    this.clipboard.clear();
    this.nodeTypes.clear();
    this.arrowMarkers.clear();
    this.routers.clear();
    this.documentStore.clearHistory();
  }

  /** 按变更集增量维护空间索引与连线路由，只触达本次提交涉及的实体 */
  private syncDerivedState(changes: DocumentChangeSet): void {
    const { nodes, connectors } = changes;
    // 分层索引：容器移动只更新容器自身的条目，后代无需任何处理
    this.nodeSpatialIndex.applyChanges(nodes);
    for (const id of connectors.removed) {
      this.connectorSpatialIndex.remove(id);
      this.routes.delete(id);
    }
    // 依附节点移动引发的路由失效已由 DocumentStore 并入 connectors.geometry
    const affected = new Set(connectors.geometry);
    // 节点样式变化 (如描边粗细) 影响线端位置：重算连在它上面的连线
    for (const id of nodes.data) {
      for (const connectorId of this.entityStore.getConnectorIdsOfNode(id)) affected.add(connectorId);
    }
    this.updateConnectorRoutes(affected);
  }

  /** 连线端点所需的节点信息：世界矩阵与轮廓 */
  private readonly resolveEndpointNode = (nodeId: string): ResolvedEndpointNode | undefined => {
    const runtimeNode = this.entityStore.getNode(nodeId);
    if (!runtimeNode) return undefined;
    const node = runtimeNode.entity;
    const definition = this.nodeTypes.get(node.nodeType);
    return {
      node,
      worldMatrix: this.entityStore.getWorldTransform(nodeId)!,
      outline: resolveNodeOutline(node, definition),
      strokeWidth: resolveNodeStyle(node, definition).strokeWidth ?? 0
    };
  };

  private updateConnectorRoutes(connectorIds: Iterable<string>): void {
    const entries: SpatialIndexEntry[] = [];
    for (const id of connectorIds) {
      const runtimeConnector = this.entityStore.getConnector(id);
      const route =
        runtimeConnector &&
        computeConnectorRoute(
          runtimeConnector.entity,
          this.resolveEndpointNode,
          this.routers,
          this.documentStore.fonts
        );
      // 重算结果与原来一致 (如只改了节点填充色)：沿用原对象，下游按引用判定不必重画
      const previous = this.routes.get(id);
      if (route && previous && isSameRoute(previous, route)) continue;
      if (route) {
        this.routes.set(id, route);
        entries.push([id, route.bounds]);
      } else {
        // 悬空连线不参与渲染与空间检索
        this.routes.delete(id);
        this.connectorSpatialIndex.remove(id);
      }
    }
    this.connectorSpatialIndex.load(entries);
  }
}

/** 两次求解的路由在几何与文字排版上完全一致 */
function isSameRoute(a: ComputedRoute, b: ComputedRoute): boolean {
  if (a.pathData !== b.pathData || a.points.length !== b.points.length || a.labels.length !== b.labels.length) {
    return false;
  }
  if (a.points.some((p, i) => p.x !== b.points[i].x || p.y !== b.points[i].y)) return false;
  return a.labels.every((label, i) => {
    const other = b.labels[i];
    const [p, q] = [label.primitive, other.primitive];
    return (
      label.blockId === other.blockId &&
      p.runs === q.runs &&
      isEqual(p.style, q.style) &&
      label.bounds.left === other.bounds.left &&
      label.bounds.top === other.bounds.top &&
      label.bounds.right === other.bounds.right &&
      label.bounds.bottom === other.bounds.bottom
    );
  });
}
