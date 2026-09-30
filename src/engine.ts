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
import type { ConnectorEntity } from './types/connector';
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
  isPointInPolygon
} from './utils/geometry';
import { compareHierarchicalNodes } from './layout/layer-order';
import { computeConnectorRoute } from './routing/connector-route';
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

/** 连线拾取的默认屏幕像素容差 */
const CONNECTOR_HIT_TOLERANCE_PX = 6;

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
      fonts: options?.fonts
    });
    this.session = new SessionStore({
      viewport: options?.initialViewport,
      theme: options?.theme,
      zoomRange: options?.zoomRange
    });
    this.nodeSpatialIndex = new SceneSpatialIndex(
      this.entityStore,
      options?.createNodeSpatialIndex ?? (() => new RTreeSpatialIndex())
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
   */
  hitTestNode(point: Point): Readonly<NodeEntity> | undefined {
    const { entityStore, nodeTypes } = this;
    const chainCache = new Map<string, Readonly<NodeEntity>[]>();
    const getNode = (id: string) => entityStore.getNode(id)?.entity;
    const containsPoint = (node: Readonly<NodeEntity>): boolean => {
      const local = applyMatrix(invertMatrix(entityStore.getWorldTransform(node.id)!), point.x, point.y);
      const definition = nodeTypes.get(node.nodeType);
      return definition?.outline
        ? isPointInPolygon(local, definition.outline(node as NodeEntity))
        : local.x >= 0 && local.x <= node.width && local.y >= 0 && local.y <= node.height;
    };
    const isClippedOut = (node: Readonly<NodeEntity>) =>
      entityStore.getAncestorIds(node.id).some((id) => {
        const ancestor = getNode(id)!;
        return nodeTypes.get(ancestor.nodeType)?.clipChildren && !containsPoint(ancestor);
      });

    let top: Readonly<NodeEntity> | undefined;
    const candidateIds = this.nodeSpatialIndex.hitTest(point);
    for (let i = 0; i < candidateIds.length; i++) {
      const node = getNode(candidateIds[i]);
      if (!node || node.style?.opacity === 0 || !containsPoint(node)) continue;
      if (top && compareHierarchicalNodes(node, top, getNode, chainCache) < 0) continue;
      if (isClippedOut(node)) continue;
      top = node;
    }
    return top;
  }

  /**
   * 连线拾取：点到路由折线的距离不超过 tolerancePx 屏幕像素即命中
   * 经连线空间索引粗筛后按路由精判，离屏或尚未绘制的连线同样可拾取
   */
  hitTestConnector(point: Point, tolerancePx = CONNECTOR_HIT_TOLERANCE_PX): Readonly<ConnectorEntity> | undefined {
    const tolerance = tolerancePx / this.session.viewport.zoom;
    const candidateIds = this.connectorSpatialIndex.search(
      expandBounds({ left: point.x, top: point.y, right: point.x, bottom: point.y }, tolerance)
    );
    // 连线索引只收录有路由的连线
    for (let i = candidateIds.length - 1; i >= 0; i--) {
      const connector = this.entityStore.getConnector(candidateIds[i])!.entity;
      if (connector.style?.strokeWidth === 0) continue;
      if (distanceToPolyline(point, this.routes.get(connector.id)!.points) <= tolerance) return connector;
    }
    return undefined;
  }

  /** 节点在世界坐标系中的轴对齐包围盒 (含自身与祖先旋转)；节点不存在时返回 undefined */
  getNodeWorldBounds(nodeId: string): RectBounds | undefined {
    const runtimeNode = this.entityStore.getNode(nodeId);
    return runtimeNode && computeNodeWorldBounds(runtimeNode.entity, this.entityStore.getWorldTransform(nodeId)!);
  }

  /** 连线的当前路由；悬空连线 (两端无法定位) 返回 undefined */
  getConnectorRoute(connectorId: string): ComputedRoute | undefined {
    return this.routes.get(connectorId);
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
    this.nodeTypes.clear();
    this.arrowMarkers.clear();
    this.routers.clear();
    this.documentStore.clearHistory();
  }

  /** 按变更集增量维护空间索引与连线路由，只触达本次提交涉及的实体 */
  private syncDerivedState(changes: DocumentChangeSet): void {
    // 分层索引：容器移动只更新容器自身的条目，后代无需任何处理
    this.nodeSpatialIndex.applyChanges(changes.nodes);
    for (const id of changes.connectors.removed) {
      this.connectorSpatialIndex.remove(id);
      this.routes.delete(id);
    }
    // 依附节点移动引发的路由失效已由 DocumentStore 并入 connectors.geometry
    this.updateConnectorRoutes(changes.connectors.geometry);
  }

  private updateConnectorRoutes(connectorIds: Iterable<string>): void {
    const resolveNode = (nodeId: string) => {
      const runtimeNode = this.entityStore.getNode(nodeId);
      return runtimeNode && { node: runtimeNode.entity, worldMatrix: this.entityStore.getWorldTransform(nodeId)! };
    };
    const entries: SpatialIndexEntry[] = [];
    for (const id of connectorIds) {
      const runtimeConnector = this.entityStore.getConnector(id);
      const route = runtimeConnector && computeConnectorRoute(runtimeConnector.entity, resolveNode, this.routers);
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
